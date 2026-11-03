CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"email" text NOT NULL,
	"provider_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"label_id" text DEFAULT 'INBOX' NOT NULL,
	"label_name" text DEFAULT 'Inbox' NOT NULL,
	"refresh_token_enc" text,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"history_id" text,
	"cursor_version" integer DEFAULT 0 NOT NULL,
	"backfill_days" integer,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_connections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mailbox_connections_tenant_id_provider_email_key" UNIQUE("tenant_id","provider","email"),
	CONSTRAINT "mailbox_connections_provider_check" CHECK ("mailbox_connections"."provider" in ('google')),
	CONSTRAINT "mailbox_connections_status_check" CHECK ("mailbox_connections"."status" in ('active', 'paused', 'reauth_required', 'disconnected')),
	CONSTRAINT "mailbox_connections_email_lowercase_check" CHECK ("mailbox_connections"."email" = lower("mailbox_connections"."email"))
);
--> statement-breakpoint
CREATE TABLE "mailbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"document_id" uuid,
	"size_bytes" bigint,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_messages_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mailbox_messages_connection_id_provider_message_id_key" UNIQUE("connection_id","provider_message_id"),
	CONSTRAINT "mailbox_messages_status_check" CHECK ("mailbox_messages"."status" in ('queued', 'ingested', 'duplicate', 'skipped', 'deferred', 'failed', 'purged')),
	CONSTRAINT "mailbox_messages_reason_check" CHECK ("mailbox_messages"."reason" in ('not_inbound', 'deleted', 'too_large', 'too_many_attachments', 'unreadable', 'retries_exhausted'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"code_verifier" text NOT NULL,
	"backfill_days" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "oauth_states_purpose_check" CHECK ("oauth_states"."purpose" in ('mailbox', 'workspace_domain'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."mailbox_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_connections_due_idx" ON "mailbox_connections" USING btree ("status","next_sync_at");--> statement-breakpoint
CREATE INDEX "mailbox_messages_tenant_id_connection_id_created_at_idx" ON "mailbox_messages" USING btree ("tenant_id","connection_id","created_at");--> statement-breakpoint
CREATE INDEX "mailbox_messages_tenant_id_document_id_idx" ON "mailbox_messages" USING btree ("tenant_id","document_id");