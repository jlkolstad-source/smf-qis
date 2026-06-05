ALTER TABLE "recall_exercises" ADD COLUMN "scenario_script" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recall_nodes" ADD COLUMN "statement" text DEFAULT '' NOT NULL;