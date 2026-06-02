CREATE TABLE "capa_links" (
	"id" text PRIMARY KEY,
	"capa_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effectiveness_checks" (
	"id" text PRIMARY KEY,
	"capa_id" text NOT NULL,
	"due_date" text,
	"owner" text NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"root_cause_eliminated" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"recurred" text DEFAULT '' NOT NULL,
	"determination" text DEFAULT '' NOT NULL,
	"verified_by" text DEFAULT '' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "capa_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "effectiveness_check_due_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "effectiveness_check_owner" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "effectiveness_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "capa_links_capa_idx" ON "capa_links" ("capa_id");--> statement-breakpoint
CREATE INDEX "capa_links_source_idx" ON "capa_links" ("source_id");--> statement-breakpoint
CREATE INDEX "effectiveness_checks_capa_idx" ON "effectiveness_checks" ("capa_id");