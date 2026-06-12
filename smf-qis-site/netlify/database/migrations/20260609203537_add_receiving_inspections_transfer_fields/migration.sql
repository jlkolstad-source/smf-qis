ALTER TABLE "receiving_inspections" ADD COLUMN "record_type" text DEFAULT 'Receiving' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "linked_transfer_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "seal_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "destination" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "expected_arrival" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "departure_temp" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "arrival_temp" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "discrepancies" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receiving_inspections" ADD COLUMN "received_by" text DEFAULT '' NOT NULL;