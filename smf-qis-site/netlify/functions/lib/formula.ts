// netlify/functions/lib/formula.ts
//
// THE single source of truth for every MMR / batch derivation. No other file —
// not the API, not the UI, not the future BPR generator — may re-implement any of
// this arithmetic. Every computed quantity flows out of this module.
//
// WHY: the MMR ingredient bill stores only true INPUTS (label claim, potency,
// overage) plus MMR-level inputs (capsules per dose, capsule weight, tolerance).
// Everything else — potency-adjusted mg, total mg per dose, mg per capsule, gross
// weight target/low/high, per-ingredient batch kg, and the theoretical blend
// weight — is DERIVED here. Storing a derived quantity is the defect this replaces:
// it let a potency correction fail to propagate and let two sheets of one record
// disagree about the same weight.
//
// EXACTNESS: all arithmetic is exact rational math on BigInt numerator/denominator
// pairs. Division (label ÷ potency, ÷ capsules per dose, ÷ doses) is therefore
// exact — no floating point, no guard-digit truncation. Rounding happens exactly
// ONCE, in render(), at the final step. There is exactly one computation of the
// theoretical blend weight in the codebase and it lives in deriveFormula().

// ── EXACT RATIONAL ARITHMETIC ────────────────────────────────────────────────
// value = n / d, with d > 0 and the fraction kept in lowest terms.
interface Rat {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1n;
}

function rat(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new Error("formula engine: division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

// Parse a decimal string / number-ish input into an exact rational. Empty / null
// becomes 0. Rejects anything that is not a plain decimal number.
export function ratFromDecimal(input: unknown): Rat {
  let s = String(input ?? "").trim();
  if (s === "") s = "0";
  let neg = false;
  if (s[0] === "+") s = s.slice(1);
  else if (s[0] === "-") {
    neg = true;
    s = s.slice(1);
  }
  if (!/^\d*(\.\d*)?$/.test(s)) throw new Error("formula engine: invalid decimal value: " + String(input));
  const dot = s.indexOf(".");
  const intPart = (dot >= 0 ? s.slice(0, dot) : s) || "0";
  const fracPart = dot >= 0 ? s.slice(dot + 1) : "";
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
  let n = BigInt(digits);
  if (neg) n = -n;
  return rat(n, 10n ** BigInt(fracPart.length));
}

function ratFromInt(i: number | bigint): Rat {
  return { n: BigInt(i), d: 1n };
}

function addR(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}
function subR(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}
function mulR(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}
function divR(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new Error("formula engine: division by zero");
  return rat(a.n * b.d, a.d * b.n);
}

// Sign of (a − b): -1, 0, or 1. Exact.
function cmpR(a: Rat, b: Rat): number {
  const l = a.n * b.d;
  const r = b.n * a.d; // both denominators are > 0, so no sign flip
  return l < r ? -1 : l > r ? 1 : 0;
}

// Smallest multiple of `increment` that is >= `value` (ceil to increment). Exact.
// With increment <= 0 this is a no-op (returns value unchanged).
function ceilToIncrement(value: Rat, increment: Rat): Rat {
  if (increment.n <= 0n) return value;
  // k = ceil(value / increment); result = k * increment
  const q = divR(value, increment); // value/increment as a rational
  // ceil of q = floor + (remainder>0 ? 1 : 0); q.n/q.d with q.d>0
  let k = q.n / q.d;
  if (q.n % q.d !== 0n) k += 1n; // strictly positive remainder → round up
  return mulR({ n: k, d: 1n }, increment);
}

// Render an exact rational to `places` fractional digits, half-up. This is the ONE
// and ONLY place any rounding occurs.
export function render(r: Rat, places: number): string {
  const neg = r.n < 0n;
  let n = neg ? -r.n : r.n;
  const scale = 10n ** BigInt(places);
  const scaled = n * scale;
  let q = scaled / r.d;
  const rem = scaled % r.d;
  if (rem * 2n >= r.d) q += 1n; // half-up
  let str = q.toString();
  let out: string;
  if (places === 0) {
    out = str;
  } else {
    str = str.padStart(places + 1, "0");
    const cut = str.length - places;
    out = str.slice(0, cut) + "." + str.slice(cut);
  }
  return neg && q !== 0n ? "-" + out : out;
}

// Rounding precision for every rendered value (final step only).
const MG_PLACES = 4; // mg quantities (per dose, per capsule, gross weights)
const KG_PLACES = 4; // batch kilograms and the theoretical blend weight

// ── PUBLIC INPUT / OUTPUT SHAPES ─────────────────────────────────────────────
export interface IngredientLineInput {
  // Carried through untouched so callers can correlate results back to their rows.
  id?: string;
  ingredientId?: string;
  ingredientName?: string;
  itemNumber?: string | null;
  lineOrder?: number;
  // The three true INPUTS.
  labelClaimMg: string | number;
  potency: string | number; // decimal, e.g. 0.97
  overagePct: string | number; // FORMULA overage, decimal, e.g. 0.05 (sacred minimum)
  // OPTIONAL weigh-out controls (batch-time, not part of the MMR template):
  //   weighoutTargetKg — an explicit clean floor target for this line, OR
  //   weighoutIncrementKg — round the formula quantity UP to this increment.
  // An explicit target takes precedence over an increment. Both are validated
  // against the never-short guardrail (weigh-out must be >= formula-exact).
  weighoutTargetKg?: string | number | null;
  weighoutIncrementKg?: string | number | null;
}

export interface BatchSizeInput {
  // Provide either a direct capsule figure, or bottles × bottleCount. The other is
  // derived. capsulesPerBatch wins if both are supplied.
  capsulesPerBatch?: string | number | null;
  bottles?: string | number | null;
  bottleCount?: string | number | null; // capsules per bottle
}

export interface FormulaInput {
  capsulesPerDose: string | number; // integer >= 1
  capsuleWeightMg: string | number;
  toleranceLowPct?: string | number | null; // decimal, e.g. 0.05
  toleranceHighPct?: string | number | null;
  grossWeightLowMgOverride?: string | number | null;
  grossWeightHighMgOverride?: string | number | null;
  lines: IngredientLineInput[];
  batch?: BatchSizeInput | null;
  // Default weigh-out round-up increment (kg) applied to every line that has no
  // explicit per-line target or increment. Optional.
  weighoutIncrementKg?: string | number | null;
}

export interface ComputedLine {
  id?: string;
  ingredientId?: string;
  ingredientName?: string;
  itemNumber?: string | null;
  lineOrder?: number;
  // Echoed inputs (as provided).
  labelClaimMg: string | number;
  potency: string | number;
  overagePct: string | number;
  // Derived, rendered.
  potencyAdjustedMg: string;
  totalMgPerDose: string;
  mgPerCapsule: string;
  // Present only when a batch size was supplied. formulaBatchQtyKg is the SACRED
  // minimum for this line; batchQuantityKg is kept as an alias for back-compat.
  formulaBatchQtyKg: string | null;
  batchQuantityKg: string | null;
  // Weigh-out (present only when a batch size was supplied):
  weighoutTargetKg: string | null; // what actually goes to the floor for this line
  manufacturingOverageKg: string | null; // weigh-out − formula (the cushion)
  manufacturingOveragePct: string | null; // cushion as % of the formula minimum
  weighoutShort: boolean; // true → weigh-out is BELOW the formula minimum (error)
  weighoutShortfallKg: string | null; // how far below, when short
}

export interface FormulaResult {
  lines: ComputedLine[];
  totalMgPerDoseAll: string;
  mgPerCapsuleAll: string;
  grossWeightTargetMg: string;
  grossWeightLowMg: string | null;
  grossWeightHighMg: string | null;
  // Batch results — null when no batch size was supplied.
  capsulesPerBatch: number | null;
  bottles: number | null;
  bottleCount: number | null;
  dosesPerBatch: string | null;
  // FORMULA minimum sum: Σ formula-exact kg — the proven-satisfied minimum. This
  // is NOT the charged weight and NOT the yield basis.
  formulaMinimumSumKg: string | null;
  // CHARGED weight: Σ weigh-out kg — the blend that goes to the floor and the
  // basis for blending yield.
  chargedWeightKg: string | null;
  // Never-short guardrail result across all lines.
  weighoutValid: boolean;
  weighoutErrors: string[];
  // Back-compat alias (= formulaMinimumSumKg): the summed formula-exact weight.
  theoreticalBlendWeightKg: string | null;
}

// ── THE DERIVATIONS ──────────────────────────────────────────────────────────
// Per ingredient line, as exact rationals:
//   potency_adjusted_mg = label_claim_mg / potency
//   total_mg_per_dose   = potency_adjusted_mg × (1 + overage_pct)
//   mg_per_capsule      = total_mg_per_dose / capsules_per_dose
function deriveLineRats(line: IngredientLineInput, capsulesPerDose: Rat) {
  const claim = ratFromDecimal(line.labelClaimMg);
  const potency = ratFromDecimal(line.potency);
  if (potency.n === 0n) throw new Error("formula engine: potency must be greater than zero");
  const overage = ratFromDecimal(line.overagePct);
  const potencyAdjusted = divR(claim, potency);
  const totalPerDose = mulR(potencyAdjusted, addR(ratFromInt(1), overage));
  const mgPerCapsule = divR(totalPerDose, capsulesPerDose);
  return { potencyAdjusted, totalPerDose, mgPerCapsule };
}

// Resolve the batch size into an exact capsules-per-batch rational plus the
// bottles / bottleCount pair (the missing one derived). Returns null if no usable
// batch figure was supplied.
function resolveBatch(b: BatchSizeInput | null | undefined): { capsules: Rat; bottles: Rat | null; bottleCount: Rat | null } | null {
  if (!b) return null;
  const hasCaps = b.capsulesPerBatch != null && String(b.capsulesPerBatch).trim() !== "";
  const hasBottles = b.bottles != null && String(b.bottles).trim() !== "";
  const hasCount = b.bottleCount != null && String(b.bottleCount).trim() !== "";
  let capsules: Rat | null = null;
  let bottles: Rat | null = hasBottles ? ratFromDecimal(b.bottles) : null;
  let bottleCount: Rat | null = hasCount ? ratFromDecimal(b.bottleCount) : null;

  if (hasCaps) {
    capsules = ratFromDecimal(b.capsulesPerBatch);
    // Derive the missing side of the bottles pair when possible.
    if (bottleCount && bottleCount.n !== 0n && !bottles) bottles = divR(capsules, bottleCount);
    else if (bottles && bottles.n !== 0n && !bottleCount) bottleCount = divR(capsules, bottles);
  } else if (bottles && bottleCount) {
    capsules = mulR(bottles, bottleCount);
  } else {
    return null;
  }
  return { capsules, bottles, bottleCount };
}

// Best-effort integer render for whole-count batch figures (capsules/bottles).
function ratToIntOrNull(r: Rat | null): number | null {
  if (!r) return null;
  // Exact integer only when the denominator divides evenly.
  if (r.n % r.d === 0n) return Number(r.n / r.d);
  return Number(render(r, 0)); // rounded whole count for display
}

// THE single derivation. Everything the app shows or the BPR prints comes from here.
export function deriveFormula(input: FormulaInput): FormulaResult {
  const capsulesPerDose = ratFromDecimal(input.capsulesPerDose);
  if (capsulesPerDose.n === 0n) throw new Error("formula engine: capsules_per_dose must be at least 1");
  const capsuleWeight = ratFromDecimal(input.capsuleWeightMg);

  const batch = resolveBatch(input.batch);
  const dosesPerBatch = batch ? divR(batch.capsules, capsulesPerDose) : null;

  let totalPerDoseAll: Rat = ratFromInt(0);
  let formulaSumKg: Rat = ratFromInt(0); // Σ formula-exact kg — the proven minimum
  let chargedSumKg: Rat = ratFromInt(0); // Σ weigh-out kg — the charged weight
  const million = ratFromInt(1000000);
  const weighoutErrors: string[] = [];
  const defaultIncrement =
    input.weighoutIncrementKg != null && String(input.weighoutIncrementKg).trim() !== "" ? ratFromDecimal(input.weighoutIncrementKg) : null;

  const lines: ComputedLine[] = input.lines.map((line) => {
    const { potencyAdjusted, totalPerDose, mgPerCapsule } = deriveLineRats(line, capsulesPerDose);
    totalPerDoseAll = addR(totalPerDoseAll, totalPerDose);

    let formulaBatchQtyKg: string | null = null;
    let weighoutTargetKg: string | null = null;
    let manufacturingOverageKg: string | null = null;
    let manufacturingOveragePct: string | null = null;
    let weighoutShort = false;
    let weighoutShortfallKg: string | null = null;

    if (dosesPerBatch) {
      // formula_batch_qty_kg = total_mg_per_dose × doses_per_batch / 1,000,000 — the
      // SACRED minimum for this ingredient. Kept exact for the guardrail comparison.
      const formulaKg = divR(mulR(totalPerDose, dosesPerBatch), million);
      formulaSumKg = addR(formulaSumKg, formulaKg);
      formulaBatchQtyKg = render(formulaKg, KG_PLACES);

      // Weigh-out target: explicit per-line value wins; else round the formula
      // quantity UP to the per-line or default increment; else = the formula qty.
      const hasExplicit = line.weighoutTargetKg != null && String(line.weighoutTargetKg).trim() !== "";
      const lineIncrement =
        line.weighoutIncrementKg != null && String(line.weighoutIncrementKg).trim() !== "" ? ratFromDecimal(line.weighoutIncrementKg) : defaultIncrement;
      let weighKg: Rat;
      if (hasExplicit) {
        weighKg = ratFromDecimal(line.weighoutTargetKg);
      } else if (lineIncrement) {
        weighKg = ceilToIncrement(formulaKg, lineIncrement);
      } else {
        weighKg = formulaKg;
      }

      // Never-short guardrail: weigh-out must be >= the formula-exact minimum.
      const cmp = cmpR(weighKg, formulaKg);
      if (cmp < 0) {
        weighoutShort = true;
        const shortfall = subR(formulaKg, weighKg);
        weighoutShortfallKg = render(shortfall, KG_PLACES);
        const name = line.ingredientName || line.ingredientId || line.id || "ingredient line";
        weighoutErrors.push(
          `${name}: weigh-out target ${render(weighKg, KG_PLACES)} kg is BELOW the formula-exact minimum ${render(formulaKg, KG_PLACES)} kg (short by ${weighoutShortfallKg} kg). This would under-deliver label claim; raise the weigh-out target to at least ${render(formulaKg, KG_PLACES)} kg.`,
        );
      }

      chargedSumKg = addR(chargedSumKg, weighKg);
      weighoutTargetKg = render(weighKg, KG_PLACES);
      const cushion = subR(weighKg, formulaKg);
      manufacturingOverageKg = render(cushion, KG_PLACES);
      // Cushion as a percentage of the formula minimum (0 if formula is 0).
      manufacturingOveragePct = formulaKg.n === 0n ? "0.00" : render(mulR(divR(cushion, formulaKg), ratFromInt(100)), 2);
    }

    return {
      id: line.id,
      ingredientId: line.ingredientId,
      ingredientName: line.ingredientName,
      itemNumber: line.itemNumber ?? null,
      lineOrder: line.lineOrder,
      labelClaimMg: line.labelClaimMg,
      potency: line.potency,
      overagePct: line.overagePct,
      potencyAdjustedMg: render(potencyAdjusted, MG_PLACES),
      totalMgPerDose: render(totalPerDose, MG_PLACES),
      mgPerCapsule: render(mgPerCapsule, MG_PLACES),
      formulaBatchQtyKg,
      batchQuantityKg: formulaBatchQtyKg, // back-compat alias
      weighoutTargetKg,
      manufacturingOverageKg,
      manufacturingOveragePct,
      weighoutShort,
      weighoutShortfallKg,
    };
  });

  // Per-MMR derivations.
  const mgPerCapsuleAll = divR(totalPerDoseAll, capsulesPerDose);
  const target = addR(mgPerCapsuleAll, capsuleWeight);

  // Gross weight low/high: absolute override wins; otherwise derive from target and
  // the (asymmetric) tolerance percentage. Null when neither is available.
  const lowOverride = input.grossWeightLowMgOverride;
  const highOverride = input.grossWeightHighMgOverride;
  const hasLowOverride = lowOverride != null && String(lowOverride).trim() !== "";
  const hasHighOverride = highOverride != null && String(highOverride).trim() !== "";
  const hasTolLow = input.toleranceLowPct != null && String(input.toleranceLowPct).trim() !== "";
  const hasTolHigh = input.toleranceHighPct != null && String(input.toleranceHighPct).trim() !== "";

  let lowRat: Rat | null = null;
  if (hasLowOverride) lowRat = ratFromDecimal(lowOverride);
  else if (hasTolLow) lowRat = mulR(target, subR(ratFromInt(1), ratFromDecimal(input.toleranceLowPct)));

  let highRat: Rat | null = null;
  if (hasHighOverride) highRat = ratFromDecimal(highOverride);
  else if (hasTolHigh) highRat = mulR(target, addR(ratFromInt(1), ratFromDecimal(input.toleranceHighPct)));

  return {
    lines,
    totalMgPerDoseAll: render(totalPerDoseAll, MG_PLACES),
    mgPerCapsuleAll: render(mgPerCapsuleAll, MG_PLACES),
    grossWeightTargetMg: render(target, MG_PLACES),
    grossWeightLowMg: lowRat ? render(lowRat, MG_PLACES) : null,
    grossWeightHighMg: highRat ? render(highRat, MG_PLACES) : null,
    capsulesPerBatch: batch ? ratToIntOrNull(batch.capsules) : null,
    bottles: batch ? ratToIntOrNull(batch.bottles) : null,
    bottleCount: batch ? ratToIntOrNull(batch.bottleCount) : null,
    dosesPerBatch: dosesPerBatch ? render(dosesPerBatch, 4) : null,
    formulaMinimumSumKg: dosesPerBatch ? render(formulaSumKg, KG_PLACES) : null,
    chargedWeightKg: dosesPerBatch ? render(chargedSumKg, KG_PLACES) : null,
    weighoutValid: weighoutErrors.length === 0,
    weighoutErrors,
    theoreticalBlendWeightKg: dosesPerBatch ? render(formulaSumKg, KG_PLACES) : null,
  };
}

// ── STAGE-YIELD EVALUATORS (single source of truth for the execution build) ──
// These are pure, generic classifiers with no product-specific hard-coding. The
// three stages are deliberately treated differently:
//   • blending  — mass reconciliation, investigate-or-escalate BOTH directions
//   • encapsulation — informational estimated count, NEVER gates
//   • bottling  — finished-bottle count reconciliation with a tolerance band
// The MMR stores the acceptance bands; the batch-execution build feeds actual
// recovered weights / counts into these functions.

export type BlendingStatus = "proceed" | "dispositioned" | "escalate";
export interface BlendingYieldResult {
  yieldPct: string; // recovered ÷ charged × 100, 2 dp
  direction: "in-band" | "low" | "high";
  status: BlendingStatus;
  requiresInvestigation: boolean;
  message: string;
}

// Blending yield = recovered blend weight ÷ CHARGED weight (the weigh-out sum).
// Within [minPct, maxPct] → proceed. Outside in EITHER direction → a deviation
// condition requiring an assignable cause: if a cause is documented it is
// dispositioned; if not, it escalates. Over-recovery is NOT an automatic hard
// fail — it is investigated like any other out-of-band condition.
export function evaluateBlendingYield(
  chargedWeightKg: string | number,
  recoveredWeightKg: string | number,
  minPct: string | number | null | undefined,
  maxPct: string | number | null | undefined,
  causeDocumented?: string | null,
): BlendingYieldResult {
  const charged = ratFromDecimal(chargedWeightKg);
  if (charged.n <= 0n) throw new Error("formula engine: charged weight must be greater than zero to evaluate blending yield");
  const recovered = ratFromDecimal(recoveredWeightKg);
  const yieldRat = mulR(divR(recovered, charged), ratFromInt(100));
  const yieldPct = render(yieldRat, 2);

  const hasMin = minPct != null && String(minPct).trim() !== "";
  const hasMax = maxPct != null && String(maxPct).trim() !== "";
  const belowMin = hasMin ? cmpR(yieldRat, ratFromDecimal(minPct)) < 0 : false;
  const aboveMax = hasMax ? cmpR(yieldRat, ratFromDecimal(maxPct)) > 0 : false;

  if (!belowMin && !aboveMax) {
    return { yieldPct, direction: "in-band", status: "proceed", requiresInvestigation: false, message: `Blending yield ${yieldPct}% is within the acceptable band — proceed.` };
  }
  const direction: "low" | "high" = belowMin ? "low" : "high";
  const hasCause = causeDocumented != null && String(causeDocumented).trim() !== "";
  const dirText =
    direction === "low"
      ? `below the acceptable band (${yieldPct}%)`
      : `over the charged weight (${yieldPct}%) — more often a sign of unaccounted material`;
  if (hasCause) {
    return {
      yieldPct,
      direction,
      status: "dispositioned",
      requiresInvestigation: true,
      message: `Blending yield is ${dirText}. Assignable cause documented ("${String(causeDocumented).trim()}") — deviation dispositioned.`,
    };
  }
  return {
    yieldPct,
    direction,
    status: "escalate",
    requiresInvestigation: true,
    message: `Blending yield is ${dirText}. No assignable cause — ESCALATE for investigation.`,
  };
}

export interface EncapsulationResult {
  estimatedCapsules: number; // informational estimate from blend mass
  gates: false; // encapsulation NEVER gates
  status: "informational";
  message: string;
}

// Encapsulation is an informational estimate only: how many capsules the blend
// mass could yield at the per-capsule gross target. It NEVER gates the batch.
export function evaluateEncapsulation(blendWeightKg: string | number, grossWeightTargetMg: string | number): EncapsulationResult {
  const target = ratFromDecimal(grossWeightTargetMg);
  if (target.n <= 0n) throw new Error("formula engine: gross weight target must be greater than zero to estimate capsule count");
  // capsules = blend_mg / gross_target_mg = (kg × 1e6) / mg
  const blendMg = mulR(ratFromDecimal(blendWeightKg), ratFromInt(1000000));
  const est = divR(blendMg, target);
  const estimatedCapsules = Number(render(est, 0));
  return { estimatedCapsules, gates: false, status: "informational", message: `Estimated ~${estimatedCapsules.toLocaleString()} capsules from the blend (informational; does not gate).` };
}

export interface BottlingResult {
  variancePct: string; // (actual − expected) ÷ expected × 100, 2 dp
  withinTolerance: boolean;
  status: "in-tolerance" | "out-of-tolerance";
  message: string;
}

// Bottling is a TRUE finished-bottle count reconciliation of the actual bottle
// count against the count expected from the blend, within a tolerance band.
export function evaluateBottling(actualBottles: string | number, expectedBottles: string | number, tolerancePct: string | number): BottlingResult {
  const expected = ratFromDecimal(expectedBottles);
  if (expected.n <= 0n) throw new Error("formula engine: expected bottle count must be greater than zero");
  const actual = ratFromDecimal(actualBottles);
  const varRat = mulR(divR(subR(actual, expected), expected), ratFromInt(100));
  const variancePct = render(varRat, 2);
  const tol = ratFromDecimal(tolerancePct);
  // |variance| <= tolerance
  const absVar = varRat.n < 0n ? { n: -varRat.n, d: varRat.d } : varRat;
  const withinTolerance = cmpR(absVar, tol) <= 0;
  return {
    variancePct,
    withinTolerance,
    status: withinTolerance ? "in-tolerance" : "out-of-tolerance",
    message: withinTolerance
      ? `Bottle count variance ${variancePct}% is within ±${String(tolerancePct)}% — reconciled.`
      : `Bottle count variance ${variancePct}% exceeds ±${String(tolerancePct)}% — reconcile against expected-from-blend before release.`,
  };
}
