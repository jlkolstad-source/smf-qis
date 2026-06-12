CREATE TABLE "action_log" (
	"id" text PRIMARY KEY,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"user_email" text DEFAULT '' NOT NULL,
	"user_role" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"record_type" text DEFAULT '' NOT NULL,
	"record_id" text DEFAULT '' NOT NULL,
	"site" text DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "action_log_timestamp_idx" ON "action_log" ("timestamp");--> statement-breakpoint
CREATE INDEX "action_log_user_email_idx" ON "action_log" ("user_email");--> statement-breakpoint
CREATE INDEX "action_log_action_idx" ON "action_log" ("action");