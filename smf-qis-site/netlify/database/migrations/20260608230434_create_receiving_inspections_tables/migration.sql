CREATE TABLE "receiving_inspections" (
	"id" text PRIMARY KEY,
	"site" text DEFAULT 'Lindon' NOT NULL,
	"inspection_date" timestamp with time zone DEFAULT now() NOT NULL,
	"inspected_by" text DEFAULT '' NOT NULL,
	"carrier" text DEFAULT '' NOT NULL,
	"trailer_number" text DEFAULT '' NOT NULL,
	"po_number" text DEFAULT '' NOT NULL,
	"cold_shipment" text DEFAULT 'No' NOT NULL,
	"required_temp_range" text DEFAULT '' NOT NULL,
	"truck_temp" text DEFAULT '' NOT NULL,
	"trailer_temp" text DEFAULT '' NOT NULL,
	"product_temp" text DEFAULT '' NOT NULL,
	"temp_acceptable" text DEFAULT '' NOT NULL,
	"trailer_exterior_ok" text DEFAULT '' NOT NULL,
	"trailer_interior_ok" text DEFAULT '' NOT NULL,
	"no_pest_activity" text DEFAULT '' NOT NULL,
	"seals_intact" text DEFAULT '' NOT NULL,
	"materials_secured" text DEFAULT '' NOT NULL,
	"packaging_undamaged" text DEFAULT '' NOT NULL,
	"labels_correct" text DEFAULT '' NOT NULL,
	"overall_result" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"ncr_id" text DEFAULT '' NOT NULL,
	"oos_id" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]' NOT NULL,
	"signatures" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_line_items" (
	"id" text PRIMARY KEY,
	"inspection_id" text DEFAULT '' NOT NULL,
	"material_name" text DEFAULT '' NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"lot_number" text DEFAULT '' NOT NULL,
	"quantity" text DEFAULT '' NOT NULL,
	"quantity_unit" text DEFAULT '' NOT NULL,
	"coa_received" text DEFAULT '' NOT NULL,
	"coa_reference" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "receiving_inspections_site_idx" ON "receiving_inspections" ("site");--> statement-breakpoint
CREATE INDEX "receiving_inspections_inspection_date_idx" ON "receiving_inspections" ("inspection_date");--> statement-breakpoint
CREATE INDEX "receiving_line_items_inspection_idx" ON "receiving_line_items" ("inspection_id");