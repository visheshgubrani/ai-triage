import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Object storage (RustFS locally, any S3-compatible service in production). Keys are always built
// here by the server from the tenant id and a random uuid; a client never chooses one
// (docs/architecture.md §3).

export interface StorageConfig {
  /** Where the api and worker reach the store. */
  endpoint: string;
  /** Host used in presigned URLs, which the browser must reach (differs inside docker). */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (see .env.example)`);
    return value;
  };
  const endpoint = need("S3_ENDPOINT");
  return {
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || endpoint,
    region: env.S3_REGION || "us-east-1",
    bucket: need("S3_BUCKET"),
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
  };
}

export interface Storage {
  readonly bucket: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Size and content type of an object, or null if it doesn't exist. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /**
   * A URL the browser can PUT the object to. Content-Type and Content-Length are part of the
   * signature, so storage refuses any other type or size.
   */
  presignPut(key: string, contentType: string, size: number, expiresInSeconds: number): Promise<string>;
  /**
   * A short-lived download URL. `mime` is the type the server determined (sniffed, never the
   * sender's claim): see servedAs() for what the browser is allowed to render.
   */
  presignGet(
    key: string,
    expiresInSeconds: number,
    file: { mime: string | null; filename?: string | null },
  ): Promise<string>;
  /** Deletes objects; a key that doesn't exist is fine. */
  delete(keys: readonly string[]): Promise<void>;
  /** Deletes every object whose key starts with `prefix` (which must end with "/"). */
  deletePrefix(prefix: string): Promise<number>;
  /** Lets `origins` PUT and GET objects from the browser (presigned uploads and downloads). */
  allowBrowserOrigins(origins: string[]): Promise<void>;
  /** For preflight: whether the bucket exists and which browser origins its CORS rules allow. */
  inspectBucket(): Promise<{ exists: boolean; corsOrigins: string[] }>;
}

function client(config: StorageConfig, endpoint: string) {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Default CRC checksums would leak into presigned URLs and aren't supported everywhere.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // A stalled store fails a request instead of hanging the job or the upload; pg-boss retries.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
    maxAttempts: 3,
  });
}

/**
 * Types the browser may render from storage: none of them can run script. Everything else,
 * whatever the sender claimed (an HTML or SVG "attachment"), is served as a download, so a file
 * can't become script on the storage origin (docs/security.md, served files).
 */
export const INLINE_SAFE_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function servedAs(mime: string | null): { contentType: string; inline: boolean } {
  return mime && INLINE_SAFE_MIMES.has(mime)
    ? { contentType: mime, inline: true }
    : { contentType: "application/octet-stream", inline: false };
}

export function createStorage(config: StorageConfig): Storage {
  const s3 = client(config, config.endpoint);
  const signer = config.publicEndpoint === config.endpoint ? s3 : client(config, config.publicEndpoint);
  const Bucket = config.bucket;
  return {
    bucket: Bucket,
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!res.Body) throw new Error(`object ${key} has no body`);
      return res.Body.transformToByteArray();
    },
    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
      } catch (err) {
        if (
          err instanceof NotFound ||
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    presignPut(key, contentType, size, expiresIn) {
      const command = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: size });
      return getSignedUrl(signer, command, {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      });
    },
    presignGet(key, expiresIn, file) {
      const { contentType, inline } = servedAs(file.mime);
      const name = file.filename ? `; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"` : "";
      const command = new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: `${inline ? "inline" : "attachment"}${name}`,
      });
      return getSignedUrl(signer, command, { expiresIn });
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 20) {
        await Promise.all(keys.slice(i, i + 20).map((Key) => s3.send(new DeleteObjectCommand({ Bucket, Key }))));
      }
    },
    async deletePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error(`refusing to delete by a prefix without a trailing slash: ${prefix}`);
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
        await this.delete(keys);
        deleted += keys.length;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },
    async allowBrowserOrigins(origins) {
      await s3.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                AllowedMethods: ["PUT", "GET"],
                AllowedHeaders: ["content-type"],
                MaxAgeSeconds: 600,
              },
            ],
          },
        }),
      );
    },
    async inspectBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch (err) {
        if (err instanceof NotFound || (err as { name?: string }).name === "NoSuchBucket") {
          return { exists: false, corsOrigins: [] };
        }
        throw err;
      }
      try {
        const cors = await s3.send(new GetBucketCorsCommand({ Bucket }));
        return { exists: true, corsOrigins: (cors.CORSRules ?? []).flatMap((r) => r.AllowedOrigins ?? []) };
      } catch {
        // NoSuchCORSConfiguration: no browser origin is allowed yet (the api sets it at startup).
        return { exists: true, corsOrigins: [] };
      }
    },
  };
}

/** Server-issued storage keys. Every key starts with `t/{tenantId}/`. */
export const storageKeys = {
  upload: (tenantId: string) => `t/${tenantId}/u/${randomUUID()}`,
  file: (tenantId: string) => `t/${tenantId}/a/${randomUUID()}`,
  email(tenantId: string) {
    const base = `t/${tenantId}/e/${randomUUID()}`;
    return {
      /** The normalized email (StoredEmail): the document's source object. */
      email: `${base}/email.json`,
      /** The Postmark payload as received (attachment content replaced by keys): the source of record. */
      postmark: `${base}/postmark.json`,
      /** The original .eml, when the email arrived as one. */
      eml: `${base}/source.eml`,
      attachment: (index: number) => `${base}/att/${index}`,
    };
  },
  /**
   * An eval item's immutable source snapshot, laid out like a document's source: a file, or a
   * normalized email with one object per attachment. Never shared with a document, so deleting
   * (later, retention) a document can't break an eval item.
   */
  evalSource(tenantId: string) {
    const base = `t/${tenantId}/x/${randomUUID()}`;
    return {
      file: `${base}/source`,
      email: `${base}/email.json`,
      attachment: (index: number) => `${base}/att/${index}`,
    };
  },
};
