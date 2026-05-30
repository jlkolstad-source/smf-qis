CREATE TABLE "report_drafts" (
	"id" serial PRIMARY KEY,
	"report_type" text NOT NULL,
	"period" text NOT NULL,
	"site" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "report_drafts_key_idx" ON "report_drafts" ("report_type","period","site");