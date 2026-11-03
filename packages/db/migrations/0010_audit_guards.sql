-- Audit log guards (docs/security.md): tenant isolation like every tenant table (0002_rls.sql),
-- and insert-only twice over: the app role has no UPDATE or DELETE grant, and a trigger refuses
-- both for every role, as it does for review_decisions.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_events FROM app_rw;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
