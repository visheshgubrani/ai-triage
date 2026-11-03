import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
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
  /** A URL the browser can PUT the object to. The Content-Type header is part of the signature. */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  presignGet(key: string, expiresInSeconds: number, filename?: string | null): Promise<string>;
  /** Lets `origins` PUT and GET objects from the browser (presigned uploads and downloads). */
  allowBrowserOrigins(origins: string[]): Promise<void>;
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
  });
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
    presignPut(key, contentType, expiresIn) {
      return getSignedUrl(signer, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn,
        signableHeaders: new Set(["content-type"]),
      });
    },
    presignGet(key, expiresIn, filename) {
      const disposition = filename ? `inline; filename="${filename.replace(/["\\\r\n]/g, "_")}"` : undefined;
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: disposition }), {
        expiresIn,
      });
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
