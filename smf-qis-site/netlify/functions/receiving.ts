// REST API for QIS Receiving Inspections (incoming-material receipt at the dock),
// backed by Netlify Database for the structured record + line items and Netlify
// Blobs for photo / file attachments.
//
// Receiving inspections verify incoming raw materials, packaging and ingredients
// against PO / CoA, check trailer and shipment condition, log temperatures for
// cold (refrigerated / frozen) shipments, and record an overall Accept / Reject /
// Conditional Accept disposition under SQF Edition 9.
//
// Routes (all under /api/receiving):
//   GET    /api/receiving?site=Lindon&from=YYYY-MM-DD&to=YYYY-MM-DD
//                                              → inspections for a site / date range
//   GET    /api/receiving?id=RCV-...           → one inspection with all line items
//   GET    /api/receiving?id=...&file=KEY      → download one attachment (binary)
//   GET    /api/receiving?action=link-lookup&transfer_id=TRF-...
//                                              → outbound Shipping record for a Transfer ID
//   POST   /api/receiving                      → create an inspection (+ line items)
//   POST   /api/receiving?id=...&action=save-line-item   → add / update a line item
//   POST   /api/receiving?id=...&action=delete-line-item → remove a line item
//   POST   /api/receiving?id=...&action=attach → upload one photo / file to Blobs
//   POST   /api/receiving?id=...&action=sign   → record an electronic signature
//   POST   /api/receiving?id=...&action=complete → set status Accepted / Rejected
//   DELETE /api/receiving?id=...&file=KEY      → remove one attachment
//   DELETE /api/receiving?id=...               → delete an inspection (admin only)
//
// The inspected_by / created_by / modified_by trail is always taken from the
// signed-in identity (full name and title — never the email), not from the
// request body. Every mutation also writes a row to the shared `audit_log` table
// keyed by the inspection id, giving a full audit trail.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, and, asc, desc, gte, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { receivingInspections, receivingLineItems, auditLog } from "../../db/schema.js";
import { getAuth, roleAtLeast, logAction, concurrencyMatches, conflictResponse } from "./lib/auth.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

const ADMIN_EMAILS = new Set([
  "jkolstad@somafina.com",
  "chad.hinson@somafina.com",
]);

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

// Authorization is resolved through the shared role helper (lib/auth.ts). The
// legacy email-list / app_metadata isAdmin() check has been removed in favour of
// the user_roles table. ADMIN_EMAILS is retained only as documentation of the
// original bootstrap admins and is no longer consulted for access decisions.
void ADMIN_EMAILS;

// Identity string stamped into inspected_by / created_by / modified_by. Per
// policy these show the full name and title, NOT the email. Falls back to email
// only when no profile name has been set.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

async function logChange(rcvId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: rcvId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

const ATTACH_STORE = "receiving-attachments";

// Lazily import @netlify/blobs only when an attachment route actually needs it,
// so a Blobs init failure never crashes the create / list / update routes that
// don't touch Blobs at all (the same defensive pattern used in oos.ts).
let _getStore: typeof import("@netlify/blobs").getStore | undefined;
async function blobStore(name: string) {
  if (!_getStore) {
    ({ getStore: _getStore } = await import("@netlify/blobs"));
  }
  return _getStore(name);
}

// Site abbreviation used in the auto-generated ids. Lindon → LDN, any Layton
// facility → LAY, all-sites / unset → ALL. Mirrors oos.ts / recall.ts.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

// Each record type gets its own id prefix and an independent sequential counter
// per site per year: Receiving → RCV, Shipping → SHP, Internal Transfer → IXFR.
const TYPE_ID_PREFIX: Record<string, string> = {
  Receiving: "RCV",
  Shipping: "SHP",
  "Internal Transfer": "IXFR",
};
function idPrefixForType(recordType: string): string {
  return TYPE_ID_PREFIX[recordType] || "RCV";
}

// Highest existing "[PREFIX]-[SITE]-[YYYY]-[####]" sequence for a given prefix /
// (site, year). Only ids carrying the SAME prefix are counted, so each record
// type's counter is independent; each year resets independently.
async function highestInspectionSeq(prefix: string, site: string, year: string) {
  const rows = await db.select({ id: receivingInspections.id, site: receivingInspections.site }).from(receivingInspections);
  const re = new RegExp("^" + prefix + "-[A-Za-z]+-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.site !== site) continue;
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// Highest existing "RLI-#####" line-item sequence across all inspections.
async function highestLineItemSeq() {
  const rows = await db.select({ id: receivingLineItems.id }).from(receivingLineItems);
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// Allocate the next unique "TRF-[SITE]-[YYYY]-[####]" Transfer ID for an outbound
// Shipping record. The Transfer ID is stored in the shipping record's own
// linked_transfer_id column and travels with the shipment so the receiving site
// can link its Internal Transfer record back to it.
async function generateTransferId(site: string): Promise<string> {
  const year = String(new Date().getFullYear());
  const rows = await db
    .select({ tid: receivingInspections.linkedTransferId, type: receivingInspections.recordType })
    .from(receivingInspections);
  const re = new RegExp("^TRF-[A-Za-z]+-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.type !== "Shipping") continue;
    const m = re.exec(r.tid || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TRF-${siteAbbr(site)}-${year}-${String(max + 1).padStart(4, "0")}`;
}

// When an Internal Transfer record is saved against a Transfer ID, stamp the
// matching outbound Shipping record as received (received_at / received_by) so
// the chain of custody is closed from both ends. No-op when no shipping record
// matches the Transfer ID.
async function markShippingReceived(transferId: string, actor: string, arrivalSite: string) {
  const tid = (transferId || "").trim();
  if (!tid) return;
  const [shipping] = await db
    .select()
    .from(receivingInspections)
    .where(and(eq(receivingInspections.linkedTransferId, tid), eq(receivingInspections.recordType, "Shipping")));
  if (!shipping) return;
  if (shipping.receivedAt && shipping.receivedBy) return;
  await db
    .update(receivingInspections)
    .set({ receivedAt: new Date(), receivedBy: actor, arrivalSite: arrivalSite || "", modifiedBy: actor, modifiedAt: new Date() })
    .where(eq(receivingInspections.id, shipping.id));
  await logChange(shipping.id, "status_change", `Shipment received against transfer ${tid} by ${actor}${arrivalSite ? " at " + arrivalSite : ""}`, actor);
}

function lineItemToClient(li: typeof receivingLineItems.$inferSelect) {
  return {
    id: li.id,
    inspectionId: li.inspectionId || "",
    materialName: li.materialName || "",
    supplier: li.supplier || "",
    lotNumber: li.lotNumber || "",
    quantity: li.quantity || "",
    quantityUnit: li.quantityUnit || "",
    coaReceived: li.coaReceived || "",
    coaReference: li.coaReference || "",
    internalBatchLot: li.internalBatchLot || "",
    originSite: li.originSite || "",
    attachments: arr(li.attachments),
    createdAt: toISO(li.createdAt),
  };
}

function toClient(r: typeof receivingInspections.$inferSelect, lineItems: any[] = []) {
  const inspISO = toISO(r.inspectionDate);
  return {
    id: r.id,
    site: r.site || "",
    recordType: r.recordType || "Receiving",
    linkedTransferId: r.linkedTransferId || "",
    sealNumber: r.sealNumber || "",
    destination: r.destination || "",
    expectedArrival: r.expectedArrival || "",
    departureTemp: r.departureTemp || "",
    arrivalTemp: r.arrivalTemp || "",
    discrepancies: r.discrepancies || "",
    receivedAt: toISO(r.receivedAt),
    receivedBy: r.receivedBy || "",
    arrivalSite: r.arrivalSite || "",
    inspectionDate: inspISO,
    inspectedBy: r.inspectedBy || "",
    carrier: r.carrier || "",
    trailerNumber: r.trailerNumber || "",
    poNumber: r.poNumber || "",
    coldShipment: r.coldShipment || "No",
    requiredTempRange: r.requiredTempRange || "",
    truckTemp: r.truckTemp || "",
    trailerTemp: r.trailerTemp || "",
    productTemp: r.productTemp || "",
    tempAcceptable: r.tempAcceptable || "",
    trailerExteriorOk: r.trailerExteriorOk || "",
    trailerInteriorOk: r.trailerInteriorOk || "",
    noPestActivity: r.noPestActivity || "",
    sealsIntact: r.sealsIntact || "",
    materialsSecured: r.materialsSecured || "",
    packagingUndamaged: r.packagingUndamaged || "",
    labelsCorrect: r.labelsCorrect || "",
    overallResult: r.overallResult || "",
    notes: r.notes || "",
    ncrId: r.ncrId || "",
    oosId: r.oosId || "",
    attachments: arr(r.attachments),
    signatures: arr(r.signatures),
    status: r.status || "Open",
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
    lineItems,
  };
}

// Auto-calculated temperature verdict. Returns "Yes" when every entered
// temperature (truck / trailer / product) falls within the required range, "No"
// when any entered temperature is out of range, and "" when nothing comparable
// has been entered yet. The range accepts "32-40", "32 to 40", "≤ 40", "<40",
// "≥ -10", etc.; bare numbers and units (°F / °C / F / C) are tolerated.
export function computeTempAcceptable(requiredRange: string, temps: Array<string | undefined>): string {
  const num = (s: string | undefined): number | null => {
    if (s == null) return null;
    const m = String(s).replace(/[°]/g, "").match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const range = String(requiredRange || "").replace(/[°FfCc]/g, "").trim();
  if (!range) return "";
  const entered = temps.map(num).filter((n): n is number => n != null);
  if (!entered.length) return "";

  let lo = -Infinity;
  let hi = Infinity;
  const between = range.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—|\.\.)\s*(-?\d+(?:\.\d+)?)/i);
  if (between) {
    lo = parseFloat(between[1]);
    hi = parseFloat(between[2]);
    if (lo > hi) [lo, hi] = [hi, lo];
  } else if (/(?:<=|≤|<|max|below|under)/i.test(range)) {
    const m = range.match(/-?\d+(\.\d+)?/);
    if (m) hi = parseFloat(m[0]);
  } else if (/(?:>=|≥|>|min|above|over)/i.test(range)) {
    const m = range.match(/-?\d+(\.\d+)?/);
    if (m) lo = parseFloat(m[0]);
  } else {
    // A single bare number is treated as an upper bound (typical for cold chain).
    const m = range.match(/-?\d+(\.\d+)?/);
    if (m) hi = parseFloat(m[0]);
  }
  if (lo === -Infinity && hi === Infinity) return "";
  const allIn = entered.every((t) => t >= lo && t <= hi);
  return allIn ? "Yes" : "No";
}

// Normalise an incoming inspection payload into column values. Only
// client-editable fields are copied; identity / audit / status columns are
// stamped separately. temp_acceptable is always recomputed server-side.
function toRow(r: any) {
  const coldShipment = (r.coldShipment || "No").toString();
  const requiredTempRange = (r.requiredTempRange || "").toString();
  const truckTemp = (r.truckTemp || "").toString();
  const trailerTemp = (r.trailerTemp || "").toString();
  const productTemp = (r.productTemp || "").toString();
  const tempAcceptable =
    coldShipment === "Yes"
      ? computeTempAcceptable(requiredTempRange, [truckTemp, trailerTemp, productTemp])
      : "";
  return {
    site: (r.site || "Lindon").toString(),
    recordType: (r.recordType || "Receiving").toString(),
    linkedTransferId: (r.linkedTransferId || "").toString(),
    sealNumber: (r.sealNumber || "").toString(),
    destination: (r.destination || "").toString(),
    expectedArrival: (r.expectedArrival || "").toString(),
    departureTemp: (r.departureTemp || "").toString(),
    arrivalTemp: (r.arrivalTemp || "").toString(),
    discrepancies: (r.discrepancies || "").toString(),
    carrier: (r.carrier || "").toString(),
    trailerNumber: (r.trailerNumber || "").toString(),
    poNumber: (r.poNumber || "").toString(),
    coldShipment,
    requiredTempRange,
    truckTemp,
    trailerTemp,
    productTemp,
    tempAcceptable,
    trailerExteriorOk: (r.trailerExteriorOk || "").toString(),
    trailerInteriorOk: (r.trailerInteriorOk || "").toString(),
    noPestActivity: (r.noPestActivity || "").toString(),
    sealsIntact: (r.sealsIntact || "").toString(),
    materialsSecured: (r.materialsSecured || "").toString(),
    packagingUndamaged: (r.packagingUndamaged || "").toString(),
    labelsCorrect: (r.labelsCorrect || "").toString(),
    overallResult: (r.overallResult || "").toString(),
    notes: (r.notes || "").toString(),
    ncrId: (r.ncrId || "").toString(),
    oosId: (r.oosId || "").toString(),
  };
}

// Decode a base64 (optionally data-URL) string into a Uint8Array.
function decodeBase64(data: string): Uint8Array {
  const comma = data.indexOf(",");
  const b64 = data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function safeName(name: string): string {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function loadFull(id: string) {
  const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
  if (!rec) return null;
  const items = await db
    .select()
    .from(receivingLineItems)
    .where(eq(receivingLineItems.inspectionId, id))
    .orderBy(asc(receivingLineItems.createdAt), asc(receivingLineItems.id));
  return toClient(rec, items.map(lineItemToClient));
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });
    const user = auth.user;
    const actor = auth.actor;
    // Truck inspections are the ONE module Dock users can write to. Capabilities:
    //   • create (RCV / SHP / IXFR), attach, sign → any authenticated user (Dock+)
    //   • complete (close the inspection) → Quality Manager and above
    //   • delete → Admin only
    //   • Dock may edit only their OWN inspections while still Open
    const admin = roleAtLeast(auth.role, "Admin");
    const canClose = roleAtLeast(auth.role, "Quality Manager");
    const isDock = auth.role === "Dock";

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const fileKey = url.searchParams.get("file");
      const action = url.searchParams.get("action");

      // ── Link lookup ───────────────────────────────────────────────────────
      // Resolve a Transfer ID to its outbound Shipping record (with line items)
      // so the receiving site can auto-populate an Internal Transfer record from
      // what was actually shipped. Returns 404 when no shipping record matches.
      if (action === "link-lookup") {
        const transferId = (url.searchParams.get("transfer_id") || "").trim();
        if (!transferId) return json(400, { error: "Missing transfer_id." });
        const [shipping] = await db
          .select()
          .from(receivingInspections)
          .where(and(eq(receivingInspections.linkedTransferId, transferId), eq(receivingInspections.recordType, "Shipping")));
        if (!shipping) return json(404, { error: `No outbound shipment found for Transfer ID ${transferId}.` });
        return json(200, await loadFull(shipping.id));
      }

      // ── Reverse link lookup ───────────────────────────────────────────────
      // Resolve a Transfer ID to the Internal Transfer receipt that received the
      // shipment (the inverse of link-lookup), so an outbound Shipping record can
      // surface a clickable link to the receiving-side record that closed its
      // chain of custody. Returns 404 when no receipt has been logged yet.
      if (action === "transfer-receipt") {
        const transferId = (url.searchParams.get("transfer_id") || "").trim();
        if (!transferId) return json(400, { error: "Missing transfer_id." });
        const [receipt] = await db
          .select()
          .from(receivingInspections)
          .where(and(eq(receivingInspections.linkedTransferId, transferId), eq(receivingInspections.recordType, "Internal Transfer")));
        if (!receipt) return json(404, { error: `No Internal Transfer receipt found for Transfer ID ${transferId}.` });
        return json(200, await loadFull(receipt.id));
      }

      // ── Download one attachment (binary) ──────────────────────────────────
      if (id && fileKey) {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        let meta = arr(rec.attachments).find((a: any) => a.key === fileKey);
        // Fall back to per-line-item CoA / receiving-doc attachments.
        if (!meta) {
          const items = await db.select().from(receivingLineItems).where(eq(receivingLineItems.inspectionId, id));
          for (const li of items) {
            const hit = arr(li.attachments).find((a: any) => a.key === fileKey);
            if (hit) { meta = hit; break; }
          }
        }
        if (!meta) return json(404, { error: "Attachment not found." });
        const store = await blobStore(ATTACH_STORE);
        const blob = await store.get(fileKey, { type: "arrayBuffer" });
        if (!blob) return json(404, { error: "Attachment data missing." });
        return new Response(blob, {
          status: 200,
          headers: {
            "Content-Type": meta.contentType || "application/octet-stream",
            "Content-Disposition": `inline; filename="${safeName(meta.filename || "attachment")}"`,
            "Cache-Control": "private, max-age=300",
          },
        });
      }

      // ── One inspection with all line items ────────────────────────────────
      if (id) {
        const full = await loadFull(id);
        if (!full) return json(404, { error: "Inspection not found." });
        return json(200, full);
      }

      // ── List inspections, filtered by site and optional date range ────────
      // site / inspection_date filters run against the indexed columns in SQL.
      // `from` / `to` are inclusive YYYY-MM-DD bounds on inspection_date; `to`
      // is widened to the end of that day so the whole day is included.
      const site = url.searchParams.get("site");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const conditions = [];
      if (site) conditions.push(eq(receivingInspections.site, site));
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        conditions.push(gte(receivingInspections.inspectionDate, new Date(`${from}T00:00:00.000Z`)));
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        conditions.push(lte(receivingInspections.inspectionDate, new Date(`${to}T23:59:59.999Z`)));
      }
      const rows = await db
        .select()
        .from(receivingInspections)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(receivingInspections.inspectionDate))
        .limit(500);

      // Attach a line-item count for the list view without N+1 queries.
      const allItems = await db
        .select({ id: receivingLineItems.id, inspectionId: receivingLineItems.inspectionId })
        .from(receivingLineItems);
      const counts = new Map<string, number>();
      for (const it of allItems) counts.set(it.inspectionId, (counts.get(it.inspectionId) || 0) + 1);
      return json(
        200,
        rows.map((r) => ({ ...toClient(r), materialsCount: counts.get(r.id) || 0 })),
      );
    }

    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");

      // ── Add or update one line item ───────────────────────────────────────
      if (id && action === "save-line-item") {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const li = body || {};
        const fields = {
          materialName: (li.materialName || "").toString(),
          supplier: (li.supplier || "").toString(),
          lotNumber: (li.lotNumber || "").toString(),
          quantity: (li.quantity || "").toString(),
          quantityUnit: (li.quantityUnit || "").toString(),
          coaReceived: (li.coaReceived || "").toString(),
          coaReference: (li.coaReference || "").toString(),
          internalBatchLot: (li.internalBatchLot || "").toString(),
          originSite: (li.originSite || "").toString(),
        };
        let saved;
        if (li.id) {
          const [existing] = await db.select().from(receivingLineItems).where(eq(receivingLineItems.id, li.id));
          if (!existing || existing.inspectionId !== id) return json(404, { error: "Line item not found." });
          [saved] = await db.update(receivingLineItems).set(fields).where(eq(receivingLineItems.id, li.id)).returning();
          await logChange(id, "update", `Material updated (${fields.materialName || "—"})`, actor);
        } else {
          // Allocate the next "RLI-#####" id, incrementing until the insert lands.
          let seq = await highestLineItemSeq();
          for (let attempt = 0; attempt < 100 && !saved; attempt++) {
            seq += 1;
            const liId = `RLI-${String(seq).padStart(5, "0")}`;
            [saved] = await db
              .insert(receivingLineItems)
              .values({ id: liId, inspectionId: id, ...fields })
              .onConflictDoNothing()
              .returning();
          }
          if (!saved) return json(500, { error: "Could not save material — unable to allocate a unique id." });
          await logChange(id, "create", `Material added (${fields.materialName || "—"})`, actor);
        }
        await db
          .update(receivingInspections)
          .set({ modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        return json(200, await loadFull(id));
      }

      // ── Remove one line item ──────────────────────────────────────────────
      if (id && action === "delete-line-item") {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const lineItemId = (body.lineItemId || body.id || "").toString();
        if (!lineItemId) return json(400, { error: "Missing line item id." });
        const [existing] = await db.select().from(receivingLineItems).where(eq(receivingLineItems.id, lineItemId));
        if (!existing || existing.inspectionId !== id) return json(404, { error: "Line item not found." });
        await db.delete(receivingLineItems).where(eq(receivingLineItems.id, lineItemId));
        await db
          .update(receivingInspections)
          .set({ modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "delete", `Material removed (${existing.materialName || lineItemId})`, actor);
        return json(200, await loadFull(id));
      }

      // ── Upload one photo / file attachment to Netlify Blobs ───────────────
      if (id && action === "attach") {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const filename = (body.filename || "attachment").toString();
        const contentType = (body.contentType || "application/octet-stream").toString();
        const description = (body.description || "").toString();
        if (!body.data) return json(400, { error: "Missing file data." });
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(body.data.toString());
        } catch {
          return json(400, { error: "File data is not valid base64." });
        }
        const key = `${id}/${Date.now()}-${safeName(filename)}`;
        const store = await blobStore(ATTACH_STORE);
        await store.set(key, bytes, { metadata: { contentType, filename, receivingId: id } });
        const entry = {
          key,
          filename,
          contentType,
          size: bytes.length,
          description,
          uploadedBy: actor,
          uploadedAt: new Date().toISOString(),
        };
        const attachments = [...arr(rec.attachments), entry];
        await db
          .update(receivingInspections)
          .set({ attachments, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "attachment", `Attached "${filename}" (${description || "no description"})`, actor);
        return json(201, entry);
      }

      // ── Upload a CoA / receiving-doc file to one line item (Netlify Blobs) ──
      // Stored under a key that embeds the inspection id and line-item id so each
      // material's documents are independently addressable.
      if (id && action === "attach-line-item") {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const lineItemId = (body.lineItemId || "").toString();
        if (!lineItemId) return json(400, { error: "Missing line item id." });
        const [li] = await db.select().from(receivingLineItems).where(eq(receivingLineItems.id, lineItemId));
        if (!li || li.inspectionId !== id) return json(404, { error: "Line item not found." });
        const filename = (body.filename || "attachment").toString();
        const contentType = (body.contentType || "application/octet-stream").toString();
        if (!body.data) return json(400, { error: "Missing file data." });
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(body.data.toString());
        } catch {
          return json(400, { error: "File data is not valid base64." });
        }
        const key = `${id}/li/${lineItemId}/${Date.now()}-${safeName(filename)}`;
        const store = await blobStore(ATTACH_STORE);
        await store.set(key, bytes, { metadata: { contentType, filename, receivingId: id, lineItemId } });
        const entry = {
          key,
          filename,
          contentType,
          size: bytes.length,
          uploadedBy: actor,
          uploadedAt: new Date().toISOString(),
        };
        const attachments = [...arr(li.attachments), entry];
        await db.update(receivingLineItems).set({ attachments }).where(eq(receivingLineItems.id, lineItemId));
        await db
          .update(receivingInspections)
          .set({ modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "attachment", `CoA / receiving doc "${filename}" attached to material ${li.materialName || lineItemId}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Remove one CoA / receiving-doc file from a line item ──────────────
      if (id && action === "delete-line-item-file") {
        const [rec] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!rec) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const lineItemId = (body.lineItemId || "").toString();
        const fileKey = (body.key || "").toString();
        if (!lineItemId || !fileKey) return json(400, { error: "Missing line item id or file key." });
        const [li] = await db.select().from(receivingLineItems).where(eq(receivingLineItems.id, lineItemId));
        if (!li || li.inspectionId !== id) return json(404, { error: "Line item not found." });
        const store = await blobStore(ATTACH_STORE);
        await store.delete(fileKey).catch(() => {});
        const attachments = arr(li.attachments).filter((a: any) => a.key !== fileKey);
        await db.update(receivingLineItems).set({ attachments }).where(eq(receivingLineItems.id, lineItemId));
        await db
          .update(receivingInspections)
          .set({ modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "attachment", `Removed CoA / receiving doc from material ${li.materialName || lineItemId}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Electronic sign-off on a signature row, by role ───────────────────
      if (id && action === "sign") {
        const [existing] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!existing) return json(404, { error: "Inspection not found." });
        const body = await req.json().catch(() => ({}));
        const role = (body.role || "").toString().trim();
        if (!role) return json(400, { error: "Missing signature role." });

        const signatures = arr(existing.signatures);
        const signerName = (user.name || user.email || "Unknown").toString();
        const signerTitle = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
        const stamp = new Date().toISOString();
        const sig = signatures.find((s: any) => (s.role || "").trim().toLowerCase() === role.toLowerCase());
        if (sig) {
          sig.name = signerName;
          sig.title = signerTitle;
          sig.signedAt = stamp;
        } else {
          signatures.push({ role, name: signerName, title: signerTitle, signedAt: stamp });
        }
        await db
          .update(receivingInspections)
          .set({ signatures, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "signoff", `Electronic sign-off (${role}) by ${signerName}`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "sign_added", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { role } });
        return json(200, await loadFull(id));
      }

      // ── Complete the inspection ───────────────────────────────────────────
      // Sets the record status to Accepted or Rejected. The browser performs the
      // password re-authentication step-up before calling this (and logs the
      // outcome to /api/reauth-log); here we require that the caller is the
      // already-authenticated Identity session and that a final disposition is
      // supplied. A Conditional Accept disposition completes the record with an
      // "Accepted" status (accepted with conditions).
      if (id && action === "complete") {
        const [existing] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
        if (!existing) return json(404, { error: "Inspection not found." });
        // Completing (closing) an inspection requires the Quality Manager role or
        // above. Dock and Member users build and sign the record; a QM finalizes
        // the Accept / Reject disposition.
        if (!canClose) {
          await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { attempted: "complete" } });
          return json(403, { error: "Completing an inspection requires the Quality Manager role or above." });
        }
        const body = await req.json().catch(() => ({}));
        const overallResult = (body.overallResult || existing.overallResult || "").toString();
        if (!overallResult) return json(400, { error: "An overall result is required to complete the inspection." });
        const status = overallResult === "Rejected" ? "Rejected" : "Accepted";
        const [updated] = await db
          .update(receivingInspections)
          .set({ overallResult, status, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id))
          .returning();
        await logChange(id, "status_change", `Inspection completed — ${overallResult} (status ${status})`, actor);
        await logAction({ email: auth.email, role: auth.role, action: "record_closed", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { result: overallResult, status } });
        return json(200, await loadFull(updated.id));
      }

      // ── Create a new inspection (optionally with line items) ──────────────
      const body = await req.json().catch(() => ({}));
      const now = new Date();
      const year = String(new Date().getFullYear());
      const row = toRow(body);
      // An outbound Shipping record issues its own Transfer ID (stored in its
      // linked_transfer_id) which travels with the shipment.
      if (row.recordType === "Shipping" && !row.linkedTransferId) {
        row.linkedTransferId = await generateTransferId(row.site);
      }
      let created: typeof receivingInspections.$inferSelect | undefined;
      let newId = "";
      const idPrefix = idPrefixForType(row.recordType);
      // The client generates and locks the record id the moment a record type is
      // chosen (client-side, no write) and sends it here on the first save. Honour
      // that id when it is well-formed, carries this record type's prefix and is
      // still free, so the id the user saw never changes. Fall back to a fresh
      // server-allocated sequential id when it is absent or already taken.
      const requestedId = (body.id || "").toString().trim();
      const idFormat = new RegExp("^" + idPrefix + "-[A-Za-z]+-" + year + "-\\d+$");
      if (requestedId && idFormat.test(requestedId)) {
        [created] = await db
          .insert(receivingInspections)
          .values({
            id: requestedId,
            ...row,
            inspectionDate: now,
            inspectedBy: actor,
            attachments: [],
            signatures: arr(body.signatures),
            status: "Open",
            createdBy: actor,
            createdAt: now,
            modifiedBy: actor,
            modifiedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (created) newId = requestedId;
      }
      let seq = await highestInspectionSeq(idPrefix, row.site, year);
      for (let attempt = 0; attempt < 100 && !created; attempt++) {
        seq += 1;
        newId = `${idPrefix}-${siteAbbr(row.site)}-${year}-${String(seq).padStart(4, "0")}`;
        [created] = await db
          .insert(receivingInspections)
          .values({
            id: newId,
            ...row,
            inspectionDate: now,
            inspectedBy: actor,
            attachments: [],
            signatures: arr(body.signatures),
            status: "Open",
            createdBy: actor,
            createdAt: now,
            modifiedBy: actor,
            modifiedAt: now,
          })
          .onConflictDoNothing()
          .returning();
      }
      if (!created) return json(500, { error: "Could not generate a unique inspection id, please retry." });

      // Optional initial line items posted alongside the header.
      const items = arr(body.lineItems);
      if (items.length) {
        let liSeq = await highestLineItemSeq();
        for (const li of items) {
          for (let attempt = 0; attempt < 100; attempt++) {
            liSeq += 1;
            const liId = `RLI-${String(liSeq).padStart(5, "0")}`;
            const [savedLi] = await db
              .insert(receivingLineItems)
              .values({
                id: liId,
                inspectionId: newId,
                materialName: (li.materialName || "").toString(),
                supplier: (li.supplier || "").toString(),
                lotNumber: (li.lotNumber || "").toString(),
                quantity: (li.quantity || "").toString(),
                quantityUnit: (li.quantityUnit || "").toString(),
                coaReceived: (li.coaReceived || "").toString(),
                coaReference: (li.coaReference || "").toString(),
                internalBatchLot: (li.internalBatchLot || "").toString(),
                originSite: (li.originSite || "").toString(),
              })
              .onConflictDoNothing()
              .returning();
            if (savedLi) break;
          }
        }
      }
      await logChange(newId, "create", `Created receiving inspection — ${created.carrier || "carrier"} / ${created.poNumber || "(no PO)"}`, actor);
      await logAction({ email: auth.email, role: auth.role, action: "record_created", recordType: "Truck Inspection", recordId: newId, site: created.site, detail: { recordType: created.recordType } });
      // Closing the chain: an Internal Transfer record marks its linked outbound
      // Shipping record as received.
      if (row.recordType === "Internal Transfer" && row.linkedTransferId) {
        await markShippingReceived(row.linkedTransferId, actor, row.site);
      }
      return json(201, await loadFull(newId));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing inspection id." });
      const [existing] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
      if (!existing) return json(404, { error: "Inspection not found." });

      // Dock users may edit ONLY their own inspections, and only while still Open.
      if (isDock) {
        const ownsIt = (existing.createdBy || "") === actor || (existing.inspectedBy || "") === actor;
        if (!ownsIt || existing.status !== "Open") {
          await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { reason: !ownsIt ? "not_owner" : "not_open" } });
          return json(403, { error: "Dock users may only edit their own open inspections." });
        }
      }

      const body = await req.json();

      // Optimistic concurrency: a field edit must be made against the version the
      // editor loaded. A mismatch returns 409 so the client can resolve it.
      const expectedModifiedAt = body.expected_modified_at ?? body.expectedModifiedAt;
      if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
        await logAction({ email: auth.email, role: auth.role, action: "concurrency_conflict_rejected", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { expected: expectedModifiedAt, actual: existing.modifiedAt } });
        return conflictResponse({
          currentRecord: await loadFull(id),
          lastModifiedBy: existing.modifiedBy || "",
          lastModifiedAt: existing.modifiedAt,
          attemptedChanges: body,
        });
      }

      const now = new Date();
      const row = toRow(body);
      if (!body.site) row.site = existing.site;
      // A Shipping record's Transfer ID is owned server-side: keep the existing
      // one, or issue a fresh one the first time a record becomes a Shipping
      // record. The client never overwrites it.
      if (row.recordType === "Shipping") {
        row.linkedTransferId = existing.linkedTransferId || (await generateTransferId(row.site));
      }

      // Inspection IDs are permanent and non-editable — any id in the body is
      // ignored. inspected_by / created_by are likewise never reassigned here.
      const [updated] = await db
        .update(receivingInspections)
        .set({ ...row, modifiedBy: actor, modifiedAt: now })
        .where(eq(receivingInspections.id, id))
        .returning();
      if (existing.status !== updated.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${updated.status}`, actor);
      }
      await logChange(id, "update", "Inspection saved", actor);
      // An Internal Transfer record closes the chain on its linked outbound shipment.
      if (updated.recordType === "Internal Transfer" && updated.linkedTransferId) {
        await markShippingReceived(updated.linkedTransferId, actor, updated.site);
      }
      return json(200, await loadFull(updated.id));
    }

    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing inspection id." });
      const fileKey = url.searchParams.get("file");
      const [existing] = await db.select().from(receivingInspections).where(eq(receivingInspections.id, id));
      if (!existing) return json(404, { error: "Inspection not found." });

      // ── Remove a single attachment ────────────────────────────────────────
      if (fileKey) {
        const meta = arr(existing.attachments).find((a: any) => a.key === fileKey);
        if (!meta) return json(404, { error: "Attachment not found." });
        const store = await blobStore(ATTACH_STORE);
        await store.delete(fileKey).catch(() => {});
        const attachments = arr(existing.attachments).filter((a: any) => a.key !== fileKey);
        await db
          .update(receivingInspections)
          .set({ attachments, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(receivingInspections.id, id));
        await logChange(id, "attachment", `Removed attachment "${meta.filename || fileKey}"`, actor);
        return json(200, { ok: true });
      }

      // ── Delete the whole inspection ───────────────────────────────────────
      // A normal delete is Admin-only. A "discard" (action=discard) is the narrow
      // exception used when a new-inspection draft changes record type: the owner
      // (or Quality Manager+) may remove their OWN still-Open record so its ID can
      // be re-issued with the new type's prefix.
      const isDiscard = (url.searchParams.get("action") === "discard");
      const ownsOpenDraft =
        isDiscard &&
        existing.status === "Open" &&
        (canClose || (existing.createdBy || "") === actor || (existing.inspectedBy || "") === actor);
      if (!admin && !ownsOpenDraft) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: { attempted: isDiscard ? "discard" : "delete" } });
        return json(403, { error: isDiscard ? "Only the owner can discard their own open draft." : "Only an administrator can delete inspections." });
      }
      const store = await blobStore(ATTACH_STORE);
      for (const a of arr(existing.attachments)) {
        await store.delete(a.key).catch(() => {});
      }
      const delItems = await db.select().from(receivingLineItems).where(eq(receivingLineItems.inspectionId, id));
      for (const li of delItems) {
        for (const a of arr(li.attachments)) await store.delete(a.key).catch(() => {});
      }
      await db.delete(receivingLineItems).where(eq(receivingLineItems.inspectionId, id));
      await db.delete(receivingInspections).where(eq(receivingInspections.id, id));
      await logChange(id, "delete", isDiscard ? `Discarded unsaved inspection draft ${id}` : `Deleted receiving inspection ${id}`, actor);
      await logAction({ email: auth.email, role: auth.role, action: isDiscard ? "record_discarded" : "record_deleted", recordType: "Truck Inspection", recordId: id, site: existing.site, detail: isDiscard ? { reason: "record_type_change" } : {} });
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/receiving",
};
