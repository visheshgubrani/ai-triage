import { randomBytes } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import type pg from "pg";
import { decryptSecret, encryptSecret, type KeyRing } from "./crypto";
import { tenantSettings } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { withTenantTx } from "./tenant-tx";

// Webhook target per tenant (docs/architecture.md §3: webhook targets come only from tenant settings).
// The secret signs deliveries (HMAC), so it can't be hashed: it is encrypted at rest (crypto.ts) and
// shown to the admin only when it is created or rotated. A rotation keeps the previous secret valid
// for a grace period, so receivers can switch over without dropping deliveries.

export const WEBHOOK_ROTATION_GRACE_HOURS = 24;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

async function settingsRow(tx: TenantTx) {
  const [row] = await tx.db
    .select({
      url: tenantSettings.webhookUrl,
      enc: tenantSettings.webhookSecretEnc,
      prevEnc: tenantSettings.webhookSecretPrevEnc,
      prevUntil: tenantSettings.webhookSecretPrevUntil,
    })
    .from(tenantSettings);
  return row;
}

export async function getWebhookSettings(tx: TenantTx, keys: KeyRing, now = new Date()) {
  const row = await settingsRow(tx);
  const secret = row?.enc ? decryptSecret(keys, row.enc, tx.tenantId) : null;
  const graceUntil = row?.prevEnc && row.prevUntil && row.prevUntil > now ? row.prevUntil : null;
  return {
    url: row?.url ?? null,
    secretSet: secret !== null,
    /** Enough of the secret to recognise it, never enough to use it. */
    secretHint: secret ? `${secret.slice(0, 10)}…` : null,
    /** Until when deliveries are also signed with the secret before the last rotation. */
    previousSecretValidUntil: graceUntil?.toISOString() ?? null,
  };
}

/**
 * Sets the webhook URL, plus a secret if there is none yet (or `secret` is given, as the demo seed
 * does). Returns the secret only when it was created here.
 */
export async function setWebhook(
  tx: TenantTx,
  keys: KeyRing,
  input: { url: string | null; secret?: string },
): Promise<{ secret: string | null }> {
  const row = await settingsRow(tx);
  const secret = input.secret ?? (row?.enc ? null : generateWebhookSecret());
  const enc = secret ? { webhookSecretEnc: encryptSecret(keys, secret, tx.tenantId) } : {};
  await tx.db
    .insert(tenantSettings)
    .values({ tenantId: tx.tenantId, webhookUrl: input.url, ...enc })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { webhookUrl: input.url, ...enc } });
  return { secret: input.secret ? null : secret };
}

/**
 * Replaces the secret. Deliveries are signed with both the new and the old one until the grace
 * period ends, then with the new one only.
 */
export async function rotateWebhookSecret(tx: TenantTx, keys: KeyRing, now = new Date()): Promise<string> {
  const row = await settingsRow(tx);
  const secret = generateWebhookSecret();
  await tx.db
    .update(tenantSettings)
    .set({
      webhookSecretEnc: encryptSecret(keys, secret, tx.tenantId),
      webhookSecretPrevEnc: row?.enc ?? null,
      webhookSecretPrevUntil: row?.enc ? new Date(now.getTime() + WEBHOOK_ROTATION_GRACE_HOURS * 3_600_000) : null,
    })
    .where(eq(tenantSettings.tenantId, tx.tenantId));
  return secret;
}

/** Where to deliver and every secret to sign with right now (newest first). */
export async function webhookTarget(tx: TenantTx, keys: KeyRing, now: Date) {
  const row = await settingsRow(tx);
  const secrets: string[] = [];
  if (row?.enc) secrets.push(decryptSecret(keys, row.enc, tx.tenantId));
  if (row?.prevEnc && row.prevUntil && row.prevUntil > now) secrets.push(decryptSecret(keys, row.prevEnc, tx.tenantId));
  return { url: row?.url ?? null, secrets };
}

/**
 * Part of `db:migrate`: encrypts plaintext secrets left by older versions into webhook_secret_enc
 * and clears the plaintext column. Runs per tenant (FORCE RLS binds the owner too). Idempotent.
 */
export async function encryptLegacyWebhookSecrets(pool: pg.Pool, keys: KeyRing): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("select id from tenants");
  let moved = 0;
  for (const { id } of rows) {
    moved += await withTenantTx(pool, id, async (tx) => {
      const [row] = await tx.db
        .select({ secret: tenantSettings.webhookSecret })
        .from(tenantSettings)
        .where(isNotNull(tenantSettings.webhookSecret));
      if (!row?.secret) return 0;
      await tx.db
        .update(tenantSettings)
        .set({ webhookSecretEnc: encryptSecret(keys, row.secret, id), webhookSecret: null })
        .where(eq(tenantSettings.tenantId, id));
      return 1;
    });
  }
  return moved;
}

/** `pnpm secrets:rotate-key`: re-encrypts every secret under the ring's primary key. */
export async function reencryptWebhookSecrets(pool: pg.Pool, keys: KeyRing): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("select id from tenants");
  let rewritten = 0;
  for (const { id } of rows) {
    rewritten += await withTenantTx(pool, id, async (tx) => {
      const row = await settingsRow(tx);
      if (!row?.enc && !row?.prevEnc) return 0;
      const again = (enc: string | null) => (enc ? encryptSecret(keys, decryptSecret(keys, enc, id), id) : null);
      await tx.db
        .update(tenantSettings)
        .set({ webhookSecretEnc: again(row.enc), webhookSecretPrevEnc: again(row.prevEnc) })
        .where(eq(tenantSettings.tenantId, id));
      return 1;
    });
  }
  return rewritten;
}
