import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Starter table only. The full data model (docs/architecture.md §4) lands in
// phase 1, with RLS policies and tenant-scoped composite foreign keys.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
