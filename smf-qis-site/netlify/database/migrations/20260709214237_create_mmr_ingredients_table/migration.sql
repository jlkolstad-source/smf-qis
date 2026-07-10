CREATE TABLE "mmr_ingredients" (
	"id" text PRIMARY KEY,
	"mmr_id" text NOT NULL,
	"ingredient_id" text NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL,
	"quantity_per_capsule" numeric(20,10) DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'mg' NOT NULL,
	"overage_pct" numeric DEFAULT '0',
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "mmr_ingredients_mmr_idx" ON "mmr_ingredients" ("mmr_id");--> statement-breakpoint
CREATE INDEX "mmr_ingredients_ingredient_idx" ON "mmr_ingredients" ("ingredient_id");--> statement-breakpoint
CREATE INDEX "mmr_ingredients_mmr_order_idx" ON "mmr_ingredients" ("mmr_id","line_order");--> statement-breakpoint
ALTER TABLE "mmr_ingredients" ADD CONSTRAINT "mmr_ingredients_mmr_id_mmrs_id_fkey" FOREIGN KEY ("mmr_id") REFERENCES "mmrs"("id");--> statement-breakpoint
ALTER TABLE "mmr_ingredients" ADD CONSTRAINT "mmr_ingredients_ingredient_id_ingredients_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id");