// REST API for the QIS Ingredient Master, backed by Netlify Database.
//
// Ingredients are the controlled catalogue of raw materials / actives that an MMR
// formula draws its lines from — the first link in the batch-record data chain
// (Supplier → Ingredient → Formula (MMR) → Batch → BPR). Suppliers do not exist
// yet, so `supplier_id` is a reserved, nullable column with no FK constraint.
//
// Routes (all under /api/ingredients):
//   GET    /api/ingredients                       → list all ingredients
//   GET    /api/ingredients?id=ING-000001         → one ingredient
//   GET    /api/ingredients?action=search&q=<txt> → search by name / item number
//   POST   /api/ingredients                       → create (Member+)
//   PUT    /api/ingredients?id=...                → update (Member+, optimistic concurrency)
//   DELETE /api/ingredients?id=...                → delete (Admin; 409 if referenced by an MMR)
//
// created_by / modified_by are always stamped from the signed-in identity (full
// name + title), never the request body. Every mutation writes the per-record
// history to `audit_log` and the access-control event to `action_log`.
import type { Config } from "@netlify/functions";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ingredients, mmrIngredients, auditLog } from "../../db/schema.js";
import { getAuth, roleAtLeast, logAction, concurrencyMatches, conflictResponse, jsonResponse as json } from "./lib/auth.js";

// Canonical dispense units offered by the master.
const UNITS = new Set(["kg", "g", "mg", "each"]);

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

async function logChange(id: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: id, action, detail, changedBy: user || "Unknown" });
}

// Shape an ingredient row for the client. supplier_id / item_number are surfaced
// as null when unset (reserved / optional), never coerced to "".
function toClient(r: typeof ingredients.$inferSelect) {
  return {
    id: r.id,
    itemNumber: r.itemNumber ?? null,
    name: r.name || "",
    supplierId: r.supplierId ?? null,
    defaultUnit: r.defaultUnit || "g",
    notes: r.notes || "",
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

// Next "ING-######" id — the highest existing trailing number + 1, zero-padded to
// six digits. Scans ids of the form ING-<n> so the running number is contiguous.
async function nextIngredientId(): Promise<string> {
  const rows = await db.select({ id: ingredients.id }).from(ingredients);
  const re = /^ING-(\d+)$/;
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `ING-${String(max + 1).padStart(6, "0")}`;
}

// Normalise a client payload onto the editable columns. Identity / audit columns
// are stamped separately. supplier_id / item_number are stored as null when blank.
function toRow(body: any) {
  const unitRaw = String(body.defaultUnit ?? "").trim();
  const unit = UNITS.has(unitRaw) ? unitRaw : "g";
  const itemNumber = body.itemNumber == null || String(body.itemNumber).trim() === "" ? null : String(body.itemNumber).trim();
  const supplierId = body.supplierId == null || String(body.supplierId).trim() === "" ? null : String(body.supplierId).trim();
  return {
    itemNumber,
    name: String(body.name ?? "").trim(),
    supplierId,
    defaultUnit: unit,
    notes: String(body.notes ?? "").trim(),
  };
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
    const canEdit = roleAtLeast(auth.role, "Member");

    // Every non-GET route is a mutation and requires Member or above.
    if (req.method !== "GET" && !canEdit) {
      await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Ingredient", detail: { method: req.method } });
      return json(403, { error: "Your role does not have access to modify ingredients." });
    }

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const action = (url.searchParams.get("action") || "").toString();

      if (id) {
        const [rec] = await db.select().from(ingredients).where(eq(ingredients.id, id));
        if (!rec) return json(404, { error: "Ingredient not found." });
        return json(200, toClient(rec));
      }

      // Search by name (or item number) — used by the MMR editor's ingredient
      // picker. Case-insensitive substring match, capped at 50 rows.
      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json(200, []);
        const like = `%${q}%`;
        const rows = await db
          .select()
          .from(ingredients)
          .where(or(ilike(ingredients.name, like), ilike(ingredients.itemNumber, like)))
          .orderBy(asc(ingredients.name))
          .limit(50);
        return json(200, rows.map(toClient));
      }

      // Full list, ordered by name, capped at 1000.
      const rows = await db.select().from(ingredients).orderBy(asc(ingredients.name)).limit(1000);
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const row = toRow(body);
      if (!row.name) return json(400, { error: "Ingredient name is required." });

      const now = new Date();
      const newId = await nextIngredientId();
      const [created] = await db
        .insert(ingredients)
        .values({ id: newId, ...row, createdBy: actor, createdAt: now, modifiedBy: actor, modifiedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "Ingredient id collision, please retry." });
      await logChange(newId, "create", `Created ingredient "${created.name}"${created.itemNumber ? ` (item ${created.itemNumber})` : ""}`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_created", recordType: "Ingredient", recordId: newId, detail: { name: created.name } });
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing ingredient id." });
      const [existing] = await db.select().from(ingredients).where(eq(ingredients.id, id));
      if (!existing) return json(404, { error: "Ingredient not found." });

      const body = await req.json().catch(() => ({}));

      // Optimistic concurrency — reject if the row changed since the client loaded
      // it. Legacy clients sending no expected_modified_at are allowed through.
      const expectedModifiedAt = body.expected_modified_at ?? body.expectedModifiedAt;
      if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
        await logAction({ email: auth.email, role: auth.role, action: "concurrency_conflict_rejected", recordType: "Ingredient", recordId: existing.id, detail: { expected: expectedModifiedAt, actual: existing.modifiedAt } });
        return conflictResponse({ currentRecord: toClient(existing), lastModifiedBy: existing.modifiedBy || "", lastModifiedAt: existing.modifiedAt, attemptedChanges: body });
      }

      const row = toRow(body);
      if (!row.name) return json(400, { error: "Ingredient name is required." });
      const now = new Date();
      const [updated] = await db
        .update(ingredients)
        .set({ ...row, modifiedBy: actor, modifiedAt: now })
        .where(eq(ingredients.id, id))
        .returning();
      await logChange(id, "update", `Updated ingredient "${updated.name}"`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_updated", recordType: "Ingredient", recordId: id, detail: {} });
      return json(200, toClient(updated));
    }

    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing ingredient id." });
      const [existing] = await db.select().from(ingredients).where(eq(ingredients.id, id));
      if (!existing) return json(404, { error: "Ingredient not found." });

      // Deletion is Admin-only.
      if (!admin) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Ingredient", recordId: id, detail: { attempted: "delete" } });
        return json(403, { error: "Only an administrator can delete ingredients." });
      }

      // Referential integrity: refuse deletion (409) while any MMR ingredient line
      // still references this ingredient, and list the blocking MMR ids so the
      // caller can see exactly which formulas must be updated first.
      const refs = await db
        .select({ mmrId: mmrIngredients.mmrId })
        .from(mmrIngredients)
        .where(eq(mmrIngredients.ingredientId, id));
      if (refs.length) {
        const mmrIds = Array.from(new Set(refs.map((r) => r.mmrId)));
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Ingredient", recordId: id, detail: { attempted: "delete", blockedBy: mmrIds } });
        return json(409, {
          error: `This ingredient is referenced by ${mmrIds.length} Master Manufacturing Record(s) and cannot be deleted. Remove it from those formulas first.`,
          conflict: true,
          blockedByMmrIds: mmrIds,
        });
      }

      await db.delete(ingredients).where(eq(ingredients.id, id));
      await logChange(id, "delete", `Deleted ingredient "${existing.name}"`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_deleted", recordType: "Ingredient", recordId: id, detail: { name: existing.name } });
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    console.error("[ingredients] Unhandled handler error", { message: err?.message, stack: err?.stack, method: req.method, id: url.searchParams.get("id") || "", email: callerEmail });
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/ingredients",
};
