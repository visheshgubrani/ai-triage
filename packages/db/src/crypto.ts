import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Secrets at rest (docs/security.md): webhook signing secrets are needed in plain form to sign, so
// they can't be hashed; they are encrypted with AES-256-GCM instead. Keys come from the deployment
// (ENCRYPTION_KEYS="kid:base64,kid:base64", the first one encrypts; or ENCRYPTION_KEY="base64" for
// a one-key ring), never from the database, so a database dump alone doesn't reveal the secrets.
// The tenant id is the additional authenticated data: a ciphertext copied to another tenant's row
// fails to decrypt.
//
// Format: `v1:<kid>:<iv, base64url>:<ciphertext + 16-byte tag, base64url>`.

export interface KeyRing {
  /** The key new ciphertexts use. */
  primary: string;
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Published, so only for development and the local demo: production refuses it (startup check).
 * `openssl rand -base64 32` makes a real one.
 */
export const DEV_ENCRYPTION_KEY = "ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM=";

export class KeyRingError extends Error {
  override name = "KeyRingError";
}

function parseKey(kid: string, base64: string): [string, Buffer] {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new KeyRingError(`invalid key id "${kid}"`);
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new KeyRingError(`key "${kid}" must be 32 bytes, base64-encoded`);
  return [kid, key];
}

export function parseKeyRing(spec: string): KeyRing {
  const entries = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(":");
      if (at < 0) throw new KeyRingError("ENCRYPTION_KEYS entries are kid:base64");
      return parseKey(entry.slice(0, at), entry.slice(at + 1));
    });
  const [first] = entries;
  if (!first) throw new KeyRingError("no encryption keys given");
  return { primary: first[0], keys: new Map(entries) };
}

/**
 * The deployment's key ring. Without ENCRYPTION_KEYS / ENCRYPTION_KEY, development and the demo use
 * the published dev key; production has none to fall back on.
 */
export function keyRingFromEnv(env: Record<string, string | undefined>): KeyRing {
  if (env.ENCRYPTION_KEYS) return parseKeyRing(env.ENCRYPTION_KEYS);
  if (env.ENCRYPTION_KEY) return parseKeyRing(`k1:${env.ENCRYPTION_KEY}`);
  if (env.NODE_ENV !== "production" || env.TRIAGE_DEMO === "true") return parseKeyRing(`dev:${DEV_ENCRYPTION_KEY}`);
  throw new KeyRingError(
    "ENCRYPTION_KEYS (or ENCRYPTION_KEY) is not set: see the production checklist in docs/security.md",
  );
}

export function encryptSecret(ring: KeyRing, plaintext: string, aad: string): string {
  const key = ring.keys.get(ring.primary);
  if (!key) throw new KeyRingError(`primary key "${ring.primary}" missing`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1:${ring.primary}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

export function decryptSecret(ring: KeyRing, ciphertext: string, aad: string): string {
  const [version, kid, ivPart, bodyPart] = ciphertext.split(":");
  if (version !== "v1" || !kid || !ivPart || !bodyPart) throw new KeyRingError("unrecognized ciphertext");
  const key = ring.keys.get(kid);
  if (!key) throw new KeyRingError(`ciphertext uses key "${kid}", which isn't in the ring`);
  const body = Buffer.from(bodyPart, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
}

/** The key id a ciphertext was made with (to find what a key rotation still has to rewrite). */
export const ciphertextKeyId = (ciphertext: string) => ciphertext.split(":")[1] ?? null;
