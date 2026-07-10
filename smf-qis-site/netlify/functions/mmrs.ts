// REST API for QIS Master Manufacturing Records (MMRs), backed by Netlify Database.
//
// An MMR is a controlled, versioned formula: one row per specific revision, with an
// ingredient bill (mmr_ingredients) that stores only true INPUTS (label claim,
// potency, overage). Every quantity — potency-adjusted mg, total mg per dose, mg
// per capsule, gross weight target/low/high, per-ingredient batch kg, and the
// theoretical blend weight — is DERIVED by the single engine in lib/formula.ts and
// is never stored. This is the "recipe" a Batch Production Record is eventually
// generated from (Supplier → Ingredient → Formula (MMR) → Batch → BPR).
//
// Routes (all under /api/mmrs):
//   GET    /api/mmrs?product_code=&status=          → list MMRs (filterable)
//   GET    /api/mmrs?id=MMR-VITD3-Rev01             → one MMR + bill (with derived) + revision history
//   GET    /api/mmrs?id=...&action=compute-yield&batch_size=300000
//   GET    /api/mmrs?id=...&action=compute-yield&bottles=5000&bottle_count=60
//                                                   → theoretical batch quantities (exact decimal)
//   POST   /api/mmrs                                → create a Draft MMR (Member+)
//   POST   /api/mmrs?id=...&action=add-line         → add an ingredient line (Member+, Draft only)
//   POST   /api/mmrs?id=...&action=update-line      → edit an ingredient line (Member+, Draft only)
//   POST   /api/mmrs?id=...&action=remove-line      → remove an ingredient line (Member+, Draft only)
//   POST   /api/mmrs?id=...&action=reorder-lines    → reorder ingredient lines (Member+, Draft only)
//   POST   /api/mmrs?id=...&action=create-revision  → copy into a new Draft revision (Member+)
//   POST   /api/mmrs?id=...&action=approve          → approve (Quality Manager+); supersedes prior Approved
//   POST   /api/mmrs?id=...&action=supersede        → retire an Approved revision (Quality Manager+)
//   PUT    /api/mmrs?id=...                          → update header (Member+, Draft only, optimistic concurrency)
//   DELETE /api/mmrs?id=...                          → delete (Admin; Draft only, else 409)
//
// VERSIONING STATE MACHINE (enforced entirely server-side, this file):
//   Draft ──edit──▶ Draft         (free editing, header + lines)
//   Draft/Under Review ──approve──▶ Approved   (QM+, stamps approved_by/at;
//                                               supersedes the prior Approved rev)
//   Approved ──(new rev approved)──▶ Superseded (status + superseded_by set)
//   Approved / Superseded ──▶ IMMUTABLE (all edits rejected 409; create a revision)
//   At most ONE Approved revision may exist per product_code at any time.
//
// created_by / modified_by / approved_by are always stamped from the signed-in
// identity, never the body. Every mutation writes per-record history to audit_log
// and the access-control / state-transition event to action_log.
import type { Config } from "@netlify/functions";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mmrs, mmrIngredients, ingredients, auditLog } from "../../db/schema.js";
import { getAuth, roleAtLeast, logAction, concurrencyMatches, conflictResponse, jsonResponse as json } from "./lib/auth.js";
import { deriveFormula } from "./lib/formula.js";

const STATUSES = new Set(["Draft", "Under Review", "Approved", "Superseded"]);
// Statuses a formula (header + lines) may no longer be edited in.
const LOCKED_STATUSES = new Set(["Approved", "Superseded"]);

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function numOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Positive integer (>= 1), falling back to `fallback` when absent / invalid.
function intOrFallback(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

async function logChange(id: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: id, action, detail, changedBy: user || "Unknown" });
}

// Turn a product code into an id-safe token (uppercased alphanumerics).
function codeToken(productCode: string): string {
  return String(productCode || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function mmrIdFor(productCode: string, revision: number): string {
  return `MMR-${codeToken(productCode)}-Rev${String(revision).padStart(2, "0")}`;
}

// The immutability guard message shown when an edit is attempted on a locked MMR.
function lockedMessage(status: string): string {
  return `This MMR is ${status} and is immutable — an approved record cannot be edited. Create a new revision to make changes.`;
}

function toClientMmr(r: typeof mmrs.$inferSelect) {
  return {
    id: r.id,
    productCode: r.productCode || "",
    productName: r.productName || "",
    revision: r.revision ?? 1,
    status: r.status || "Draft",
    capsuleSpec: r.capsuleSpec || "",
    capsuleRmNumber: r.capsuleRmNumber ?? null,
    // Dose / capsule INPUTS.
    capsulesPerDose: r.capsulesPerDose ?? 1,
    capsuleWeightMg: r.capsuleWeightMg ?? "0",
    capsuleComponentId: r.capsuleComponentId ?? null,
    // Gross-weight tolerance INPUTS (target/low/high are derived, see `derived`).
    grossWeightToleranceLowPct: r.grossWeightToleranceLowPct ?? null,
    grossWeightToleranceHighPct: r.grossWeightToleranceHighPct ?? null,
    grossWeightLowMgOverride: r.grossWeightLowMgOverride ?? null,
    grossWeightHighMgOverride: r.grossWeightHighMgOverride ?? null,
    blendYieldMinPct: r.blendYieldMinPct ?? null,
    blendYieldMaxPct: r.blendYieldMaxPct ?? null,
    encapYieldMinPct: r.encapYieldMinPct ?? null,
    encapYieldMaxPct: r.encapYieldMaxPct ?? null,
    bottlingYieldMinPct: r.bottlingYieldMinPct ?? null,
    bottlingYieldMaxPct: r.bottlingYieldMaxPct ?? null,
    labelRevision: r.labelRevision ?? null,
    approvedBy: r.approvedBy ?? null,
    approvedAt: toISO(r.approvedAt),
    supersededBy: r.supersededBy ?? null,
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

// A single ingredient line joined to its ingredient's name / item number. Returns
// only the stored INPUTS — derived quantities are added by buildPayload via the
// formula engine, never stored or computed here.
function toClientLine(row: any) {
  const line = row.line as typeof mmrIngredients.$inferSelect;
  const ing = row.ing as typeof ingredients.$inferSelect | null;
  return {
    id: line.id,
    mmrId: line.mmrId,
    ingredientId: line.ingredientId,
    ingredientName: ing?.name || "(unknown ingredient)",
    itemNumber: ing?.itemNumber ?? null,
    ingredientDefaultUnit: ing?.defaultUnit || "",
    lineOrder: line.lineOrder ?? 0,
    labelClaimMg: line.labelClaimMg ?? "0",
    potency: line.potency ?? "1",
    overagePct: line.overagePct ?? "0",
    notes: line.notes ?? "",
  };
}

// Load an MMR's ingredient bill (joined to ingredient names), ordered by line_order.
async function loadLines(mmrId: string) {
  const rows = await db
    .select({ line: mmrIngredients, ing: ingredients })
    .from(mmrIngredients)
    .leftJoin(ingredients, eq(mmrIngredients.ingredientId, ingredients.id))
    .where(eq(mmrIngredients.mmrId, mmrId))
    .orderBy(asc(mmrIngredients.lineOrder));
  return rows.map(toClientLine);
}

// Compact revision-history summary for every revision sharing a product code.
async function loadRevisions(productCode: string) {
  const rows = await db.select().from(mmrs).where(eq(mmrs.productCode, productCode)).orderBy(asc(mmrs.revision));
  return rows.map((r) => ({
    id: r.id,
    revision: r.revision ?? 1,
    status: r.status || "Draft",
    approvedBy: r.approvedBy ?? null,
    approvedAt: toISO(r.approvedAt),
    supersededBy: r.supersededBy ?? null,
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
  }));
}

// Map a stored MMR row + its lines into the derivation engine's input shape. This
// is the ONLY place the DB model is handed to lib/formula.ts. `weighouts` is an
// optional { lineId: weighoutTargetKg } map and `incrementKg` an optional default
// round-up increment — both batch-time inputs used only by the compute endpoint.
function formulaInputFor(
  rec: typeof mmrs.$inferSelect,
  lines: ReturnType<typeof toClientLine>[],
  batch?: any,
  weighouts?: Record<string, any> | null,
  incrementKg?: any,
) {
  return {
    capsulesPerDose: rec.capsulesPerDose ?? 1,
    capsuleWeightMg: rec.capsuleWeightMg ?? "0",
    toleranceLowPct: rec.grossWeightToleranceLowPct,
    toleranceHighPct: rec.grossWeightToleranceHighPct,
    grossWeightLowMgOverride: rec.grossWeightLowMgOverride,
    grossWeightHighMgOverride: rec.grossWeightHighMgOverride,
    lines: lines.map((l) => ({
      id: l.id,
      ingredientId: l.ingredientId,
      ingredientName: l.ingredientName,
      itemNumber: l.itemNumber,
      lineOrder: l.lineOrder,
      labelClaimMg: l.labelClaimMg,
      potency: l.potency,
      overagePct: l.overagePct,
      weighoutTargetKg: weighouts ? weighouts[l.id] : undefined,
    })),
    batch: batch || null,
    weighoutIncrementKg: incrementKg,
  };
}

// Build the full client payload for one MMR: stored fields + per-line derived
// quantities + MMR-level derived values, all sourced from the single engine.
function buildPayload(rec: typeof mmrs.$inferSelect, lines: ReturnType<typeof toClientLine>[], revisions: any, batch?: any) {
  const result = deriveFormula(formulaInputFor(rec, lines, batch));
  const ingredientsOut = lines.map((l, i) => ({
    ...l,
    potencyAdjustedMg: result.lines[i].potencyAdjustedMg,
    totalMgPerDose: result.lines[i].totalMgPerDose,
    mgPerCapsule: result.lines[i].mgPerCapsule,
    batchQuantityKg: result.lines[i].batchQuantityKg,
  }));
  return {
    ...toClientMmr(rec),
    ingredients: ingredientsOut,
    revisions,
    derived: {
      totalMgPerDoseAll: result.totalMgPerDoseAll,
      mgPerCapsuleAll: result.mgPerCapsuleAll,
      grossWeightTargetMg: result.grossWeightTargetMg,
      grossWeightLowMg: result.grossWeightLowMg,
      grossWeightHighMg: result.grossWeightHighMg,
      capsulesPerBatch: result.capsulesPerBatch,
      bottles: result.bottles,
      bottleCount: result.bottleCount,
      dosesPerBatch: result.dosesPerBatch,
      theoreticalBlendWeightKg: result.theoreticalBlendWeightKg,
    },
  };
}

// Build the theoretical-batch / weigh-out response for one MMR at a given batch
// size and optional weigh-out targets. This is the Build-3 / BPR entry point and
// the source of the live weigh-out preview. Every value comes from the single
// engine; the never-short guardrail result (weighoutValid / weighoutErrors /
// per-line weighoutShort) is enforced server-side here.
function computeYieldPayload(
  rec: typeof mmrs.$inferSelect,
  lines: ReturnType<typeof toClientLine>[],
  batch: any,
  weighouts: Record<string, any> | null,
  incrementKg: any,
) {
  const result = deriveFormula(formulaInputFor(rec, lines, batch, weighouts, incrementKg));
  return {
    mmrId: rec.id,
    capsulesPerBatch: result.capsulesPerBatch,
    bottles: result.bottles,
    bottleCount: result.bottleCount,
    dosesPerBatch: result.dosesPerBatch,
    totalMgPerDoseAll: result.totalMgPerDoseAll,
    mgPerCapsuleAll: result.mgPerCapsuleAll,
    grossWeightTargetMg: result.grossWeightTargetMg,
    grossWeightLowMg: result.grossWeightLowMg,
    grossWeightHighMg: result.grossWeightHighMg,
    // CHARGED weight (Σ weigh-out) — the blend that goes to the floor and the
    // basis for blending yield. FORMULA minimum sum is the proven-satisfied
    // minimum shown underneath — never the charged weight, never the yield basis.
    chargedWeightKg: result.chargedWeightKg,
    formulaMinimumSumKg: result.formulaMinimumSumKg,
    theoreticalBlendWeightKg: result.theoreticalBlendWeightKg, // back-compat = formula sum
    // Never-short guardrail (server-side enforcement).
    weighoutValid: result.weighoutValid,
    weighoutErrors: result.weighoutErrors,
    lines: result.lines.map((l) => ({
      lineId: l.id,
      ingredientId: l.ingredientId,
      ingredientName: l.ingredientName,
      itemNumber: l.itemNumber,
      labelClaimMg: l.labelClaimMg,
      potency: l.potency,
      overagePct: l.overagePct,
      potencyAdjustedMg: l.potencyAdjustedMg,
      totalMgPerDose: l.totalMgPerDose,
      mgPerCapsule: l.mgPerCapsule,
      formulaBatchQtyKg: l.formulaBatchQtyKg,
      weighoutTargetKg: l.weighoutTargetKg,
      manufacturingOverageKg: l.manufacturingOverageKg,
      manufacturingOveragePct: l.manufacturingOveragePct,
      weighoutShort: l.weighoutShort,
      weighoutShortfallKg: l.weighoutShortfallKg,
      batchQuantityKg: l.formulaBatchQtyKg, // back-compat
    })),
  };
}

// Trim trailing zeros (and a dangling dot) so a clean weigh-out like "154.0000"
// prints as "154". Exact figures (formula quantities, mg values) are left at the
// engine's rendered precision.
function cleanNum(s: string | null | undefined): string {
  if (s == null || s === "") return "-";
  return String(s).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// Map the engine result + stored MMR row into the Formula Card's render data. No
// arithmetic happens here — every value is passed straight from lib/formula.ts.
function buildFormulaCardData(rec: typeof mmrs.$inferSelect, result: ReturnType<typeof deriveFormula>, generatedDate: string) {
  return {
    meta: {
      productName: rec.productName || "",
      productCode: rec.productCode || "",
      mmrId: rec.id,
      revision: rec.revision ?? 1,
      status: rec.status || "Draft",
      // No dedicated quote field exists yet; the controlled label/revision id fills
      // this slot (falls back to "-" when unset). Reserved for the quote module.
      quoteRevisionId: rec.labelRevision || "",
      capsulesPerBatch: String(result.capsulesPerBatch ?? ""),
      dosesPerBatch: cleanNum(result.dosesPerBatch),
      capsuleSpec: rec.capsuleSpec || "",
      capsuleWeightMg: rec.capsuleWeightMg ?? "",
      generatedDate,
    },
    formulaLines: result.lines.map((l) => ({
      itemNumber: l.itemNumber || "",
      name: l.ingredientName || "",
      labelClaimMg: String(l.labelClaimMg),
      potency: String(l.potency),
      overagePct: String(l.overagePct),
      totalMgPerDose: l.totalMgPerDose,
      mgPerCapsule: l.mgPerCapsule,
    })),
    summary: {
      totalMgPerDoseAll: result.totalMgPerDoseAll,
      mgPerCapsuleAll: result.mgPerCapsuleAll,
      grossTargetMg: result.grossWeightTargetMg,
      grossLowMg: result.grossWeightLowMg || "-",
      grossHighMg: result.grossWeightHighMg || "-",
      capsulesPerDose: String(rec.capsulesPerDose ?? 1),
    },
    batchLines: result.lines.map((l) => ({
      itemNumber: l.itemNumber || "",
      name: l.ingredientName || "",
      formulaBatchQtyKg: l.formulaBatchQtyKg || "-",
      mfgOverageKg: l.manufacturingOverageKg || "-",
      mfgOveragePct: l.manufacturingOveragePct != null ? l.manufacturingOveragePct + "%" : "-",
      weighoutTargetKg: cleanNum(l.weighoutTargetKg),
    })),
    totals: {
      formulaTheoreticalKg: result.formulaMinimumSumKg || "-",
      chargedWeightKg: cleanNum(result.chargedWeightKg),
      capsules: String(result.capsulesPerBatch ?? "-"),
      bottles: result.bottles != null ? String(result.bottles) : "- (bottle count not set)",
    },
  };
}

// Load + build the full payload for one MMR id (used by every mutation return).
async function mmrPayload(id: string, batch?: any) {
  const [rec] = await db.select().from(mmrs).where(eq(mmrs.id, id));
  if (!rec) return null;
  const [lines, revisions] = await Promise.all([loadLines(id), loadRevisions(rec.productCode)]);
  return buildPayload(rec, lines, revisions, batch);
}

// Editable header columns from a client payload. Identity / approval / revision /
// status columns are handled separately. `fallback` preserves the two required
// inputs (capsules per dose, capsule weight) when a partial update omits them.
function headerRow(body: any, fallback?: typeof mmrs.$inferSelect) {
  return {
    productName: String(body.productName ?? "").trim(),
    capsuleSpec: String(body.capsuleSpec ?? "").trim(),
    capsuleRmNumber: strOrNull(body.capsuleRmNumber),
    capsulesPerDose:
      body.capsulesPerDose != null && String(body.capsulesPerDose).trim() !== ""
        ? intOrFallback(body.capsulesPerDose, fallback?.capsulesPerDose ?? 1)
        : fallback?.capsulesPerDose ?? 1,
    capsuleWeightMg: numOrNull(body.capsuleWeightMg) ?? (fallback?.capsuleWeightMg ?? "0"),
    capsuleComponentId: strOrNull(body.capsuleComponentId),
    grossWeightToleranceLowPct: numOrNull(body.grossWeightToleranceLowPct),
    grossWeightToleranceHighPct: numOrNull(body.grossWeightToleranceHighPct),
    grossWeightLowMgOverride: numOrNull(body.grossWeightLowMgOverride),
    grossWeightHighMgOverride: numOrNull(body.grossWeightHighMgOverride),
    blendYieldMinPct: numOrNull(body.blendYieldMinPct),
    blendYieldMaxPct: numOrNull(body.blendYieldMaxPct),
    encapYieldMinPct: numOrNull(body.encapYieldMinPct),
    encapYieldMaxPct: numOrNull(body.encapYieldMaxPct),
    bottlingYieldMinPct: numOrNull(body.bottlingYieldMinPct),
    bottlingYieldMaxPct: numOrNull(body.bottlingYieldMaxPct),
    labelRevision: strOrNull(body.labelRevision),
  };
}

// Validate + normalise a potency input. Potency must be > 0 (it is a divisor).
function normalisePotency(v: unknown): string | { error: string } {
  const s = numOrNull(v);
  if (s == null) return "1";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { error: "Potency must be a number greater than zero (e.g. 0.97 for 97%)." };
  return s;
}

// Next numeric suffix for an MMI-###### ingredient-line id. Returns a generator so
// copying many lines at once (revision creation) yields contiguous unique ids.
async function lineIdSeed(): Promise<() => string> {
  const rows = await db.select({ id: mmrIngredients.id }).from(mmrIngredients);
  const re = /^MMI-(\d+)$/;
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max;
  return () => `MMI-${String(++n).padStart(6, "0")}`;
}

export default async (req: Request) => {
  const url = new URL(req.url);
  let callerEmail = "";

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });
    callerEmail = auth.email;
    const actor = auth.actor;
    const admin = roleAtLeast(auth.role, "Admin");
    const canApprove = roleAtLeast(auth.role, "Quality Manager");
    const canEdit = roleAtLeast(auth.role, "Member");

    // ── COMPUTE-YIELD (read-only; GET or POST) ───────────────────────────────
    // Handled BEFORE the mutation gate: it never writes, so it is available to any
    // authenticated user. POST is accepted so a full { lineId: weighoutTargetKg }
    // map can be supplied for the live weigh-out preview; GET keeps the simple
    // query-param form. Accepts a direct capsule figure (batch_size / capsules) or
    // bottles + bottle_count, and an optional round-up increment (kg).
    {
      const action = (url.searchParams.get("action") || "").toString();
      if ((action === "compute-yield" || action === "formula-card") && (req.method === "GET" || req.method === "POST")) {
        const id = url.searchParams.get("id");
        if (!id) return json(400, { error: "Missing MMR id." });
        const [rec] = await db.select().from(mmrs).where(eq(mmrs.id, id));
        if (!rec) return json(404, { error: "MMR not found." });
        const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        const pick = (b: any, q: string) => (b != null && String(b).trim() !== "" ? String(b).trim() : url.searchParams.get(q));
        const capsulesParam = pick(body.batchSize ?? body.capsulesPerBatch ?? body.capsules, "batch_size") ?? url.searchParams.get("capsules") ?? url.searchParams.get("batch");
        const bottlesParam = pick(body.bottles, "bottles");
        const bottleCountParam = pick(body.bottleCount, "bottle_count");
        const incrementParam = pick(body.weighoutIncrementKg ?? body.incrementKg, "increment");
        const weighouts: Record<string, any> | null =
          body.weighouts && typeof body.weighouts === "object" ? body.weighouts : null;
        const batch: any = {};
        if (capsulesParam != null && String(capsulesParam).trim() !== "") batch.capsulesPerBatch = String(capsulesParam).trim();
        if (bottlesParam != null && String(bottlesParam).trim() !== "") batch.bottles = String(bottlesParam).trim();
        if (bottleCountParam != null && String(bottleCountParam).trim() !== "") batch.bottleCount = String(bottleCountParam).trim();
        if (batch.capsulesPerBatch == null && !(batch.bottles != null && batch.bottleCount != null)) {
          return json(400, { error: "Provide a positive batch_size (capsules), or both bottles and bottle_count." });
        }
        const lines = await loadLines(id);

        if (action === "compute-yield") {
          let payload;
          try {
            payload = computeYieldPayload(rec, lines, batch, weighouts, incrementParam);
          } catch (e: any) {
            return json(400, { error: e?.message || "Could not compute yield." });
          }
          if (payload.capsulesPerBatch == null || payload.capsulesPerBatch <= 0) {
            return json(400, { error: "Resolved batch size must be a positive number of capsules." });
          }
          return json(200, payload);
        }

        // ── FORMULA CARD (server-side PDF) ────────────────────────────────────
        // Renders ONLY from the formula engine's output over the stored MMR data,
        // so it always agrees with the MMR view and the future BPR.
        let result;
        try {
          result = deriveFormula(formulaInputFor(rec, lines, batch, weighouts, incrementParam));
        } catch (e: any) {
          return json(400, { error: e?.message || "Could not compute the Formula Card." });
        }
        if (result.capsulesPerBatch == null || result.capsulesPerBatch <= 0) {
          return json(400, { error: "Resolved batch size must be a positive number of capsules." });
        }
        // GUARDRAIL: never present an under-formula weigh-out as an approved card.
        if (!result.weighoutValid) {
          return json(400, {
            error: "Cannot generate the Formula Card: one or more weigh-out targets are below the formula-exact minimum, which would under-deliver label claim. Raise the flagged weigh-out targets first.",
            weighoutErrors: result.weighoutErrors,
          });
        }
        const { renderFormulaCard } = await import("./lib/pdf.js");
        const generatedDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const pdf = await renderFormulaCard(buildFormulaCardData(rec, result, generatedDate));
        await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: { formulaCard: true, capsulesPerBatch: result.capsulesPerBatch } });
        const filename = `Formula-Card-${rec.id}.pdf`;
        return new Response(pdf, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${filename}"`,
            "Cache-Control": "no-store",
          },
        });
      }
    }

    // Every other non-GET route is a mutation and requires Member or above.
    if (req.method !== "GET" && !canEdit) {
      await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", detail: { method: req.method } });
      return json(403, { error: "Your role does not have access to modify Master Manufacturing Records." });
    }

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const id = url.searchParams.get("id");

      if (id) {
        const payload = await mmrPayload(id);
        if (!payload) return json(404, { error: "MMR not found." });
        return json(200, payload);
      }

      // List, filterable by product_code and status (indexed columns).
      const productCode = url.searchParams.get("product_code");
      const status = url.searchParams.get("status");
      const conds: any[] = [];
      if (productCode) conds.push(eq(mmrs.productCode, productCode));
      if (status) conds.push(eq(mmrs.status, status));
      const rows = await db
        .select()
        .from(mmrs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(mmrs.productCode), desc(mmrs.revision))
        .limit(1000);
      return json(200, rows.map(toClientMmr));
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = (url.searchParams.get("action") || "").toString();

      // ---- Line-level mutations (Draft only) ------------------------------
      if (id && (action === "add-line" || action === "update-line" || action === "remove-line" || action === "reorder-lines")) {
        const [rec] = await db.select().from(mmrs).where(eq(mmrs.id, id));
        if (!rec) return json(404, { error: "MMR not found." });
        if (LOCKED_STATUSES.has(rec.status)) {
          await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", recordId: id, detail: { attempted: action, status: rec.status } });
          return json(409, { error: lockedMessage(rec.status), conflict: true, locked: true });
        }
        const body = await req.json().catch(() => ({}));
        const now = new Date();

        if (action === "add-line") {
          const ingredientId = String(body.ingredientId ?? "").trim();
          if (!ingredientId) return json(400, { error: "ingredientId is required." });
          const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, ingredientId));
          if (!ing) return json(400, { error: "Referenced ingredient does not exist." });
          const potency = normalisePotency(body.potency);
          if (typeof potency !== "string") return json(400, { error: potency.error });
          // Append to the end of the bill unless an explicit order is given.
          const existingLines = await db.select({ lineOrder: mmrIngredients.lineOrder }).from(mmrIngredients).where(eq(mmrIngredients.mmrId, id));
          const nextOrder = body.lineOrder != null ? parseInt(String(body.lineOrder), 10) || 0 : existingLines.reduce((m, l) => Math.max(m, l.lineOrder ?? 0), 0) + 1;
          const nextId = await lineIdSeed();
          await db.insert(mmrIngredients).values({
            id: nextId(),
            mmrId: id,
            ingredientId,
            lineOrder: nextOrder,
            labelClaimMg: numOrNull(body.labelClaimMg) ?? "0",
            potency,
            overagePct: numOrNull(body.overagePct) ?? "0",
            notes: strOrNull(body.notes),
          });
          await db.update(mmrs).set({ modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
          await logChange(id, "line_added", `Added ingredient line (${ing.name})`, actor);
          await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: { lineAction: "add", ingredientId } });
          return json(200, await mmrPayload(id));
        }

        if (action === "update-line") {
          const lineId = String(body.lineId ?? body.id ?? "").trim();
          if (!lineId) return json(400, { error: "lineId is required." });
          const [line] = await db.select().from(mmrIngredients).where(and(eq(mmrIngredients.id, lineId), eq(mmrIngredients.mmrId, id)));
          if (!line) return json(404, { error: "Ingredient line not found on this MMR." });
          const patch: any = {};
          if (body.ingredientId != null && String(body.ingredientId).trim() !== "") {
            const ingredientId = String(body.ingredientId).trim();
            const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, ingredientId));
            if (!ing) return json(400, { error: "Referenced ingredient does not exist." });
            patch.ingredientId = ingredientId;
          }
          if (body.labelClaimMg != null) patch.labelClaimMg = numOrNull(body.labelClaimMg) ?? "0";
          if (body.potency != null) {
            const potency = normalisePotency(body.potency);
            if (typeof potency !== "string") return json(400, { error: potency.error });
            patch.potency = potency;
          }
          if (body.overagePct != null) patch.overagePct = numOrNull(body.overagePct) ?? "0";
          if (body.notes != null) patch.notes = strOrNull(body.notes);
          if (body.lineOrder != null) patch.lineOrder = parseInt(String(body.lineOrder), 10) || 0;
          await db.update(mmrIngredients).set(patch).where(eq(mmrIngredients.id, lineId));
          await db.update(mmrs).set({ modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
          await logChange(id, "line_updated", `Updated ingredient line ${lineId}`, actor);
          await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: { lineAction: "update", lineId } });
          return json(200, await mmrPayload(id));
        }

        if (action === "remove-line") {
          const lineId = String(body.lineId ?? body.id ?? "").trim();
          if (!lineId) return json(400, { error: "lineId is required." });
          const [line] = await db.select().from(mmrIngredients).where(and(eq(mmrIngredients.id, lineId), eq(mmrIngredients.mmrId, id)));
          if (!line) return json(404, { error: "Ingredient line not found on this MMR." });
          await db.delete(mmrIngredients).where(eq(mmrIngredients.id, lineId));
          await db.update(mmrs).set({ modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
          await logChange(id, "line_removed", `Removed ingredient line ${lineId}`, actor);
          await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: { lineAction: "remove", lineId } });
          return json(200, await mmrPayload(id));
        }

        // reorder-lines: body.order = [lineId, ...] → line_order = index + 1.
        const order: string[] = Array.isArray(body.order) ? body.order.map((x: any) => String(x)) : [];
        if (!order.length) return json(400, { error: "order must be a non-empty array of line ids." });
        for (let i = 0; i < order.length; i++) {
          await db.update(mmrIngredients).set({ lineOrder: i + 1 }).where(and(eq(mmrIngredients.id, order[i]), eq(mmrIngredients.mmrId, id)));
        }
        await db.update(mmrs).set({ modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
        await logChange(id, "lines_reordered", `Reordered ${order.length} ingredient lines`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: { lineAction: "reorder" } });
        return json(200, await mmrPayload(id));
      }

      // ---- Create a new revision (deep copy → Draft) ----------------------
      if (id && action === "create-revision") {
        const [src] = await db.select().from(mmrs).where(eq(mmrs.id, id));
        if (!src) return json(404, { error: "MMR not found." });
        // Next revision = max revision across the product code + 1.
        const siblings = await db.select({ revision: mmrs.revision }).from(mmrs).where(eq(mmrs.productCode, src.productCode));
        const nextRev = siblings.reduce((m, r) => Math.max(m, r.revision ?? 0), 0) + 1;
        const newId = mmrIdFor(src.productCode, nextRev);
        const [clash] = await db.select({ id: mmrs.id }).from(mmrs).where(eq(mmrs.id, newId));
        if (clash) return json(409, { error: `Revision ${nextRev} (${newId}) already exists.` });
        const now = new Date();
        const [created] = await db
          .insert(mmrs)
          .values({
            id: newId,
            productCode: src.productCode,
            productName: src.productName,
            revision: nextRev,
            status: "Draft",
            capsuleSpec: src.capsuleSpec,
            capsuleRmNumber: src.capsuleRmNumber,
            capsulesPerDose: src.capsulesPerDose,
            capsuleWeightMg: src.capsuleWeightMg,
            capsuleComponentId: src.capsuleComponentId,
            grossWeightToleranceLowPct: src.grossWeightToleranceLowPct,
            grossWeightToleranceHighPct: src.grossWeightToleranceHighPct,
            grossWeightLowMgOverride: src.grossWeightLowMgOverride,
            grossWeightHighMgOverride: src.grossWeightHighMgOverride,
            blendYieldMinPct: src.blendYieldMinPct,
            blendYieldMaxPct: src.blendYieldMaxPct,
            encapYieldMinPct: src.encapYieldMinPct,
            encapYieldMaxPct: src.encapYieldMaxPct,
            bottlingYieldMinPct: src.bottlingYieldMinPct,
            bottlingYieldMaxPct: src.bottlingYieldMaxPct,
            labelRevision: src.labelRevision,
            approvedBy: null,
            approvedAt: null,
            supersededBy: null,
            createdBy: actor,
            createdAt: now,
            modifiedBy: actor,
            modifiedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) return json(409, { error: "Revision id collision, please retry." });
        // Deep-copy every ingredient line (its stored INPUTS) into the new revision.
        const srcLines = await db.select().from(mmrIngredients).where(eq(mmrIngredients.mmrId, id)).orderBy(asc(mmrIngredients.lineOrder));
        if (srcLines.length) {
          const nextLineId = await lineIdSeed();
          await db.insert(mmrIngredients).values(
            srcLines.map((l) => ({
              id: nextLineId(),
              mmrId: newId,
              ingredientId: l.ingredientId,
              lineOrder: l.lineOrder,
              labelClaimMg: l.labelClaimMg,
              potency: l.potency,
              overagePct: l.overagePct,
              notes: l.notes,
            })),
          );
        }
        await logChange(newId, "revision_created", `Created revision ${nextRev} from ${id}`, actor);
        await logChange(id, "revision_spawned", `Revision ${nextRev} (${newId}) created from this record`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "mmr_revision_created", recordType: "MMR", recordId: newId, detail: { from: id, revision: nextRev } });
        return json(201, await mmrPayload(newId));
      }

      // ---- Approve (Quality Manager+) -------------------------------------
      if (id && action === "approve") {
        const [rec] = await db.select().from(mmrs).where(eq(mmrs.id, id));
        if (!rec) return json(404, { error: "MMR not found." });
        if (!canApprove) {
          await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", recordId: id, detail: { attempted: "approve" } });
          return json(403, { error: "Approving an MMR requires the Quality Manager role or above." });
        }
        if (rec.status === "Approved") return json(409, { error: "This MMR is already Approved." });
        if (rec.status === "Superseded") return json(409, { error: "A superseded revision cannot be approved." });
        const now = new Date();
        // Enforce single Approved revision per product_code: supersede any current
        // Approved revision, pointing its superseded_by at this new revision.
        const priorApproved = await db.select().from(mmrs).where(and(eq(mmrs.productCode, rec.productCode), eq(mmrs.status, "Approved"), ne(mmrs.id, id)));
        for (const prior of priorApproved) {
          await db.update(mmrs).set({ status: "Superseded", supersededBy: id, modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, prior.id));
          await logChange(prior.id, "superseded", `Superseded by ${id} on approval of revision ${rec.revision}`, actor);
          await logAction({ email: auth.email, role: auth.role, action: "mmr_superseded", recordType: "MMR", recordId: prior.id, detail: { supersededBy: id } });
        }
        await db.update(mmrs).set({ status: "Approved", approvedBy: actor, approvedAt: now, modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
        await logChange(id, "approved", `Approved revision ${rec.revision} by ${actor}`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "mmr_approved", recordType: "MMR", recordId: id, detail: { revision: rec.revision, supersededPrior: priorApproved.map((p) => p.id) } });
        return json(200, await mmrPayload(id));
      }

      // ---- Supersede / retire (Quality Manager+) --------------------------
      if (id && action === "supersede") {
        const [rec] = await db.select().from(mmrs).where(eq(mmrs.id, id));
        if (!rec) return json(404, { error: "MMR not found." });
        if (!canApprove) {
          await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", recordId: id, detail: { attempted: "supersede" } });
          return json(403, { error: "Superseding an MMR requires the Quality Manager role or above." });
        }
        if (rec.status === "Superseded") return json(409, { error: "This MMR is already Superseded." });
        const body = await req.json().catch(() => ({}));
        const supersededBy = body.supersededBy == null || String(body.supersededBy).trim() === "" ? null : String(body.supersededBy).trim();
        const now = new Date();
        await db.update(mmrs).set({ status: "Superseded", supersededBy, modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id));
        await logChange(id, "superseded", `Superseded${supersededBy ? ` by ${supersededBy}` : ""}`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "mmr_superseded", recordType: "MMR", recordId: id, detail: { supersededBy } });
        return json(200, await mmrPayload(id));
      }

      // ---- Create a new MMR (Draft) ---------------------------------------
      const body = await req.json().catch(() => ({}));
      const productCode = String(body.productCode ?? "").trim();
      const productName = String(body.productName ?? "").trim();
      if (!productCode) return json(400, { error: "productCode is required." });
      if (!productName) return json(400, { error: "productName is required." });
      const token = codeToken(productCode);
      if (!token) return json(400, { error: "productCode must contain at least one letter or digit." });
      const revision = body.revision != null && Number.isFinite(parseInt(String(body.revision), 10)) ? Math.max(1, parseInt(String(body.revision), 10)) : 1;
      const newId = mmrIdFor(productCode, revision);
      const now = new Date();
      const [created] = await db
        .insert(mmrs)
        .values({
          id: newId,
          productCode,
          productName,
          revision,
          status: "Draft",
          ...headerRow(body),
          createdBy: actor,
          createdAt: now,
          modifiedBy: actor,
          modifiedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: `An MMR with id ${newId} already exists (same product code + revision).` });
      await logChange(newId, "create", `Created MMR ${productName} rev ${revision}`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_created", recordType: "MMR", recordId: newId, detail: { productCode, revision } });
      return json(201, await mmrPayload(newId));
    }

    // ── PUT (header update, Draft only, optimistic concurrency) ─────────────
    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing MMR id." });
      const [existing] = await db.select().from(mmrs).where(eq(mmrs.id, id));
      if (!existing) return json(404, { error: "MMR not found." });

      // Immutability: an Approved / Superseded MMR cannot be edited.
      if (LOCKED_STATUSES.has(existing.status)) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", recordId: id, detail: { attempted: "update", status: existing.status } });
        return json(409, { error: lockedMessage(existing.status), conflict: true, locked: true });
      }

      const body = await req.json().catch(() => ({}));

      // Optimistic concurrency.
      const expectedModifiedAt = body.expected_modified_at ?? body.expectedModifiedAt;
      if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
        await logAction({ email: auth.email, role: auth.role, action: "concurrency_conflict_rejected", recordType: "MMR", recordId: existing.id, detail: { expected: expectedModifiedAt, actual: existing.modifiedAt } });
        return conflictResponse({ currentRecord: toClientMmr(existing), lastModifiedBy: existing.modifiedBy || "", lastModifiedAt: existing.modifiedAt, attemptedChanges: body });
      }

      // Status transitions via PUT are limited to Draft ↔ Under Review. Approval
      // and supersession must go through their dedicated actions so their role
      // gates and side effects are enforced.
      const patch: any = { ...headerRow(body, existing) };
      if (!patch.productName) return json(400, { error: "productName is required." });
      if (body.status != null) {
        const target = String(body.status).trim();
        if (!STATUSES.has(target)) return json(400, { error: "Invalid status." });
        if (target === "Approved" || target === "Superseded") {
          return json(400, { error: "Use the approve / supersede action to change to that status." });
        }
        patch.status = target;
      }
      const now = new Date();
      const [updated] = await db.update(mmrs).set({ ...patch, modifiedBy: actor, modifiedAt: now }).where(eq(mmrs.id, id)).returning();
      if (existing.status !== updated.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${updated.status}`, actor);
      }
      await logChange(id, "update", "MMR header saved", actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "MMR", recordId: id, detail: {} });
      return json(200, await mmrPayload(id));
    }

    // ── DELETE (Admin, Draft only) ──────────────────────────────────────────
    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing MMR id." });
      const [existing] = await db.select().from(mmrs).where(eq(mmrs.id, id));
      if (!existing) return json(404, { error: "MMR not found." });
      if (!admin) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "MMR", recordId: id, detail: { attempted: "delete" } });
        return json(403, { error: "Only an administrator can delete an MMR." });
      }
      // Only a Draft may be deleted; anything else is part of the controlled record.
      if (existing.status !== "Draft") {
        return json(409, { error: `Only a Draft MMR may be deleted. This MMR is ${existing.status}; supersede it instead.`, conflict: true });
      }
      await db.delete(mmrIngredients).where(eq(mmrIngredients.mmrId, id));
      await db.delete(mmrs).where(eq(mmrs.id, id));
      await logChange(id, "delete", `Deleted Draft MMR ${id}`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_deleted", recordType: "MMR", recordId: id, detail: {} });
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    console.error("[mmrs] Unhandled handler error", { message: err?.message, stack: err?.stack, method: req.method, id: url.searchParams.get("id") || "", action: url.searchParams.get("action") || "", email: callerEmail });
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/mmrs",
};
