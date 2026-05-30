CREATE TABLE "crisis_exercises" (
	"id" text PRIMARY KEY,
	"exercise_type" text DEFAULT '' NOT NULL,
	"scenario_name" text DEFAULT '' NOT NULL,
	"scenario_type" text DEFAULT '' NOT NULL,
	"exercise_date" text DEFAULT '' NOT NULL,
	"facilitator" text DEFAULT '' NOT NULL,
	"exercise_format" text DEFAULT '' NOT NULL,
	"governing_sop" text DEFAULT 'SOP #20 | SQF Clause 2.6.4' NOT NULL,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"scenario_narrative" text DEFAULT '' NOT NULL,
	"objectives" jsonb DEFAULT '[]' NOT NULL,
	"discussion" jsonb DEFAULT '[]' NOT NULL,
	"lessons_learned" jsonb DEFAULT '[]' NOT NULL,
	"attendees" jsonb DEFAULT '[]' NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"response_adequate" text DEFAULT '' NOT NULL,
	"plan_update_required" text DEFAULT '' NOT NULL,
	"next_exercise_date" text DEFAULT '' NOT NULL,
	"summary_notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'In Progress' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crisis_response_log" (
	"id" serial PRIMARY KEY,
	"exercise_id" text NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"program" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"doc_ref" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crisis_exercises_site_idx" ON "crisis_exercises" ("site");--> statement-breakpoint
CREATE INDEX "crisis_response_log_exercise_idx" ON "crisis_response_log" ("exercise_id");