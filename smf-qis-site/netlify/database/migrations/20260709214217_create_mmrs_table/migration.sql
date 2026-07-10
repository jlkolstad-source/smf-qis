CREATE TABLE "mmrs" (
	"id" text PRIMARY KEY,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"capsule_spec" text DEFAULT '' NOT NULL,
	"capsule_rm_number" text,
	"gross_weight_low_mg" numeric,
	"gross_weight_target_mg" numeric,
	"gross_weight_high_mg" numeric,
	"blend_yield_min_pct" numeric,
	"blend_yield_max_pct" numeric,
	"encap_yield_min_pct" numeric,
	"encap_yield_max_pct" numeric,
	"bottling_yield_min_pct" numeric,
	"bottling_yield_max_pct" numeric,
	"label_revision" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"superseded_by" text,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mmrs_product_code_idx" ON "mmrs" ("product_code");--> statement-breakpoint
CREATE INDEX "mmrs_status_idx" ON "mmrs" ("status");--> statement-breakpoint
CREATE INDEX "mmrs_product_status_idx" ON "mmrs" ("product_code","status");