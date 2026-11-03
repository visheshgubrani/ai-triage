-- Mailbox sync tables (docs/architecture.md §5): tenant isolation like every tenant table
-- (0002_rls.sql). Grants come from 0002's default privileges.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON oauth_states
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE mailbox_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mailbox_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mailbox_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE mailbox_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mailbox_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mailbox_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
