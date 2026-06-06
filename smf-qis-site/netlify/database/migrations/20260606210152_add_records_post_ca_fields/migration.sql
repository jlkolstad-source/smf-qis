ALTER TABLE "records" ADD COLUMN "post_ca_likelihood" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "post_ca_severity" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "post_ca_risk_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "post_ca_risk_level" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "risk_reduction_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "post_ca_remarks" text DEFAULT '' NOT NULL;