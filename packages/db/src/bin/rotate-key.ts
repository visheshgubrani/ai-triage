import { keyRingFromEnv } from "../crypto";
import { createPool, withTenantTx } from "../index";
import { reencryptMailboxTokens } from "../mailboxes";
import { reencryptWebhookSecrets } from "../settings";
import { requireEnv } from "./env";

// `pnpm secrets:rotate-key`: re-encrypts every secret (webhook signing secrets, mailbox tokens)
// under the first key in ENCRYPTION_KEYS. Put the new key first and keep the old one in the ring
// until this has run; then the old key can be dropped. Runs as the owner (FORCE RLS still applies
// per tenant).

const keys = keyRingFromEnv(process.env);
const pool = createPool(requireEnv("DATABASE_OWNER_URL"));
try {
  const count = await reencryptWebhookSecrets(pool, keys);
  console.log(`re-encrypted the webhook secrets of ${count} tenant(s) under key "${keys.primary}"`);
  const { rows } = await pool.query<{ id: string }>("select id from tenants");
  let mailboxes = 0;
  for (const { id } of rows) mailboxes += await withTenantTx(pool, id, (tx) => reencryptMailboxTokens(tx, keys));
  console.log(`re-encrypted the tokens of ${mailboxes} mailbox(es) under key "${keys.primary}"`);
} finally {
  await pool.end();
}
