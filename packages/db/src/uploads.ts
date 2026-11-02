import { and, eq, isNull } from "drizzle-orm";
import { uploads } from "./schema";
import type { TenantTx } from "./tenant-tx";

export type UploadRow = typeof uploads.$inferSelect;

/** Step 1 of the two-step upload: records the server-issued key and what the client declared. */
export async function insertUpload(
  tx: TenantTx,
  input: {
    storageKey: string;
    filename: string;
    expectedSize: number;
    expectedMime: string;
    expiresAt: Date;
    createdBy: string;
  },
): Promise<string> {
  const [row] = await tx.db
    .insert(uploads)
    .values({ tenantId: tx.tenantId, ...input })
    .returning({ id: uploads.id });
  if (!row) throw new Error("upload insert returned no row");
  return row.id;
}

/** The tenant's upload, or null (another tenant's upload is invisible under RLS). */
export async function getUpload(tx: TenantTx, uploadId: string): Promise<UploadRow | null> {
  const [row] = await tx.db.select().from(uploads).where(eq(uploads.id, uploadId));
  return row ?? null;
}

export async function markUploadCompleted(tx: TenantTx, uploadId: string): Promise<void> {
  await tx.db
    .update(uploads)
    .set({ completedAt: new Date() })
    .where(and(eq(uploads.id, uploadId), isNull(uploads.completedAt)));
}
