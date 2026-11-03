ALTER TABLE "mailbox_messages" DROP CONSTRAINT "mailbox_messages_reason_check";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "workspace_domain" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "workspace_join_role" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "join_role" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_workspace_domain_key" UNIQUE("workspace_domain");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_workspace_join_role_check" CHECK ("tenants"."workspace_join_role" in ('reviewer', 'viewer'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_workspace_domain_check" CHECK (("tenants"."workspace_domain" is null) = ("tenants"."workspace_join_role" is null) and "tenants"."workspace_domain" = lower("tenants"."workspace_domain"));--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_reason_check" CHECK ("mailbox_messages"."reason" in ('not_inbound', 'deleted', 'too_large', 'too_many_attachments', 'unreadable', 'disconnected', 'retries_exhausted'));--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_join_role_check" CHECK ("oauth_states"."join_role" in ('reviewer', 'viewer'));