import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { tenantSettings } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Webhook target per tenant (docs/architecture.md §3: webhook targets come only from tenant settings).
// The secret signs deliveries (HMAC), so it is stored as is, not hashed; it is shown to the admin only
// when it is created or rotated.

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export async function getWebhookSettings(tx: TenantTx) {
  const [row] = await tx.db
    .select({ url: tenantSettings.webhookUrl, secret: tenantSettings.webhookSecret })
    .from(tenantSettings);
  return {
    url: row?.url ?? null,
    secretSet: Boolean(row?.secret),
    /** Enough of the secret to recognise it, never enough to use it. */
    secretHint: row?.secret ? `${row.secret.slice(0, 10)}…` : null,
  };
}

/**
 * Sets the webhook URL, plus a secret if there is none yet (or `secret` is given, as the demo seed
 * does). Returns the secret only when it was created here.
 */
export async function setWebhook(
  tx: TenantTx,
  input: { url: string | null; secret?: string },
): Promise<{ secret: string | null }> {
  const [row] = await tx.db.select({ secret: tenantSettings.webhookSecret }).from(tenantSettings);
  const secret = input.secret ?? (row?.secret ? null : generateWebhookSecret());
  await tx.db
    .insert(tenantSettings)
    .values({ tenantId: tx.tenantId, webhookUrl: input.url, ...(secret ? { webhookSecret: secret } : {}) })
    .onConflictDoUpdate({
      target: tenantSettings.tenantId,
      set: { webhookUrl: input.url, ...(secret ? { webhookSecret: secret } : {}) },
    });
  return { secret: input.secret ? null : secret };
}

/** Replaces the secret. Deliveries signed from now on use the new one. */
export async function rotateWebhookSecret(tx: TenantTx): Promise<string> {
  const secret = generateWebhookSecret();
  await tx.db.update(tenantSettings).set({ webhookSecret: secret }).where(eq(tenantSettings.tenantId, tx.tenantId));
  return secret;
}
