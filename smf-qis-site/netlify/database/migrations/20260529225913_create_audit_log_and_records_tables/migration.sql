CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY,
	"record_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"changed_by" text DEFAULT '' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" text PRIMARY KEY,
	"type" text DEFAULT 'CAPA' NOT NULL,
	"severity" text DEFAULT 'Minor' NOT NULL,
	"clause" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"due_date" text DEFAULT '' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"ca" text DEFAULT '' NOT NULL,
	"rca" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"photos" jsonb DEFAULT '[]' NOT NULL,
	"self_assigned" boolean DEFAULT false NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_record_idx" ON "audit_log" ("record_id");--> statement-breakpoint
CREATE INDEX "records_site_idx" ON "records" ("site");