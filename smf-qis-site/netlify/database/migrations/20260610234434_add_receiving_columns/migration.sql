ALTER TABLE "receiving_inspections" ADD COLUMN "arrival_site" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_line_items" ADD COLUMN "internal_batch_lot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_line_items" ADD COLUMN "origin_site" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_line_items" ADD COLUMN "attachments" jsonb DEFAULT '[]' NOT NULL;