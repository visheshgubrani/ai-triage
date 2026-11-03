CREATE TABLE "rate_limit_hits" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY("bucket","window_start")
);
