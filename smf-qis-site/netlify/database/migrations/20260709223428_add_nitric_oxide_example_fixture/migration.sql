-- Deletable EXAMPLE fixture: one Draft MMR for PN-1106 "Nitric Oxide" with its
-- four ingredient lines, so the module has something to look at on first open.
--
-- This is ordinary data, NOT special-cased anywhere in the application. It can be
-- deleted from the UI like any other Draft MMR and will not reappear (migrations
-- run once). The ids use an obvious "EX" namespace purely so this seed can never
-- collide with app-generated ING-######/MMI-###### ids; nothing in the code
-- references these ids. Every stored value here is a true INPUT — all quantities
-- (total mg/dose, mg/capsule, gross weights, batch weight) are derived at read
-- time by lib/formula.ts, never stored.

-- ── Ingredients (catalogue rows the formula draws on) ────────────────────────
INSERT INTO "ingredients" ("id","item_number","name","supplier_id","default_unit","notes","created_by","created_at","modified_by","modified_at") VALUES
  ('ING-EX-NO-1', NULL, 'L-Arginine AKG',             NULL, 'mg', '', 'Example fixture (safe to delete)', now(), 'Example fixture (safe to delete)', now()),
  ('ING-EX-NO-2', NULL, 'L-Arginine HCL',             NULL, 'mg', '', 'Example fixture (safe to delete)', now(), 'Example fixture (safe to delete)', now()),
  ('ING-EX-NO-3', NULL, 'L-Citrulline',               NULL, 'mg', '', 'Example fixture (safe to delete)', now(), 'Example fixture (safe to delete)', now()),
  ('ING-EX-NO-4', NULL, 'L-Citrulline Malate 1:1',    NULL, 'mg', '', 'Example fixture (safe to delete)', now(), 'Example fixture (safe to delete)', now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── MMR header (all quantities below the inputs are derived, not stored) ─────
INSERT INTO "mmrs" (
  "id","product_code","product_name","revision","status",
  "capsule_spec","capsule_rm_number",
  "capsules_per_dose","capsule_weight_mg","capsule_component_id",
  "gross_weight_tolerance_low_pct","gross_weight_tolerance_high_pct",
  "gross_weight_low_mg_override","gross_weight_high_mg_override",
  "blend_yield_min_pct","blend_yield_max_pct",
  "encap_yield_min_pct","encap_yield_max_pct",
  "bottling_yield_min_pct","bottling_yield_max_pct",
  "label_revision","approved_by","approved_at","superseded_by",
  "created_by","created_at","modified_by","modified_at"
) VALUES (
  'MMR-PN1106-Rev01','PN-1106','Nitric Oxide',1,'Draft',
  '"00" Vegetarian Capsule',NULL,
  2,123,NULL,
  0.05,0.05,
  NULL,NULL,
  99,100,
  99,105,
  100,105,
  NULL,NULL,NULL,NULL,
  'Example fixture (safe to delete)',now(),'Example fixture (safe to delete)',now()
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── Ingredient bill (stored INPUTS only: label claim, potency, overage) ──────
INSERT INTO "mmr_ingredients" ("id","mmr_id","ingredient_id","line_order","label_claim_mg","potency","overage_pct","notes") VALUES
  ('MMI-EX-NO-1','MMR-PN1106-Rev01','ING-EX-NO-1',1,500,0.97,0.05,NULL),
  ('MMI-EX-NO-2','MMR-PN1106-Rev01','ING-EX-NO-2',2,500,0.98,0.05,NULL),
  ('MMI-EX-NO-3','MMR-PN1106-Rev01','ING-EX-NO-3',3,250,0.98,0.05,NULL),
  ('MMI-EX-NO-4','MMR-PN1106-Rev01','ING-EX-NO-4',4,250,0.985,0.05,NULL)
ON CONFLICT ("id") DO NOTHING;
