// REST API for QIS Mock Recall / Traceability Exercises (Trace & Recall —
// SOP #21), backed by Netlify Database for the structured record and Netlify
// Blobs for per-node file attachments.
//
// Routes (all under /api/recall):
//   GET    /api/recall?site=Lindon              → exercise summaries for a site
//   GET    /api/recall?id=RCL-LDN-2026-0001     → one exercise + nodes + findings
//   GET    /api/recall?id=...&file=KEY          → download one node attachment (binary)
//   POST   /api/recall                          → create an exercise (auto-generates id)
//   POST   /api/recall?id=...&action=save-setup    → save Stage 1 setup header
//   POST   /api/recall?id=...&action=save-node      → add or update a traceability node
//   POST   /api/recall?id=...&action=delete-node    → remove a node
//   POST   /api/recall?id=...&action=attach-node    → upload a file to a node (Blobs)
//   POST   /api/recall?id=...&action=delete-attach  → remove a node attachment
//   POST   /api/recall?id=...&action=save-finding   → add or update a finding
//   POST   /api/recall?id=...&action=delete-finding → remove a finding
//   POST   /api/recall?id=...&action=save-assessment→ save Stage 3 assessment fields
//   POST   /api/recall?id=...&action=sign            → electronically sign a signature row
//   POST   /api/recall?id=...&action=complete        → set status Completed (needs signatures)
//   DELETE /api/recall?id=...                         → delete an exercise (admin only)
//
// The acting user name and every timestamp are always taken from the signed-in
// identity and the request time, never from the request body, so the record is
// tamper-evident. Every mutation also writes a row to the shared `audit_log`
// table keyed by the recall id.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { recallExercises, recallNodes, recallFindings, auditLog } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Risk matrix (Likelihood × Severity) ───────────────────────────────────
// Both inputs are 1-5. The product (1-25) is bucketed into a qualitative level:
//   1-4 = Low · 5-9 = Medium · 10-16 = High · 17-25 = Critical.
// An incomplete pair (either value missing / out of range) is "not yet scored".
export function computeRisk(likelihood: any, severity: any) {
  const L = parseInt(String(likelihood ?? "").trim(), 10);
  const S = parseInt(String(severity ?? "").trim(), 10);
  const valid = Number.isFinite(L) && Number.isFinite(S) && L >= 1 && L <= 5 && S >= 1 && S <= 5;
  if (!valid) {
    return {
      likelihood: String(likelihood ?? "").trim(),
      riskSeverity: String(severity ?? "").trim(),
      riskScore: 0,
      riskLevel: "",
    };
  }
  const score = L * S;
  const level = score >= 17 ? "Critical" : score >= 10 ? "High" : score >= 5 ? "Medium" : "Low";
  return { likelihood: String(L), riskSeverity: String(S), riskScore: score, riskLevel: level };
}

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

const ADMIN_EMAILS = new Set([
  "jkolstad@somafina.com",
  "chad.hinson@somafina.com",
]);

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

function isAdmin(user: Identity): boolean {
  const email = (user.email || "").toLowerCase();
  if (ADMIN_EMAILS.has(email)) return true;
  if (user.role === "admin") return true;
  return Array.isArray(user.roles) && user.roles.includes("admin");
}

// Display name used on sign-offs (full name preferred, else email).
function displayName(user: Identity): string {
  return user.name || user.email || "Unknown";
}

// The user's title as set on their Identity profile.
function userTitle(user: Identity): string {
  return ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
}

// Richer string for the audit trail — full name and title, never the email.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

async function logChange(recallId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: recallId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

const ATTACH_STORE = "recall-attachments";

// Lazily import @netlify/blobs only when an attachment route actually needs it,
// so the data routes keep working regardless of Blobs initialisation state.
let _getStore: typeof import("@netlify/blobs").getStore | undefined;
async function blobStore(name: string) {
  if (!_getStore) {
    ({ getStore: _getStore } = await import("@netlify/blobs"));
  }
  return _getStore(name);
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

// Shape an exercise row for the client.
function toClient(r: typeof recallExercises.$inferSelect) {
  return {
    id: r.id,
    site: r.site || "",
    exerciseType: r.exerciseType || "",
    initiatedBy: r.initiatedBy || "",
    dateInitiated: toISO(r.dateInitiated),
    startingMaterialType: r.startingMaterialType || "",
    startingLotNumber: r.startingLotNumber || "",
    recallDirection: r.recallDirection || "",
    scenarioDescription: r.scenarioDescription || "",
    scenarioScript: r.scenarioScript || "",
    governingSop: r.governingSop || "",
    totalQuantityAffected: r.totalQuantityAffected || "",
    quantityAccountedFor: r.quantityAccountedFor || "",
    quantityUnaccounted: r.quantityUnaccounted || "",
    traceabilityRate: r.traceabilityRate || "",
    recallScope: r.recallScope || "",
    regulatoryNotificationRequired: r.regulatoryNotificationRequired || "",
    customerNotificationRequired: r.customerNotificationRequired || "",
    customerNotificationCount: r.customerNotificationCount || "",
    timeToComplete: r.timeToComplete || "",
    overallAssessment: r.overallAssessment || "",
    facilitatorNotes: r.facilitatorNotes || "",
    status: r.status || "Draft",
    signatures: arr(r.signatures),
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

function nodeToClient(n: typeof recallNodes.$inferSelect) {
  return {
    id: n.id,
    recallId: n.recallId,
    nodeOrder: n.nodeOrder ?? 0,
    nodeType: n.nodeType || "",
    nodeDate: n.nodeDate || "",
    lotBatchNumber: n.lotBatchNumber || "",
    quantity: n.quantity || "",
    quantityUnit: n.quantityUnit || "",
    location: n.location || "",
    responsiblePerson: n.responsiblePerson || "",
    documentsReferenced: n.documentsReferenced || "",
    notes: n.notes || "",
    statement: n.statement || "",
    traceabilityStatus: n.traceabilityStatus || "",
    attachments: arr(n.attachments),
    createdAt: toISO(n.createdAt),
  };
}

function findingToClient(f: typeof recallFindings.$inferSelect) {
  return {
    id: f.id,
    recallId: f.recallId,
    findingDescription: f.findingDescription || "",
    likelihood: f.likelihood || "",
    riskSeverity: f.riskSeverity || "",
    riskScore: f.riskScore || 0,
    riskLevel: f.riskLevel || "",
    owner: f.owner || "",
    targetDate: f.targetDate || "",
    capaRequired: f.capaRequired || "",
    capaId: f.capaId || "",
    ncrId: f.ncrId || "",
    status: f.status || "Open",
    createdAt: toISO(f.createdAt),
  };
}

// Site abbreviation used in the auto-generated ids. Lindon → LDN, any Layton
// facility → LAY, all-sites / unset → ALL.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

// The fixed "RCL-[SITE]-[YYYY]-" prefix every exercise id at a given site and
// year shares. The running number is scoped to this prefix — NOT to the full
// site string — so two site labels that map to the same abbreviation are
// numbered on one sequence and can never collide.
function exercisePrefix(site: string, year: string) {
  return `RCL-${siteAbbr(site)}-${year}-`;
}

// Escape a literal string for safe use inside a RegExp.
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Highest existing sequential number among the exercise ids that start with the
// given prefix. Returns 0 when none exist yet, so the next id is `prefix` + 1.
async function highestExerciseSeq(prefix: string): Promise<number> {
  const rows = await db.select({ id: recallExercises.id }).from(recallExercises);
  const re = new RegExp("^" + escapeRegExp(prefix) + "(\\d+)$");
  let max = 0;
  for (const { id } of rows) {
    const m = re.exec(id as string);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// Highest existing sequential number for a node ("RND") or finding ("RFND") id
// across all rows. The caller starts one past this and keeps incrementing until
// the insert actually lands, so child ids never collide.
async function highestChildSeq(prefix: string): Promise<number> {
  const table = prefix === "RND" ? recallNodes : recallFindings;
  const rows = await db.select({ id: table.id }).from(table);
  const re = new RegExp("^" + prefix + "-(\\d+)$");
  let max = 0;
  for (const { id } of rows) {
    const m = re.exec(id as string);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

async function loadFull(id: string) {
  const [ex] = await db.select().from(recallExercises).where(eq(recallExercises.id, id));
  if (!ex) return null;
  const nodes = await db
    .select()
    .from(recallNodes)
    .where(eq(recallNodes.recallId, id))
    .orderBy(asc(recallNodes.nodeOrder), asc(recallNodes.id));
  const findings = await db
    .select()
    .from(recallFindings)
    .where(eq(recallFindings.recallId, id))
    .orderBy(asc(recallFindings.id));
  return {
    ...toClient(ex),
    nodes: nodes.map(nodeToClient),
    findings: findings.map(findingToClient),
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const actor = actorString(user);
    const name = displayName(user);
    const admin = isAdmin(user);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const fileKey = url.searchParams.get("file");

      // ── Download one node attachment (binary) ─────────────────────────────
      if (id && fileKey) {
        const nodes = await db.select().from(recallNodes).where(eq(recallNodes.recallId, id));
        let meta: any = null;
        for (const n of nodes) {
          const found = arr(n.attachments).find((a: any) => a.key === fileKey);
          if (found) { meta = found; break; }
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

      if (id) {
        const full = await loadFull(id);
        if (!full) return json(404, { error: "Exercise not found." });
        return json(200, full);
      }

      // Exercise list. site / status filters run against the indexed columns
      // (recall_exercises_site_idx, recall_exercises_status_idx) in SQL and the
      // result set is capped at 500 rows.
      const site = url.searchParams.get("site");
      const status = url.searchParams.get("status");
      const conditions = [];
      if (site) conditions.push(eq(recallExercises.site, site));
      if (status) conditions.push(eq(recallExercises.status, status));
      const rows = await db
        .select()
        .from(recallExercises)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(recallExercises.id))
        .limit(500);
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");
      const body = await req.json().catch(() => ({}));

      // Helper: load the exercise referenced by ?id, or null.
      async function exists() {
        if (!id) return null;
        const [ex] = await db.select().from(recallExercises).where(eq(recallExercises.id, id));
        return ex || null;
      }

      // ── Save Stage 1 setup header ─────────────────────────────────────────
      if (id && action === "save-setup") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        await db
          .update(recallExercises)
          .set({
            exerciseType: (body.exerciseType ?? ex.exerciseType) || "Mock Recall",
            site: (body.site ?? ex.site) || ex.site,
            startingMaterialType: (body.startingMaterialType ?? ex.startingMaterialType) || "",
            startingLotNumber: (body.startingLotNumber ?? ex.startingLotNumber) || "",
            recallDirection: (body.recallDirection ?? ex.recallDirection) || "Both",
            scenarioDescription: (body.scenarioDescription ?? ex.scenarioDescription) || "",
            scenarioScript: (body.scenarioScript ?? ex.scenarioScript) || "",
            governingSop: (body.governingSop ?? ex.governingSop) || "SOP #21 — Trace and Recall",
            status: ex.status === "Draft" ? "In Progress" : ex.status,
            modifiedBy: actor,
            modifiedAt: new Date(),
          })
          .where(eq(recallExercises.id, id));
        await logChange(id, "update", "Setup saved", actor);
        return json(200, await loadFull(id));
      }

      // ── Add or update a traceability node ─────────────────────────────────
      if (id && action === "save-node") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const n = body || {};
        const fields = {
          nodeType: (n.nodeType || "").toString(),
          nodeDate: (n.nodeDate || "").toString(),
          lotBatchNumber: (n.lotBatchNumber || "").toString(),
          quantity: (n.quantity || "").toString(),
          quantityUnit: (n.quantityUnit || "").toString(),
          location: (n.location || "").toString(),
          responsiblePerson: (n.responsiblePerson || "").toString(),
          documentsReferenced: (n.documentsReferenced || "").toString(),
          notes: (n.notes || "").toString(),
          statement: (n.statement || "").toString(),
          traceabilityStatus: (n.traceabilityStatus || "").toString(),
        };
        let saved;
        if (n.id) {
          const [existingNode] = await db.select().from(recallNodes).where(eq(recallNodes.id, n.id));
          if (!existingNode || existingNode.recallId !== id) return json(404, { error: "Node not found." });
          // Preserve the node's position unless an explicit order is supplied;
          // reordering is handled by the dedicated reorder-nodes action.
          const updateFields: any = { ...fields };
          if (Number.isFinite(+n.nodeOrder)) updateFields.nodeOrder = +n.nodeOrder;
          [saved] = await db.update(recallNodes).set(updateFields).where(eq(recallNodes.id, n.id)).returning();
          await logChange(id, "update", `Node updated (${fields.nodeType || "—"})`, actor);
        } else {
          // Default ordering: append to the end of the chain.
          let nodeOrder = Number.isFinite(+n.nodeOrder) ? +n.nodeOrder : 0;
          if (!n.nodeOrder) {
            const existingNodes = await db.select({ o: recallNodes.nodeOrder }).from(recallNodes).where(eq(recallNodes.recallId, id));
            nodeOrder = existingNodes.reduce((m, r) => Math.max(m, r.o ?? 0), 0) + 1;
          }
          // Allocate the next "RND-#####" id, incrementing until the insert lands
          // so a new node is always written to recall_nodes (never lost to a
          // colliding id).
          let nodeSeq = await highestChildSeq("RND");
          for (let attempt = 0; attempt < 100 && !saved; attempt++) {
            nodeSeq += 1;
            const nodeId = `RND-${String(nodeSeq).padStart(5, "0")}`;
            [saved] = await db
              .insert(recallNodes)
              .values({ id: nodeId, recallId: id, ...fields, nodeOrder })
              .onConflictDoNothing()
              .returning();
          }
          if (!saved) return json(500, { error: "Could not save node — unable to allocate a unique id." });
          await logChange(id, "create", `Node added (${fields.nodeType || "—"})`, actor);
        }
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        return json(200, await loadFull(id));
      }

      // ── Reorder nodes — accepts an ordered array of node ids ──────────────
      if (id && action === "reorder-nodes") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const order = arr(body.order);
        let i = 1;
        for (const nid of order) {
          await db.update(recallNodes).set({ nodeOrder: i++ }).where(and(eq(recallNodes.id, String(nid)), eq(recallNodes.recallId, id)));
        }
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        await logChange(id, "update", "Traceability chain reordered", actor);
        return json(200, await loadFull(id));
      }

      // ── Remove a node (and its blob attachments) ──────────────────────────
      if (id && action === "delete-node") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const nodeId = (body.nodeId || body.id || "").toString();
        if (!nodeId) return json(400, { error: "Missing node id." });
        const [node] = await db.select().from(recallNodes).where(eq(recallNodes.id, nodeId));
        if (!node || node.recallId !== id) return json(404, { error: "Node not found." });
        const attachments = arr(node.attachments);
        if (attachments.length) {
          try {
            const store = await blobStore(ATTACH_STORE);
            for (const a of attachments) { if (a && a.key) await store.delete(a.key); }
          } catch { /* best-effort blob cleanup */ }
        }
        await db.delete(recallNodes).where(eq(recallNodes.id, nodeId));
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        await logChange(id, "delete", `Node ${nodeId} removed`, actor);
        return json(200, await loadFull(id));
      }

      // ── Upload one file attachment to a node (Netlify Blobs) ──────────────
      if (id && action === "attach-node") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const nodeId = (body.nodeId || "").toString();
        if (!nodeId) return json(400, { error: "Missing node id." });
        const [node] = await db.select().from(recallNodes).where(eq(recallNodes.id, nodeId));
        if (!node || node.recallId !== id) return json(404, { error: "Node not found." });
        const filename = (body.filename || "attachment").toString();
        const contentType = (body.contentType || "application/octet-stream").toString();
        const description = (body.description || "").toString();
        if (!body.data) return json(400, { error: "Missing file data." });
        let bytes: Uint8Array;
        try { bytes = decodeBase64(body.data.toString()); }
        catch { return json(400, { error: "File data is not valid base64." }); }
        const key = `${id}/${nodeId}/${Date.now()}-${safeName(filename)}`;
        const store = await blobStore(ATTACH_STORE);
        await store.set(key, bytes, { metadata: { contentType, filename, recallId: id, nodeId } });
        const entry = { key, filename, contentType, size: bytes.length, description, uploadedBy: actor, uploadedAt: new Date().toISOString() };
        const attachments = [...arr(node.attachments), entry];
        await db.update(recallNodes).set({ attachments }).where(eq(recallNodes.id, nodeId));
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        await logChange(id, "attachment", `Attached "${filename}" to node ${nodeId}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Remove a single node attachment ───────────────────────────────────
      if (id && action === "delete-attach") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const nodeId = (body.nodeId || "").toString();
        const fileKey = (body.key || "").toString();
        if (!nodeId || !fileKey) return json(400, { error: "Missing node id or file key." });
        const [node] = await db.select().from(recallNodes).where(eq(recallNodes.id, nodeId));
        if (!node || node.recallId !== id) return json(404, { error: "Node not found." });
        try { const store = await blobStore(ATTACH_STORE); await store.delete(fileKey); } catch { /* ignore */ }
        const attachments = arr(node.attachments).filter((a: any) => a.key !== fileKey);
        await db.update(recallNodes).set({ attachments }).where(eq(recallNodes.id, nodeId));
        await logChange(id, "attachment", `Removed attachment from node ${nodeId}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Add or update a finding ───────────────────────────────────────────
      if (id && action === "save-finding") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const f = body || {};
        // Risk matrix: recompute when both likelihood and severity are supplied
        // and non-empty; otherwise the risk fields are preserved (on update) or
        // left unscored (on insert) below.
        const riskL = String(f.likelihood ?? "").trim();
        const riskS = String(f.riskSeverity ?? f.risk_severity ?? "").trim();
        const riskProvided = riskL !== "" && riskS !== "";
        const computedRisk = computeRisk(riskL, riskS);
        const fields = {
          findingDescription: (f.findingDescription || "").toString(),
          owner: (f.owner || "").toString(),
          targetDate: (f.targetDate || "").toString(),
          capaRequired: (f.capaRequired || "").toString(),
          capaId: (f.capaId || "").toString(),
          ncrId: (f.ncrId || "").toString(),
          status: (f.status || "Open").toString(),
        };
        let saved;
        if (f.id) {
          const [existingF] = await db.select().from(recallFindings).where(eq(recallFindings.id, f.id));
          if (!existingF || existingF.recallId !== id) return json(404, { error: "Finding not found." });
          const riskFields = riskProvided
            ? computedRisk
            : {
                likelihood: existingF.likelihood,
                riskSeverity: existingF.riskSeverity,
                riskScore: existingF.riskScore,
                riskLevel: existingF.riskLevel,
              };
          [saved] = await db.update(recallFindings).set({ ...fields, ...riskFields }).where(eq(recallFindings.id, f.id)).returning();
          await logChange(id, "update", "Finding updated", actor);
        } else {
          let findingSeq = await highestChildSeq("RFND");
          for (let attempt = 0; attempt < 100 && !saved; attempt++) {
            findingSeq += 1;
            const findingId = `RFND-${String(findingSeq).padStart(5, "0")}`;
            [saved] = await db
              .insert(recallFindings)
              .values({ id: findingId, recallId: id, ...fields, ...computedRisk })
              .onConflictDoNothing()
              .returning();
          }
          if (!saved) return json(500, { error: "Could not save finding — unable to allocate a unique id." });
          await logChange(id, "create", "Finding added", actor);
        }
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        return json(200, await loadFull(id));
      }

      // ── Remove a finding ──────────────────────────────────────────────────
      if (id && action === "delete-finding") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const findingId = (body.findingId || body.id || "").toString();
        if (!findingId) return json(400, { error: "Missing finding id." });
        const [finding] = await db.select().from(recallFindings).where(eq(recallFindings.id, findingId));
        if (!finding || finding.recallId !== id) return json(404, { error: "Finding not found." });
        await db.delete(recallFindings).where(eq(recallFindings.id, findingId));
        await db.update(recallExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(recallExercises.id, id));
        await logChange(id, "delete", `Finding ${findingId} removed`, actor);
        return json(200, await loadFull(id));
      }

      // ── Save Stage 3 assessment fields ────────────────────────────────────
      if (id && action === "save-assessment") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        await db
          .update(recallExercises)
          .set({
            totalQuantityAffected: (body.totalQuantityAffected ?? ex.totalQuantityAffected) || "",
            quantityAccountedFor: (body.quantityAccountedFor ?? ex.quantityAccountedFor) || "",
            quantityUnaccounted: (body.quantityUnaccounted ?? ex.quantityUnaccounted) || "",
            traceabilityRate: (body.traceabilityRate ?? ex.traceabilityRate) || "",
            recallScope: (body.recallScope ?? ex.recallScope) || "",
            regulatoryNotificationRequired: (body.regulatoryNotificationRequired ?? ex.regulatoryNotificationRequired) || "",
            customerNotificationRequired: (body.customerNotificationRequired ?? ex.customerNotificationRequired) || "",
            customerNotificationCount: (body.customerNotificationCount ?? ex.customerNotificationCount) || "",
            timeToComplete: (body.timeToComplete ?? ex.timeToComplete) || "",
            overallAssessment: (body.overallAssessment ?? ex.overallAssessment) || "",
            facilitatorNotes: (body.facilitatorNotes ?? ex.facilitatorNotes) || "",
            status: ex.status === "Draft" ? "In Progress" : ex.status,
            modifiedBy: actor,
            modifiedAt: new Date(),
          })
          .where(eq(recallExercises.id, id));
        await logChange(id, "update", "Assessment saved", actor);
        return json(200, await loadFull(id));
      }

      // ── Electronic sign-off on a signature row, by role ───────────────────
      if (id && action === "sign") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        const role = (body.role || "").toString().trim();
        if (!role) return json(400, { error: "Missing signature role." });
        const signatures = arr(ex.signatures);
        const signerTitle = userTitle(user);
        const stamp = new Date().toISOString();
        const sig = signatures.find((s: any) => (s.role || "").trim().toLowerCase() === role.toLowerCase());
        if (sig) {
          sig.name = name; sig.title = signerTitle; sig.signedAt = stamp;
        } else {
          signatures.push({ role, name, title: signerTitle, signedAt: stamp });
        }
        await db
          .update(recallExercises)
          .set({ signatures, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(recallExercises.id, id));
        await logChange(id, "signoff", `Electronic sign-off (${role}) by ${name}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Complete the exercise (requires at least one signature) ───────────
      if (id && action === "complete") {
        const ex = await exists();
        if (!ex) return json(404, { error: "Exercise not found." });
        if (!arr(ex.signatures).some((s: any) => s.signedAt)) {
          return json(400, { error: "At least one electronic signature is required to complete the exercise." });
        }
        const facilitatorNotes = body.facilitatorNotes !== undefined ? body.facilitatorNotes.toString() : ex.facilitatorNotes;
        await db
          .update(recallExercises)
          .set({ status: "Completed", facilitatorNotes, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(recallExercises.id, id));
        await logChange(id, "status_change", `Status ${ex.status} → Completed`, actor);
        return json(200, await loadFull(id));
      }

      // ── Create a new exercise ─────────────────────────────────────────────
      const now = new Date();
      const site = (body.site || "Lindon").toString();
      const year = String(new Date().getFullYear());
      const prefix = exercisePrefix(site, year);
      const baseValues = {
        site,
        exerciseType: (body.exerciseType || "Mock Recall").toString(),
        initiatedBy: actor,
        dateInitiated: now,
        startingMaterialType: (body.startingMaterialType || "").toString(),
        startingLotNumber: (body.startingLotNumber || "").toString(),
        recallDirection: (body.recallDirection || "Both").toString(),
        scenarioDescription: (body.scenarioDescription || "").toString(),
        governingSop: (body.governingSop || "SOP #21 — Trace and Recall").toString(),
        status: "Draft",
        createdBy: actor,
        createdAt: now,
        modifiedBy: actor,
        modifiedAt: now,
      };
      // Start one past the highest existing sequential number for this
      // (site, year) prefix and keep incrementing until the insert lands.
      // onConflictDoNothing returns no row when the candidate id is already
      // taken, so the loop simply tries the next number — guaranteeing a unique
      // "RCL-[SITE]-[YYYY]-[####]" id without ever surfacing a collision error.
      let seq = await highestExerciseSeq(prefix);
      let created: typeof recallExercises.$inferSelect | undefined;
      let newId = "";
      for (let attempt = 0; attempt < 100 && !created; attempt++) {
        seq += 1;
        newId = `${prefix}${String(seq).padStart(4, "0")}`;
        [created] = await db
          .insert(recallExercises)
          .values({ id: newId, ...baseValues })
          .onConflictDoNothing()
          .returning();
      }
      if (!created) return json(500, { error: "Could not generate a unique exercise id, please retry." });
      await logChange(newId, "create", `Created recall exercise — ${created.exerciseType}`, actor);
      return json(201, await loadFull(newId));
    }

    if (req.method === "DELETE") {
      if (!admin) return json(403, { error: "Only an administrator can delete exercises." });
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing exercise id." });
      const [existing] = await db.select().from(recallExercises).where(eq(recallExercises.id, id));
      if (!existing) return json(404, { error: "Exercise not found." });
      // Best-effort blob cleanup for every node's attachments.
      const nodes = await db.select().from(recallNodes).where(eq(recallNodes.recallId, id));
      try {
        const store = await blobStore(ATTACH_STORE);
        for (const n of nodes) {
          for (const a of arr(n.attachments)) { if (a && a.key) await store.delete(a.key); }
        }
      } catch { /* ignore */ }
      await db.delete(recallNodes).where(eq(recallNodes.recallId, id));
      await db.delete(recallFindings).where(eq(recallFindings.recallId, id));
      await db.delete(recallExercises).where(eq(recallExercises.id, id));
      await logChange(id, "delete", `Deleted recall exercise ${id}`, actor);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/recall",
};
