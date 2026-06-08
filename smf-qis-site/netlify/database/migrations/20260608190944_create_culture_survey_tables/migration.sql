CREATE TABLE "culture_survey_categories" (
	"id" text PRIMARY KEY,
	"survey_id" text DEFAULT '' NOT NULL,
	"category_name" text DEFAULT '' NOT NULL,
	"score" numeric DEFAULT '0' NOT NULL,
	"percentage_score" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'Good' NOT NULL,
	"low_rating_pct" numeric DEFAULT '0' NOT NULL,
	"priority" text DEFAULT 'OK' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "culture_surveys" (
	"id" text PRIMARY KEY,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"survey_period" text DEFAULT '' NOT NULL,
	"survey_date" text DEFAULT '' NOT NULL,
	"overall_score" numeric DEFAULT '0' NOT NULL,
	"percentage_score" numeric DEFAULT '0' NOT NULL,
	"total_responses" integer DEFAULT 0 NOT NULL,
	"target_score" numeric DEFAULT '80' NOT NULL,
	"sqf_rating" text DEFAULT '' NOT NULL,
	"sharepoint_file_url" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "culture_survey_categories_survey_idx" ON "culture_survey_categories" ("survey_id");--> statement-breakpoint
CREATE INDEX "culture_surveys_site_idx" ON "culture_surveys" ("site");