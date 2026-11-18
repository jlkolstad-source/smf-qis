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
//   GET    /api/audits?action=next-id&prefix=LIN → next audit number (never reuses a deleted one)
//   GET    /api/audits?id=...&action=delete-preview → what a delete would remove (Admin)
//   POST   /api/audits?id=...&action=delete    → permanent delete, any status (Admin)
//   POST   /api/audits?id=...&action=sign      → record an electronic sign-off by role
//   PUT    /api/audits?id=...                  → save header fields / section progress
//
// The started_by / created_by / modified_by trail and every sign-off are always
// taken from the signed-in identity, never from the request body. Every mutation
// also writes a row to the shared `audit_log` table keyed by the session id.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { getAuth, roleAtLeast, logAction, concurrencyMatches, conflictResponse } from "./lib/auth.js";
import { eq, asc, inArray, or, and, like, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditSessions, records, auditLog, actionLog } from "../../db/schema.js";

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

      const getAction = (url.searchParams.get("action") || "").toString();

      // ── Next audit number (continues from the highest ever issued) ────────
      if (getAction === "next-id") {
        return json(200, { id: await nextAuditId(url.searchParams.get("prefix") || "") });
      }

      // ── Delete preview: counts + linked records, Admin only ───────────────
      if (id && getAction === "delete-preview") {
        if (!roleAtLeast(auth.role, "Admin")) {
          return json(403, { error: `Deleting an audit requires the Admin role. Your role is ${auth.role}.` });
        }
        const [rec] = await db.select().from(auditSessions).where(eq(auditSessions.id, id));
        if (!rec) return json(404, { error: "Audit session not found." });
        const impact = await deleteImpact(rec);
        return json(200, {
          audit: toClient(rec),
          clauseRecords: impact.clauseRecords,
          attachments: impact.attachmentKeys.length,
          appendixB: impact.appendixB,
          linked: impact.linked,
          relatedCapas: impact.relatedCapas,
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

      // ── Permanently delete a session (Admin only, any status) ─────────────
      if (action === "delete") {
        return deleteSession(auth, (id || body.id || "").toString(), actor, body);
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
      // A deleted audit's number is retired for good — refuse to issue it again.
      if (providedId && (await wasDeletedAuditId(providedId))) {
        return json(409, {
          error: `Audit number ${providedId} was previously issued and deleted; it cannot be reused. Use the next available number.`,
          retired: true,
          nextId: await nextAuditId((/^AUDIT-([A-Z]+)-\d{4}-/.exec(providedId) || [])[1] || ""),
        });
      }
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
    // given, otherwise it maps to the same Admin-only permanent session delete.
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
      const delBody = await req.json().catch(() => ({}));
      return deleteSession(auth, id, actor, delBody);
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

  // ── Permanent audit delete (Admin only) ─────────────────────────────────────
  //
  // Removes an audit session of ANY status together with everything that is
  // owned by it:
  //   • the audit_sessions row itself, which carries every clause record
  //     (exec_state[clauseId] + the sections array) and the Appendix B entry
  //     (exec_state._appb) — Appendix B is a view derived from the session row;
  //   • its clause-row evidence attachments in Netlify Blobs.
  //
  // Records that merely REFERENCE the audit (NCRs, CAPAs, Audit Findings with
  // records.audit_id = sid) are quality records in their own right and are NEVER
  // deleted — only their link to this audit is cleared.
  //
  // All database writes (concurrency guard, unlink, history rows, the
  // AUDIT_DELETED action-log entry and the session delete) run as ONE atomic
  // transaction via db.batch(), which the Netlify DB driver sends as a single
  // HTTP transaction — no WebSocket session required. If any statement fails the
  // whole batch rolls back and nothing is left half-deleted. Blob attachments
  // are purged only after the transaction has committed.
  async function deleteSession(
    auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>,
    sid: string,
    who: string,
    body: any,
  ) {
    if (!sid) return json(400, { error: "Missing audit session id." });

    // Role gate — Admin only, enforced server-side.
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
        error: `Deleting an audit requires the Admin role. Your role is ${auth.role}.`,
        requiredRole: "Admin",
        yourRole: auth.role,
      });
    }

    const reason = (body?.reason || "").toString().trim();
    if (reason.length < 10) {
      return json(400, { error: "A reason of at least 10 characters is required to delete an audit." });
    }
    const confirmId = (body?.confirmId || "").toString().trim();
    if (confirmId !== sid) {
      return json(400, { error: "The typed audit number does not match." });
    }

    const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
    if (!existing) return json(404, { error: "Audit session not found. It may already have been deleted." });

    // Optimistic concurrency — same contract as every other audit save.
    const expectedModifiedAt = body?.expected_modified_at ?? body?.expectedModifiedAt;
    if (!expectedModifiedAt) {
      return json(400, { error: "Missing expected_modified_at for the delete concurrency check." });
    }
    if (!concurrencyMatches(expectedModifiedAt, existing.modifiedAt)) {
      await logAction({
        email: auth.email,
        role: auth.role,
        action: "concurrency_conflict_rejected",
        recordType: "Audit Session",
        recordId: sid,
        site: existing.site,
        detail: { attempted: "delete", expected: expectedModifiedAt, actual: existing.modifiedAt },
      });
      return conflictResponse({
        currentRecord: toClient(existing),
        lastModifiedBy: existing.modifiedBy || "",
        lastModifiedAt: existing.modifiedAt,
        attemptedChanges: { action: "delete" },
      });
    }

    const impact = await deleteImpact(existing);
    const expectedIso = new Date(expectedModifiedAt).toISOString();
    const now = new Date();
    const userName = (auth.user.name || "").trim();

    const statements: any[] = [
      // Race guard: if the row changed (or vanished) between the check above and
      // this transaction, 1/0 raises and the whole batch rolls back.
      db.execute(sql`SELECT 1 / (SELECT count(*)::int FROM audit_sessions
        WHERE id = ${sid} AND date_trunc('milliseconds', modified_at) = ${expectedIso}::timestamptz) AS guard`),
    ];
    if (impact.linked.length) {
      statements.push(
        db
          .update(records)
          .set({ auditId: "", modifiedBy: who, modifiedAt: now })
          .where(eq(records.auditId, sid)),
      );
      for (const r of impact.linked) {
        statements.push(
          db.insert(auditLog).values({
            recordId: r.id,
            action: "update",
            detail: `Link to audit ${sid} removed — audit permanently deleted (record retained)`,
            changedBy: who,
          }),
        );
      }
    }
    statements.push(
      db.insert(auditLog).values({
        recordId: sid,
        action: "delete",
        detail: `Audit permanently deleted (status ${existing.status}; ${impact.clauseRecords} clause record(s), ${impact.attachmentKeys.length} attachment(s)). Reason: ${reason}`,
        changedBy: who,
      }),
      db.insert(actionLog).values({
        id: `AL-${now.getTime()}-del-${sid}`.slice(0, 200),
        timestamp: now,
        userEmail: (auth.email || "").toLowerCase(),
        userRole: auth.role,
        action: "AUDIT_DELETED",
        recordType: "Audit Session",
        recordId: sid,
        site: existing.site || "",
        detail: {
          auditNumber: sid,
          sections: arr(existing.sections),
          clausesLabel: existing.clausesLabel || "",
          facility: existing.facilityName || existing.site || "",
          building: existing.building || "",
          scheduledDate: existing.scheduledDate || "",
          statusAtDeletion: existing.status,
          clauseRecordCount: impact.clauseRecords,
          attachmentCount: impact.attachmentKeys.length,
          unlinkedRecords: impact.linked.map((r) => r.id),
          appendixB: impact.appendixB,
          userName: userName || who,
          userEmail: auth.email,
          reason,
          deletedAt: now.toISOString(),
        },
      }),
      db.delete(auditSessions).where(eq(auditSessions.id, sid)),
    );

    try {
      await db.batch(statements as any);
    } catch (e: any) {
      const raw = e?.message || String(e);
      console.error("[audits] delete transaction rolled back", { error: e, recordId: sid, email: auth.email });
      // The guard's division by zero means the row changed mid-request.
      if (/division by zero/i.test(raw)) {
        const [latest] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
        if (!latest) return json(404, { error: "Audit session not found. It may already have been deleted." });
        return conflictResponse({
          currentRecord: toClient(latest),
          lastModifiedBy: latest.modifiedBy || "",
          lastModifiedAt: latest.modifiedAt,
          attemptedChanges: { action: "delete" },
        });
      }
      return json(500, { error: `Delete failed and was rolled back — no records were changed. ${raw}` });
    }

    // Post-commit: purge the attachment binaries. The DB is already consistent;
    // a blob failure is reported but cannot (and need not) undo the delete.
    let blobsDeleted = 0;
    let blobsFailed = 0;
    try {
      const store = await blobStore(ATTACH_STORE);
      const keys = new Set(impact.attachmentKeys);
      // Also sweep anything stored under the audit's prefix (orphaned uploads).
      try {
        const { blobs } = await store.list({ prefix: `${sid}/` });
        for (const b of blobs) keys.add(b.key);
      } catch {
        /* listing is best-effort */
      }
      for (const key of keys) {
        try {
          await store.delete(key);
          blobsDeleted++;
        } catch {
          blobsFailed++;
        }
      }
    } catch (e) {
      blobsFailed = impact.attachmentKeys.length;
      console.error("[audits] post-delete blob cleanup failed", { error: e, recordId: sid });
    }

    return json(200, {
      ok: true,
      id: sid,
      clauseRecordsDeleted: impact.clauseRecords,
      attachmentsDeleted: blobsDeleted,
      attachmentsFailed: blobsFailed,
      unlinkedRecords: impact.linked.map((r) => r.id),
    });
  }
};

// Clause-record / attachment / linked-record counts for one audit session.
// Shared by the delete preview and the delete itself so both agree.
async function deleteImpact(existing: typeof auditSessions.$inferSelect) {
  const execState = (existing.execState && typeof existing.execState === "object"
    ? existing.execState
    : {}) as Record<string, any>;
  const clauseIds = new Set<string>();
  const attachmentKeys: string[] = [];
  for (const [k, entry] of Object.entries(execState)) {
    if (k.startsWith("_") || !entry || typeof entry !== "object") continue;
    clauseIds.add(k);
    for (const a of arr((entry as any).attachments)) if (a && a.key) attachmentKeys.push(a.key);
  }
  for (const s of arr(existing.sections)) {
    if (s && typeof s === "object" && (s as any).id) clauseIds.add(String((s as any).id));
  }
  const linked = await db.select().from(records).where(eq(records.auditId, existing.id));
  // CAPAs the linked records point at (records.capa_id) — shown, never deleted.
  const capaIds = [...new Set(linked.map((r) => r.capaId).filter(Boolean))].filter(
    (id) => !linked.some((r) => r.id === id),
  );
  const capas = capaIds.length ? await db.select().from(records).where(inArray(records.id, capaIds)) : [];
  return {
    clauseRecords: clauseIds.size,
    attachmentKeys,
    appendixB: (execState._appb || "").toString(),
    linked: linked.map((r) => ({ id: r.id, type: r.type, status: r.status })),
    relatedCapas: capas.map((r) => ({ id: r.id, type: r.type, status: r.status })),
  };
}

// Every AUDIT-… id ever issued: live sessions, plus ids that survive in the
// append-only audit_log / action_log after a session is deleted.
async function issuedAuditIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const live = await db.select({ id: auditSessions.id }).from(auditSessions);
  for (const r of live) ids.add(r.id);
  const hist = await db
    .selectDistinct({ id: auditLog.recordId })
    .from(auditLog)
    .where(like(auditLog.recordId, "AUDIT-%"));
  for (const r of hist) ids.add(r.id);
  const acts = await db
    .selectDistinct({ id: actionLog.recordId })
    .from(actionLog)
    .where(like(actionLog.recordId, "AUDIT-%"));
  for (const r of acts) ids.add(r.id);
  return ids;
}

// True when `id` was issued before but no longer exists (i.e. it was deleted).
async function wasDeletedAuditId(id: string): Promise<boolean> {
  const [live] = await db.select({ id: auditSessions.id }).from(auditSessions).where(eq(auditSessions.id, id));
  if (live) return false;
  const [del] = await db
    .select({ id: actionLog.id })
    .from(actionLog)
    .where(
      and(
        eq(actionLog.recordId, id),
        or(eq(actionLog.action, "AUDIT_DELETED"), and(eq(actionLog.action, "record_deleted"), eq(actionLog.recordType, "Audit Session"))),
      ),
    )
    .limit(1);
  if (del) return true;
  const [created] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.recordId, id), eq(auditLog.action, "create")))
    .limit(1);
  return !!created;
}

// Next audit number, continuing from the highest sequence ever issued in the
// year (across all site prefixes) so a deleted number is never reused.
// With a prefix → "AUDIT-LIN-2026-004-S1"; without → "AUDIT-2026-004".
async function nextAuditId(prefix?: string) {
  const year = String(new Date().getFullYear());
  const re = new RegExp("^AUDIT-(?:[A-Z]+-)?" + year + "-(\\d+)");
  let max = 0;
  for (const id of await issuedAuditIds()) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const seq = String(max + 1).padStart(3, "0");
  const p = (prefix || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  return p ? `AUDIT-${p}-${year}-${seq}-S1` : `AUDIT-${year}-${seq}`;
}

export const config: Config = {
  path: "/api/audits",
};
