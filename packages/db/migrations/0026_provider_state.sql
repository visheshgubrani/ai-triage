CREATE TABLE "llm_provider_state" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cooldown_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_provider_state_pkey" PRIMARY KEY("provider","model")
);
