CREATE TABLE "audit_sessions" (
	"id" text PRIMARY KEY,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"scheduled_date" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Scheduled' NOT NULL,
	"start_time" timestamp with time zone,
	"started_by" text DEFAULT '' NOT NULL,
	"building" text DEFAULT '' NOT NULL,
	"facility_address" text DEFAULT '' NOT NULL,
	"facility_name" text DEFAULT '' NOT NULL,
	"clauses_label" text DEFAULT '' NOT NULL,
	"sections" jsonb DEFAULT '[]' NOT NULL,
	"signatures" jsonb DEFAULT '[]' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crisis_exercises" ADD COLUMN "signatures" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "oos_records" ADD COLUMN "signatures" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "audit_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "signatures" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_sessions_site_idx" ON "audit_sessions" ("site");