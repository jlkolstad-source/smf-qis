// REST API for QIS internal-audit sessions, backed by Netlify Database.
//
// An audit session runs through a strict lifecycle: it is created "Scheduled",
// moves to "In Progress" when an auditor starts it (stamping start_time and
// started_by from the signed-in identity), and finally "Closed" once every
// NCR / CAPA finding raised against it has been closed.
//
// Routes (all under /api/audits):
//   GET    /api/audits?site=Lindon          → audit sessions for a site (all if omitted)
//   GET    /api/audits?id=AUDIT-...           → one audit session
//   POST   /api/audits?action=create          → create a session (Scheduled)
//   POST   /api/audits?id=...&action=start     → mark In Progress (stamps start_time/by)
//   POST   /api/audits?id=...&action=complete  → close, if no linked findings remain open
//   POST   /api/audits?id=...&action=delete    → delete (only while Scheduled)
//   POST   /api/audits?id=...&action=sign      → record an electronic sign-off by role
//   PUT    /api/audits?id=...                  → save header fields / section progress
//
// The started_by / created_by / modified_by trail and every sign-off are always
// taken from the signed-in identity, never from the request body. Every mutation
// also writes a row to the shared `audit_log` table keyed by the session id.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { getAuth, roleAtLeast, logAction, concurrencyMatches, conflictResponse } from "./lib/auth.js";
import { eq, asc, inArray, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditSessions, records, auditLog, capaLinks, actionLog } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

// Full name + title for the audit trail / started_by stamp; never the email.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = userTitle(user);
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

// Display name recorded on a signature row (full name preferred, else email).
function displayName(user: Identity): string {
  return user.name || user.email || "Unknown";
}

// The user's title as set on their Identity profile.
function userTitle(user: Identity): string {
  return ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
}

async function logChange(auditId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: auditId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

// ── File attachments ────────────────────────────────────────────────────────
// Clause-row attachments are stored exactly like the OOS module: the file binary
// lives in Netlify Blobs, while the metadata array for each clause row is kept
// inside the session's exec_state ( execState[clauseId].attachments ), so it
// persists when the audit is paused and resumed.
const ATTACH_STORE = "audit-attachments";

// Lazily import @netlify/blobs only when an attachment route actually needs it,
// so a Blobs init problem cannot take down the create / list / save routes that
// never touch Blobs (the same hardening used in the OOS function).
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

// Find the clause-row attachment metadata for a given blob key by scanning every
// clause entry's attachments array in exec_state. Returns { clauseId, meta } or
// null. ( exec_state also holds non-clause meta keys like _lead; those have no
// attachments array and are simply skipped. )
function findAttachment(
  execState: Record<string, any>,
  fileKey: string,
): { clauseId: string; meta: any } | null {
  for (const [clauseId, entry] of Object.entries(execState || {})) {
    if (!entry || typeof entry !== "object") continue;
    const list = arr((entry as any).attachments);
    const meta = list.find((a: any) => a && a.key === fileKey);
    if (meta) return { clauseId, meta };
  }
  return null;
}

// Shape an audit-session row for the client.
function toClient(r: typeof auditSessions.$inferSelect) {
  return {
    id: r.id,
    site: r.site || "",
    scheduledDate: r.scheduledDate || "",
    status: r.status || "Scheduled",
    startTime: toISO(r.startTime),
    startedBy: r.startedBy || "",
    building: r.building || "",
    facilityAddress: r.facilityAddress || "",
    facilityName: r.facilityName || "",
    clausesLabel: r.clausesLabel || "",
    sections: arr(r.sections),
    execState: r.execState || {},
    signatures: arr(r.signatures),
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

// Fallback "AUDIT-YYYY-NNN" id, sequential within the year. Used only when the
// caller does not supply its own (the front-end normally provides the id).
async function nextAuditId() {
  const rows = await db.select({ id: auditSessions.id }).from(auditSessions);
  const year = String(new Date().getFullYear());
  let max = 0;
  const re = new RegExp("^AUDIT-" + year + "-(\\d+)$");
  for (const { id } of rows) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "AUDIT-" + year + "-" + String(max + 1).padStart(3, "0");
}

// Editable header / progress fields. Lifecycle columns (status, start_time,
// started_by) and signatures are managed by their dedicated actions, never here.
function toRow(r: any) {
  return {
    site: r.site || "Lindon",
    scheduledDate: r.scheduledDate || "",
    building: r.building || "",
    facilityAddress: r.facilityAddress || "",
    facilityName: r.facilityName || "",
    clausesLabel: r.clausesLabel || "",
    sections: arr(r.sections),
    execState: r.execState && typeof r.execState === "object" ? r.execState : {},
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  // Captured inside the try as soon as the identity resolves, so the outer catch
  // can attribute any thrown error to the calling user in the logs.
  let callerEmail = "";

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });
    callerEmail = auth.email;
    const user = auth.user;
    const actor = actorString(user);
    const canClose = roleAtLeast(auth.role, "Quality Manager");
    const canEdit = roleAtLeast(auth.role, "Member");

    // Dock is read-only on audit sessions: allow GET (incl. file-download GET),
    // refuse every mutating verb.
    if (req.method !== "GET" && !canEdit) {
      await logAction({
        email: auth.email,
        role: auth.role,
        action: "permission_denied",
        recordType: "Audit Session",
      });
      return json(403, { error: "Your role does not have access to modify audit sessions." });
    }

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const fileKey = url.searchParams.get("file");

      // ── Download one clause-row attachment (binary) ───────────────────────
      if (id && fileKey) {
        const [rec] = await db.select().from(auditSessions).where(eq(auditSessions.id, id));
        if (!rec) return json(404, { error: "Audit session not found." });
        const found = findAttachment(rec.execState || {}, fileKey);
        if (!found) return json(404, { error: "Attachment not found." });
        const store = await blobStore(ATTACH_STORE);
        const blob = await store.get(fileKey, { type: "arrayBuffer" });
        if (!blob) return json(404, { error: "Attachment data missing." });
        return new Response(blob, {
          status: 200,
          headers: {
            "Content-Type": found.meta.contentType || "application/octet-stream",
            "Content-Disposition": `inline; filename="${safeName(found.meta.filename || "attachment")}"`,
            "Cache-Control": "private, max-age=300",
          },
        });
      }

      if (id) {
        const [rec] = await db.select().from(auditSessions).where(eq(auditSessions.id, id));
        if (!rec) return json(404, { error: "Audit session not found." });
        return json(200, toClient(rec));
      }
      const site = url.searchParams.get("site");
      const rows = site
        ? await db.select().from(auditSessions).where(eq(auditSessions.site, site)).orderBy(asc(auditSessions.id))
        : await db.select().from(auditSessions).orderBy(asc(auditSessions.id));
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = (url.searchParams.get("action") || "").toString();
      const body = await req.json().catch(() => ({}));

      // ── Upload one clause-row file attachment to Netlify Blobs ────────────
      // The binary is stored in Blobs; the metadata entry is appended to
      // execState[clauseId].attachments so it is persisted with the session.
      if (action === "attach") {
        const sid = (id || body.id || "").toString();
        if (!sid) return json(400, { error: "Missing audit session id." });
        const clauseId = (body.clauseId || "").toString().trim();
        if (!clauseId) return json(400, { error: "Missing clause id for attachment." });
        const [rec] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!rec) return json(404, { error: "Audit session not found." });
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
        const key = `${sid}/${clauseId}/${Date.now()}-${safeName(filename)}`;
        const store = await blobStore(ATTACH_STORE);
        await store.set(key, bytes, { metadata: { contentType, filename, auditId: sid, clauseId } });
        const entry = {
          key,
          filename,
          contentType,
          size: bytes.length,
          description,
          uploadedBy: actor,
          uploadedAt: new Date().toISOString(),
        };
        const execState: Record<string, any> =
          rec.execState && typeof rec.execState === "object" ? { ...rec.execState } : {};
        const clauseEntry =
          execState[clauseId] && typeof execState[clauseId] === "object"
            ? { ...execState[clauseId] }
            : {};
        clauseEntry.attachments = [...arr(clauseEntry.attachments), entry];
        execState[clauseId] = clauseEntry;
        await db
          .update(auditSessions)
          .set({ execState, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(auditSessions.id, sid));
        await logChange(sid, "attachment", `Attached "${filename}" to clause ${clauseId} (${description || "no description"})`, actor);
        return json(201, entry);
      }

      // ── Start a scheduled session ─────────────────────────────────────────
      if (action === "start") {
        const sid = (id || body.id || "").toString();
        if (!sid) return json(400, { error: "Missing audit session id." });
        const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!existing) return json(404, { error: "Audit session not found." });
        if (existing.status === "Closed") {
          return json(409, { error: "A closed audit session cannot be started." });
        }
        const now = new Date();
        const [updated] = await db
          .update(auditSessions)
          .set({
            status: "In Progress",
            // Stamp the start only once; a re-start keeps the original record.
            startTime: existing.startTime ?? now,
            startedBy: existing.startedBy || actor,
            modifiedBy: actor,
            modifiedAt: now,
          })
          .where(eq(auditSessions.id, sid))
          .returning();
        await logChange(sid, "status_change", `Audit started — status ${existing.status} → In Progress`, actor);
        return json(200, toClient(updated));
      }

      // ── Complete (close) a session, gated on its linked findings ──────────
      if (action === "complete") {
        const sid = (id || body.id || "").toString();
        if (!sid) return json(400, { error: "Missing audit session id." });
        if (!canClose) {
          await logAction({
            email: auth.email,
            role: auth.role,
            action: "permission_denied",
            recordType: "Audit Session",
            recordId: sid,
            detail: { attempted: "complete" },
          });
          return json(403, { error: "Completing an audit session requires the Quality Manager role or above." });
        }
        const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!existing) return json(404, { error: "Audit session not found." });

        // Any NCR / CAPA raised against this session that is not yet Closed
        // blocks completion. The count is returned so the UI can explain why.
        const linked = await db.select().from(records).where(eq(records.auditId, sid));
        const openFindings = linked.filter(
          (r) => (r.type === "NCR" || r.type === "CAPA") && r.status !== "Closed",
        );
        if (openFindings.length > 0) {
          return json(409, {
            error: `Cannot close this audit: ${openFindings.length} linked finding(s) are still open.`,
            openCount: openFindings.length,
            openFindings: openFindings.map((r) => ({ id: r.id, type: r.type, status: r.status })),
          });
        }

        const now = new Date();
        const [updated] = await db
          .update(auditSessions)
          .set({ status: "Closed", modifiedBy: actor, modifiedAt: now })
          .where(eq(auditSessions.id, sid))
          .returning();
        await logChange(sid, "status_change", `Audit completed — status ${existing.status} → Closed`, actor);
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "record_closed",
          recordType: "Audit Session",
          recordId: sid,
          site: existing.site,
          detail: { to: "Closed" },
        });
        return json(200, toClient(updated));
      }

      // ── Delete a session (only while still Scheduled) ─────────────────────
      if (action === "delete") {
        return deleteSession(auth, (id || body.id || "").toString(), actor);
      }

      // ── Electronic sign-off on a signature row, by role ───────────────────
      if (action === "sign") {
        const sid = (id || body.id || "").toString();
        if (!sid) return json(400, { error: "Missing audit session id." });
        const role = (body.role || "").toString().trim();
        if (!role) return json(400, { error: "Missing signature role." });
        const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!existing) return json(404, { error: "Audit session not found." });

        const signatures = arr(existing.signatures);
        const name = displayName(user);
        const title = userTitle(user) || (body.title || "").toString().trim();
        const stamp = new Date().toISOString();
        const rowSig = signatures.find((s: any) => (s.role || "").trim().toLowerCase() === role.toLowerCase());
        if (rowSig) {
          rowSig.name = name;
          rowSig.title = title;
          rowSig.signedAt = stamp;
        } else {
          signatures.push({ role, name, title, signedAt: stamp });
        }
        const now = new Date();
        const [updated] = await db
          .update(auditSessions)
          .set({ signatures, modifiedBy: actor, modifiedAt: now })
          .where(eq(auditSessions.id, sid))
          .returning();
        await logChange(sid, "signoff", `Electronic sign-off (${role}) by ${name}`, actor);
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "sign_added",
          recordType: "Audit Session",
          recordId: sid,
          site: existing.site,
          detail: { role },
        });
        return json(200, toClient(updated));
      }

      // ── Save edited audit header details ─────────────────────────────────
      // Updates the editable session header (facility, building, address,
      // scheduled date, sections, scope, lead/co-auditor) after creation. The
      // execState is merged so clause-level progress and other transient values
      // survive. Refused once the session is Closed to protect completed records.
      if (action === "save-header") {
        const sid = (id || body.id || "").toString();
        if (!sid) return json(400, { error: "Missing audit session id." });
        const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!existing) return json(404, { error: "Audit session not found." });
        if (existing.status === "Closed") {
          return json(403, { error: "A closed audit session's details can no longer be edited." });
        }
        const expectedModifiedAt = body.expected_modified_at ?? body.expectedModifiedAt;
        if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
          await logAction({
            email: auth.email,
            role: auth.role,
            action: "concurrency_conflict_rejected",
            recordType: "Audit Session",
            recordId: existing.id,
            site: existing.site,
            detail: { expected: expectedModifiedAt, actual: existing.modifiedAt },
          });
          return conflictResponse({
            currentRecord: toClient(existing),
            lastModifiedBy: existing.modifiedBy || "",
            lastModifiedAt: existing.modifiedAt,
            attemptedChanges: body,
          });
        }
        const now = new Date();
        const row = toRow(body);
        if (!body.site) row.site = existing.site;
        const mergedExec = {
          ...(existing.execState && typeof existing.execState === "object" ? existing.execState : {}),
          ...(body.execState && typeof body.execState === "object" ? body.execState : {}),
        };
        const [updated] = await db
          .update(auditSessions)
          .set({ ...row, execState: mergedExec, modifiedBy: actor, modifiedAt: now })
          .where(eq(auditSessions.id, sid))
          .returning();
        await logChange(sid, "update", "Audit session header details edited", actor);
        return json(200, toClient(updated));
      }

      // ── Create a new (Scheduled) session ──────────────────────────────────
      const providedId = (body.id || "").toString().trim();
      const newId = providedId || (await nextAuditId());
      const now = new Date();
      const row = toRow(body);
      const [created] = await db
        .insert(auditSessions)
        .values({
          id: newId,
          ...row,
          status: "Scheduled",
          signatures: arr(body.signatures),
          createdBy: actor,
          createdAt: now,
          modifiedBy: actor,
          modifiedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "An audit session with id " + newId + " already exists." });
      await logChange(newId, "create", `Created audit session — ${created.clausesLabel || created.facilityName || "session"}`, actor);
      await logAction({
        email: auth.email,
        role: auth.role,
        action: "record_created",
        recordType: "Audit Session",
        recordId: newId,
        site: created.site,
      });
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      const body = await req.json();
      const sid = id || (body.id || "").toString();
      if (!sid) return json(400, { error: "Missing audit session id." });
      const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
      if (!existing) return json(404, { error: "Audit session not found." });

      // Optimistic concurrency: reject a field edit made against a stale version.
      const expectedModifiedAt = body.expected_modified_at ?? body.expectedModifiedAt;
      if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
        await logAction({ email: auth.email, role: auth.role, action: "concurrency_conflict_rejected", recordType: "Audit Session", recordId: sid, site: existing.site, detail: { expected: expectedModifiedAt, actual: existing.modifiedAt } });
        return conflictResponse({
          currentRecord: toClient(existing),
          lastModifiedBy: existing.modifiedBy || "",
          lastModifiedAt: existing.modifiedAt,
          attemptedChanges: body,
        });
      }

      const now = new Date();
      const row = toRow(body);
      if (!body.site) row.site = existing.site;
      const [updated] = await db
        .update(auditSessions)
        .set({ ...row, modifiedBy: actor, modifiedAt: now })
        .where(eq(auditSessions.id, sid))
        .returning();
      await logChange(sid, "update", "Audit session saved", actor);
      return json(200, toClient(updated));
    }

    // The DELETE verb removes a single clause-row attachment when a file key is
    // given, otherwise it maps to the same Scheduled-only session delete.
    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") || "").toString();
      const fileKey = url.searchParams.get("file");
      if (id && fileKey) {
        const [rec] = await db.select().from(auditSessions).where(eq(auditSessions.id, id));
        if (!rec) return json(404, { error: "Audit session not found." });
        const found = findAttachment(rec.execState || {}, fileKey);
        if (!found) return json(404, { error: "Attachment not found." });
        const store = await blobStore(ATTACH_STORE);
        await store.delete(fileKey).catch(() => {});
        const execState: Record<string, any> = { ...(rec.execState as Record<string, any>) };
        const clauseEntry = { ...execState[found.clauseId] };
        clauseEntry.attachments = arr(clauseEntry.attachments).filter((a: any) => a.key !== fileKey);
        execState[found.clauseId] = clauseEntry;
        await db
          .update(auditSessions)
          .set({ execState, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(auditSessions.id, id));
        await logChange(id, "attachment", `Removed attachment "${found.meta.filename || fileKey}" from clause ${found.clauseId}`, actor);
        return json(200, { ok: true });
      }
      return deleteSession(auth, id, actor);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    console.error("[audits] Unhandled handler error", {
      error: err,
      message: err?.message,
      stack: err?.stack,
      method: req.method,
      recordId: url.searchParams.get("id") || "",
      action: url.searchParams.get("action") || "",
      email: callerEmail,
    });
    return json(500, { error: err?.message || "Server error" });
  }

  // Delete an audit session and everything that depends on it. Admin-only per
  // the Run 1 permission matrix.
  //
  // The auth context is passed in explicitly rather than closed over: the
  // previous version referenced an `admin`/`auth` binding that lived inside the
  // handler's `try` block and was therefore NOT in this function's lexical
  // scope, so any call threw `ReferenceError: admin is not defined`.
  //
  // Dependents are removed in explicit dependency order with SEQUENTIAL deletes,
  // NOT a database transaction. This deployment's database driver (Netlify DB /
  // Neon serverless) does not give us a dependable multi-statement transaction,
  // so a `db.transaction(...)` block silently mis-behaved and surfaced only as a
  // generic caught 500. Each step below has its own try/catch and a distinct
  // error message naming the step, so a failure identifies itself without needing
  // log access. Every step is idempotent (delete-by-key / onConflictDoNothing),
  // so a partial failure can be safely retried until it completes.
  async function deleteSession(
    auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>,
    sid: string,
    who: string,
  ) {
    // Small helper: uniform per-step 500 that names the failing step and carries
    // the raw database error text (never a generic message).
    const stepFail = (step: number, label: string, e: any) => {
      const raw = e?.message || String(e);
      console.error(`[audits] deleteSession failed at step ${step} (${label})`, {
        error: e,
        step,
        label,
        recordId: sid,
        email: auth?.email,
      });
      return json(500, {
        error: `Delete failed at step ${step} (${label}): ${raw}`,
        step,
        stepLabel: label,
        detail: raw,
      });
    };

    try {
      if (!sid) return json(400, { error: "Missing audit session id." });

      // Role gate — Admin only. Return a 403 naming the required role; never throw.
      if (!roleAtLeast(auth.role, "Admin")) {
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "permission_denied",
          recordType: "Audit Session",
          recordId: sid,
          detail: { attempted: "delete" },
        });
        return json(403, {
          error: `Deleting an audit session requires the Admin role. Your role is ${auth.role}.`,
          requiredRole: "Admin",
          yourRole: auth.role,
        });
      }

      const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
      if (!existing) return json(404, { error: "Audit session not found." });

      // Findings raised against this session (records.audit_id === sid).
      const findings = await db.select().from(records).where(eq(records.auditId, sid));
      const findingIds = findings.map((f) => f.id);

      // ── BLOCK RATHER THAN CASCADE where it matters ──────────────────────────
      // Before deleting anything, refuse the delete if any of the session's
      // findings is — or is linked to — a CAPA or NCR that is still open. Only an
      // all-closed dependency graph may be cleaned up.
      const linkRows = findingIds.length
        ? await db
            .select()
            .from(capaLinks)
            .where(or(inArray(capaLinks.sourceId, findingIds), inArray(capaLinks.capaId, findingIds)))
        : [];

      // Every record id related to this session: the findings themselves plus any
      // CAPA / NCR they point at (records.capa_id) or are joined to (capa_links).
      const relatedIds = new Set<string>(findingIds);
      for (const f of findings) if (f.capaId) relatedIds.add(f.capaId);
      for (const l of linkRows) {
        if (l.capaId) relatedIds.add(l.capaId);
        if (l.sourceId) relatedIds.add(l.sourceId);
      }

      const relatedRecords = relatedIds.size
        ? await db.select().from(records).where(inArray(records.id, [...relatedIds]))
        : [];
      const openLinked = relatedRecords
        .filter((r) => (r.type === "CAPA" || r.type === "NCR") && r.status !== "Closed")
        .map((r) => ({ id: r.id, type: r.type, status: r.status }));

      if (openLinked.length > 0) {
        const openIds = new Set(openLinked.map((r) => r.id));
        const blockingFindingIds = findings
          .filter(
            (f) =>
              openIds.has(f.id) ||
              (f.capaId && openIds.has(f.capaId)) ||
              linkRows.some((l) => l.sourceId === f.id && openIds.has(l.capaId)) ||
              linkRows.some((l) => l.capaId === f.id && openIds.has(l.sourceId)),
          )
          .map((f) => f.id);
        return json(409, {
          error: `Cannot delete this audit session: ${openLinked.length} linked CAPA/NCR record(s) are still open. Resolve or close them before deleting.`,
          blocked: true,
          blockingFindingIds,
          findings: findings.map((f) => ({ id: f.id, type: f.type, status: f.status })),
          linkedCapaIds: openLinked.filter((r) => r.type === "CAPA").map((r) => r.id),
          linkedNcrIds: openLinked.filter((r) => r.type === "NCR").map((r) => r.id),
          openLinkedRecords: openLinked,
        });
      }

      // Gather the session's evidence-attachment blob keys (held in exec_state)
      // so step 3 can purge them from Blobs.
      const evidenceKeys: string[] = [];
      const execState = (existing.execState && typeof existing.execState === "object"
        ? existing.execState
        : {}) as Record<string, any>;
      for (const entry of Object.values(execState)) {
        if (entry && typeof entry === "object") {
          for (const a of arr((entry as any).attachments)) {
            if (a && a.key) evidenceKeys.push(a.key);
          }
        }
      }

      // Ids whose action_log / audit_log / link rows we clean up: the session and
      // each of its findings.
      const scopeIds = [sid, ...findingIds];

      // ── Step 1: action_log rows referencing the session and its findings ────
      try {
        await db.delete(actionLog).where(inArray(actionLog.recordId, scopeIds));
      } catch (e) {
        return stepFail(1, "action_log", e);
      }

      // ── Step 2: link rows joining the findings to any CAPAs or NCRs ─────────
      try {
        if (scopeIds.length) {
          await db
            .delete(capaLinks)
            .where(or(inArray(capaLinks.sourceId, scopeIds), inArray(capaLinks.capaId, scopeIds)));
        }
      } catch (e) {
        return stepFail(2, "capa/ncr link rows", e);
      }

      // ── Step 3: evidence attachments (including blob storage references) ────
      // Session evidence lives as blobs keyed from exec_state; finding evidence is
      // embedded in the record row itself and is removed with the finding in step
      // 4. Per-key blob deletes are best-effort (already-gone keys are fine, which
      // keeps the step idempotent); a hard store failure reports as step 3.
      try {
        if (evidenceKeys.length) {
          const store = await blobStore(ATTACH_STORE);
          for (const key of evidenceKeys) await store.delete(key).catch(() => {});
        }
      } catch (e) {
        return stepFail(3, "evidence attachments", e);
      }

      // ── Step 4: the audit findings belonging to the session ─────────────────
      const findingsRemoved = findingIds.length;
      try {
        if (findingIds.length) {
          await db.delete(records).where(inArray(records.id, findingIds));
        }
      } catch (e) {
        return stepFail(4, "audit findings", e);
      }

      // ── Step 5: the audit session itself ────────────────────────────────────
      try {
        await db.delete(auditSessions).where(eq(auditSessions.id, sid));
      } catch (e) {
        return stepFail(5, "audit session", e);
      }

      // ── Step 6: record_deleted entry AFTER the session is gone ──────────────
      // Idempotent: a stable id + onConflictDoNothing means a retried delete does
      // not double-log.
      try {
        const now = new Date();
        await db
          .insert(actionLog)
          .values({
            id: `AL-audit-del-${sid}`,
            timestamp: now,
            userEmail: (auth.email || "").toLowerCase(),
            userRole: auth.role,
            action: "record_deleted",
            recordType: "Audit Session",
            recordId: sid,
            site: existing.site || "",
            detail: { status: existing.status, by: who, findingsRemoved, evidenceRemoved: evidenceKeys.length },
          })
          .onConflictDoNothing();
      } catch (e) {
        return stepFail(6, "record_deleted log", e);
      }

      return json(200, {
        ok: true,
        id: sid,
        findingsRemoved,
        evidenceRemoved: evidenceKeys.length,
      });
    } catch (err: any) {
      // Safety net for anything not attributable to a specific step (e.g. the
      // initial lookups). Never let an exception escape as a 502.
      console.error("[audits] deleteSession unexpected failure", {
        error: err,
        message: err?.message,
        stack: err?.stack,
        recordId: sid,
        email: auth?.email,
      });
      return json(500, {
        error: `Delete failed before completing: ${err?.message || String(err)}`,
        detail: err?.message || String(err),
      });
    }
  }
};

export const config: Config = {
  path: "/api/audits",
};
