CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('user', 'api_key', 'system')),
	CONSTRAINT "audit_events_action_check" CHECK ("audit_events"."action" in ('settings.webhook_updated', 'settings.webhook_secret_rotated', 'settings.budget_updated', 'settings.retention_updated', 'settings.inbound_rotated', 'api_key.created', 'api_key.revoked', 'action.redelivered', 'config.created', 'config.frozen', 'config.activated', 'eval_run.created', 'eval_item.retired', 'document.purged', 'retention.swept', 'auth.two_factor_enabled', 'auth.two_factor_disabled'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");