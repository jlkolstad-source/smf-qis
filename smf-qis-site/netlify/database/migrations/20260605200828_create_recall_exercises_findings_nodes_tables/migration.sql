CREATE TABLE "recall_exercises" (
	"id" text PRIMARY KEY,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"exercise_type" text DEFAULT 'Mock Recall' NOT NULL,
	"initiated_by" text DEFAULT '' NOT NULL,
	"date_initiated" timestamp with time zone DEFAULT now() NOT NULL,
	"starting_material_type" text DEFAULT '' NOT NULL,
	"starting_lot_number" text DEFAULT '' NOT NULL,
	"recall_direction" text DEFAULT 'Both' NOT NULL,
	"scenario_description" text DEFAULT '' NOT NULL,
	"governing_sop" text DEFAULT 'SOP #21 — Trace and Recall' NOT NULL,
	"total_quantity_affected" text DEFAULT '' NOT NULL,
	"quantity_accounted_for" text DEFAULT '' NOT NULL,
	"quantity_unaccounted" text DEFAULT '' NOT NULL,
	"traceability_rate" text DEFAULT '' NOT NULL,
	"recall_scope" text DEFAULT '' NOT NULL,
	"regulatory_notification_required" text DEFAULT '' NOT NULL,
	"customer_notification_required" text DEFAULT '' NOT NULL,
	"customer_notification_count" text DEFAULT '' NOT NULL,
	"time_to_complete" text DEFAULT '' NOT NULL,
	"overall_assessment" text DEFAULT '' NOT NULL,
	"facilitator_notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"signatures" jsonb DEFAULT '[]' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recall_findings" (
	"id" text PRIMARY KEY,
	"recall_id" text DEFAULT '' NOT NULL,
	"finding_description" text DEFAULT '' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"target_date" text DEFAULT '' NOT NULL,
	"capa_required" text DEFAULT '' NOT NULL,
	"capa_id" text DEFAULT '' NOT NULL,
	"ncr_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recall_nodes" (
	"id" text PRIMARY KEY,
	"recall_id" text DEFAULT '' NOT NULL,
	"node_order" integer DEFAULT 0 NOT NULL,
	"node_type" text DEFAULT '' NOT NULL,
	"node_date" text DEFAULT '' NOT NULL,
	"lot_batch_number" text DEFAULT '' NOT NULL,
	"quantity" text DEFAULT '' NOT NULL,
	"quantity_unit" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"responsible_person" text DEFAULT '' NOT NULL,
	"documents_referenced" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"traceability_status" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recall_exercises_site_idx" ON "recall_exercises" ("site");--> statement-breakpoint
CREATE INDEX "recall_exercises_status_idx" ON "recall_exercises" ("status");--> statement-breakpoint
CREATE INDEX "recall_findings_recall_idx" ON "recall_findings" ("recall_id");--> statement-breakpoint
CREATE INDEX "recall_nodes_recall_idx" ON "recall_nodes" ("recall_id");