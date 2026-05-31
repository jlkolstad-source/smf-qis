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
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditSessions, records, auditLog } from "../../db/schema.js";

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

  try {
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const actor = actorString(user);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
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
        return json(200, toClient(updated));
      }

      // ── Delete a session (only while still Scheduled) ─────────────────────
      if (action === "delete") {
        return deleteSession((id || body.id || "").toString(), actor);
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
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      const body = await req.json();
      const sid = id || (body.id || "").toString();
      if (!sid) return json(400, { error: "Missing audit session id." });
      const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
      if (!existing) return json(404, { error: "Audit session not found." });

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

    // The DELETE verb maps to the same Scheduled-only delete as action=delete.
    if (req.method === "DELETE") {
      return deleteSession((url.searchParams.get("id") || "").toString(), actor);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }

  // A session may only be deleted while it is still Scheduled; once it is In
  // Progress or Closed it is part of the audit record and must be retained.
  async function deleteSession(sid: string, who: string) {
    if (!sid) return json(400, { error: "Missing audit session id." });
    const [existing] = await db.select().from(auditSessions).where(eq(auditSessions.id, sid));
    if (!existing) return json(404, { error: "Audit session not found." });
    if (existing.status !== "Scheduled") {
      return json(409, {
        error: `Only a Scheduled audit session can be deleted; this session is ${existing.status}.`,
        status: existing.status,
      });
    }
    await db.delete(auditSessions).where(eq(auditSessions.id, sid));
    await logChange(sid, "delete", `Deleted audit session ${sid}`, who);
    return json(200, { ok: true });
  }
};

export const config: Config = {
  path: "/api/audits",
};
