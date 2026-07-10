ALTER TABLE "mmr_ingredients" ADD COLUMN "label_claim_mg" numeric(20,10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "mmr_ingredients" ADD COLUMN "potency" numeric(20,10) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "capsules_per_dose" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "capsule_weight_mg" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "capsule_component_id" text;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "gross_weight_tolerance_low_pct" numeric;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "gross_weight_tolerance_high_pct" numeric;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "gross_weight_low_mg_override" numeric;--> statement-breakpoint
ALTER TABLE "mmrs" ADD COLUMN "gross_weight_high_mg_override" numeric;--> statement-breakpoint
ALTER TABLE "mmr_ingredients" DROP COLUMN "quantity_per_capsule";--> statement-breakpoint
ALTER TABLE "mmr_ingredients" DROP COLUMN "unit";--> statement-breakpoint
ALTER TABLE "mmrs" DROP COLUMN "gross_weight_low_mg";--> statement-breakpoint
ALTER TABLE "mmrs" DROP COLUMN "gross_weight_target_mg";--> statement-breakpoint
ALTER TABLE "mmrs" DROP COLUMN "gross_weight_high_mg";--> statement-breakpoint
ALTER TABLE "mmr_ingredients" ALTER COLUMN "overage_pct" SET DATA TYPE numeric(20,10) USING "overage_pct"::numeric(20,10);--> statement-breakpoint
ALTER TABLE "mmr_ingredients" ALTER COLUMN "overage_pct" SET NOT NULL;