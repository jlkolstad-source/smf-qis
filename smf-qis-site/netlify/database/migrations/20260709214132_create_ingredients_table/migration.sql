CREATE TABLE "ingredients" (
	"id" text PRIMARY KEY,
	"item_number" text,
	"name" text NOT NULL,
	"supplier_id" text,
	"default_unit" text DEFAULT 'g' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" text DEFAULT '' NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ingredients_name_idx" ON "ingredients" ("name");--> statement-breakpoint
CREATE INDEX "ingredients_item_number_idx" ON "ingredients" ("item_number");--> statement-breakpoint
CREATE INDEX "ingredients_supplier_idx" ON "ingredients" ("supplier_id");