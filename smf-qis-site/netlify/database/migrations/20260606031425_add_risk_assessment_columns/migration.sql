ALTER TABLE "crisis_exercises" ADD COLUMN "findings_risk_summary" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "oos_records" ADD COLUMN "likelihood" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "oos_records" ADD COLUMN "risk_severity" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "oos_records" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oos_records" ADD COLUMN "risk_level" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recall_findings" ADD COLUMN "likelihood" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recall_findings" ADD COLUMN "risk_severity" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recall_findings" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recall_findings" ADD COLUMN "risk_level" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "likelihood" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "risk_severity" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "risk_level" text DEFAULT '' NOT NULL;