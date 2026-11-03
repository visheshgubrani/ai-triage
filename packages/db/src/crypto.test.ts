import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, KeyRingError, keyRingFromEnv, parseKeyRing } from "./crypto";

const key = () => randomBytes(32).toString("base64");

describe("secret encryption", () => {
  const ring = parseKeyRing(`a:${key()}`);

  it("round-trips, with a fresh IV each time", () => {
    const one = encryptSecret(ring, "whsec_abc", "tenant-1");
    const two = encryptSecret(ring, "whsec_abc", "tenant-1");
    expect(one).not.toBe(two);
    expect(one).toMatch(/^v1:a:/);
    expect(decryptSecret(ring, one, "tenant-1")).toBe("whsec_abc");
  });

  it("fails for another tenant (the AAD) or a tampered ciphertext", () => {
    const sealed = encryptSecret(ring, "whsec_abc", "tenant-1");
    expect(() => decryptSecret(ring, sealed, "tenant-2")).toThrow();
    const parts = sealed.split(":");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    expect(() =>
      decryptSecret(ring, [...parts.slice(0, 3), body.toString("base64url")].join(":"), "tenant-1"),
    ).toThrow();
  });

  it("decrypts with an older key after rotation and encrypts with the new primary", () => {
    const oldKey = key();
    const before = encryptSecret(parseKeyRing(`old:${oldKey}`), "whsec_abc", "t");
    const rotated = parseKeyRing(`new:${key()},old:${oldKey}`);
    expect(decryptSecret(rotated, before, "t")).toBe("whsec_abc");
    expect(encryptSecret(rotated, "whsec_abc", "t")).toMatch(/^v1:new:/);
    expect(() => decryptSecret(parseKeyRing(`new:${key()}`), before, "t")).toThrow(KeyRingError);
  });

  it("refuses malformed rings", () => {
    expect(() => parseKeyRing("nokid")).toThrow(KeyRingError);
    expect(() => parseKeyRing(`a:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });

  it("falls back to the dev key only outside production or in the demo", () => {
    expect(keyRingFromEnv({}).primary).toBe("dev");
    expect(keyRingFromEnv({ NODE_ENV: "production", TRIAGE_DEMO: "true" }).primary).toBe("dev");
    expect(() => keyRingFromEnv({ NODE_ENV: "production" })).toThrow(/ENCRYPTION_KEYS/);
    expect(keyRingFromEnv({ ENCRYPTION_KEY: key() }).primary).toBe("k1");
  });
});
