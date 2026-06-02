// REST API for QIS Crisis Management Exercises (Form SOP-20-EX-001), backed by
// Netlify Database.
//
// Routes (all under /api/crisis):
//   GET    /api/crisis?site=Lindon          → exercise summaries for a site
//   GET    /api/crisis?id=CMT-EX-2026-001    → one exercise + its full response log
//   POST   /api/crisis                       → create an exercise (auto-generates id)
//   POST   /api/crisis?id=...&action=log      → append one CMT response-log entry
//   POST   /api/crisis?id=...&action=respond  → append a participant discussion answer
//   POST   /api/crisis?id=...&action=signoff  → electronically sign off as the current user
//   PUT    /api/crisis?id=...                 → save the exercise (header + sections)
//   DELETE /api/crisis?id=...                 → delete an exercise (admin only)
//
// The response-log timestamp and the acting user name are always taken from the
// request time and the signed-in identity, never from the request body, so the
// chronological CMT timeline is tamper-evident. Every mutation also writes a row
// to the shared `audit_log` table keyed by the exercise id.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { crisisExercises, crisisResponseLog, auditLog, capaLinks } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

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

// Display name used in the live timeline / sign-off (full name preferred, else
// email). The separate attendee "Title" column carries the title here.
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

async function logChange(exerciseId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: exerciseId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

// Shape an exercise row for the client.
function toClient(r: typeof crisisExercises.$inferSelect) {
  return {
    id: r.id,
    exerciseType: r.exerciseType || "",
    scenarioName: r.scenarioName || "",
    scenarioType: r.scenarioType || "",
    exerciseDate: r.exerciseDate || "",
    facilitator: r.facilitator || "",
    exerciseFormat: r.exerciseFormat || "",
    governingSop: r.governingSop || "",
    site: r.site || "",
    scenarioNarrative: r.scenarioNarrative || "",
    objectives: arr(r.objectives),
    discussion: arr(r.discussion),
    lessonsLearned: arr(r.lessonsLearned),
    attendees: arr(r.attendees),
    outcome: r.outcome || "",
    responseAdequate: r.responseAdequate || "",
    planUpdateRequired: r.planUpdateRequired || "",
    nextExerciseDate: r.nextExerciseDate || "",
    summaryNotes: r.summaryNotes || "",
    status: r.status || "In Progress",
    signatures: arr(r.signatures),
    createdBy: r.createdBy || "",
    createdAt: toISO(r.createdAt),
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

function logToClient(e: typeof crisisResponseLog.$inferSelect) {
  return {
    id: e.id,
    exerciseId: e.exerciseId,
    loggedAt: toISO(e.loggedAt),
    userName: e.userName || "",
    phase: e.phase || "",
    program: e.program || "",
    action: e.action || "",
    outcome: e.outcome || "",
    docRef: e.docRef || "",
    status: e.status || "Active",
  };
}

// Next "CMT-EX-YYYY-NNN" id. NNN is sequential within the given year.
async function nextExerciseId(year: string) {
  const rows = await db.select({ id: crisisExercises.id }).from(crisisExercises);
  let max = 0;
  const re = new RegExp("^CMT-EX-" + year + "-(\\d+)$");
  for (const { id } of rows) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "CMT-EX-" + year + "-" + String(max + 1).padStart(3, "0");
}

// Normalise an incoming exercise payload into column values. Only the fields a
// client is allowed to edit are copied; audit columns are stamped separately.
function toRow(r: any) {
  return {
    exerciseType: r.exerciseType || "",
    scenarioName: r.scenarioName || "",
    scenarioType: r.scenarioType || "",
    exerciseDate: r.exerciseDate || "",
    facilitator: r.facilitator || "",
    exerciseFormat: r.exerciseFormat || "",
    governingSop: r.governingSop || "SOP #20 | SQF Clause 2.6.4",
    site: r.site || "Lindon",
    scenarioNarrative: r.scenarioNarrative || "",
    objectives: arr(r.objectives),
    discussion: arr(r.discussion),
    lessonsLearned: arr(r.lessonsLearned),
    attendees: arr(r.attendees),
    outcome: r.outcome || "",
    responseAdequate: r.responseAdequate || "",
    planUpdateRequired: r.planUpdateRequired || "",
    nextExerciseDate: r.nextExerciseDate || "",
    summaryNotes: r.summaryNotes || "",
    status: r.status || "In Progress",
  };
}

async function loadFull(id: string) {
  const [ex] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
  if (!ex) return null;
  const log = await db
    .select()
    .from(crisisResponseLog)
    .where(eq(crisisResponseLog.exerciseId, id))
    .orderBy(asc(crisisResponseLog.loggedAt), asc(crisisResponseLog.id));
  return { ...toClient(ex), responseLog: log.map(logToClient) };
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
      if (id) {
        const full = await loadFull(id);
        if (!full) return json(404, { error: "Exercise not found." });
        return json(200, full);
      }
      const site = url.searchParams.get("site");
      const rows = site
        ? await db.select().from(crisisExercises).where(eq(crisisExercises.site, site)).orderBy(asc(crisisExercises.id))
        : await db.select().from(crisisExercises).orderBy(asc(crisisExercises.id));
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");
      const body = await req.json().catch(() => ({}));

      // ── Append one live CMT response-log entry ────────────────────────────
      if (id && action === "log") {
        const [exists] = await db.select({ id: crisisExercises.id }).from(crisisExercises).where(eq(crisisExercises.id, id));
        if (!exists) return json(404, { error: "Exercise not found." });
        const [entry] = await db
          .insert(crisisResponseLog)
          .values({
            exerciseId: id,
            userName: name, // always the signed-in user, never the body
            phase: (body.phase || "").toString(),
            program: (body.program || "").toString(),
            action: (body.action || "").toString(),
            outcome: (body.outcome || "").toString(),
            docRef: (body.docRef || "").toString(),
            status: body.status === "Resolved" ? "Resolved" : "Active",
          })
          .returning();
        await db.update(crisisExercises).set({ modifiedBy: actor, modifiedAt: new Date() }).where(eq(crisisExercises.id, id));
        await logChange(id, "response_log", `Response logged (${entry.phase || "—"}) by ${name}`, actor);
        return json(201, logToClient(entry));
      }

      // ── Append a participant answer to a discussion question ──────────────
      if (id && action === "respond") {
        const [ex] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
        if (!ex) return json(404, { error: "Exercise not found." });
        const qid = (body.qid || "").toString();
        const text = (body.text || "").toString();
        if (!qid || !text.trim()) return json(400, { error: "Missing question or answer text." });
        const discussion = arr(ex.discussion);
        const q = discussion.find((d: any) => String(d.id) === qid);
        if (!q) return json(404, { error: "Question not found." });
        if (!Array.isArray(q.responses)) q.responses = [];
        q.responses.push({ user: name, text, at: new Date().toISOString() });
        await db
          .update(crisisExercises)
          .set({ discussion, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(crisisExercises.id, id));
        await logChange(id, "discussion", `Discussion response added by ${name}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Electronic sign-off by the current user ───────────────────────────
      if (id && action === "signoff") {
        const [ex] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
        if (!ex) return json(404, { error: "Exercise not found." });
        const attendees = arr(ex.attendees);
        const stamp = new Date().toISOString();
        const existing = attendees.find((a: any) => (a.name || "").trim().toLowerCase() === name.trim().toLowerCase());
        if (existing) {
          existing.signoffAt = stamp;
          if (body.title) existing.title = body.title;
          if (body.qualifications) existing.qualifications = body.qualifications;
          if (body.role) existing.role = body.role;
        } else {
          attendees.push({
            name,
            title: (body.title || "").toString(),
            qualifications: (body.qualifications || "").toString(),
            role: (body.role || "").toString(),
            signoffAt: stamp,
          });
        }
        await db
          .update(crisisExercises)
          .set({ attendees, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(crisisExercises.id, id));
        await logChange(id, "signoff", `Electronic sign-off by ${name}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Electronic sign-off on a signature row, by role ───────────────────
      // Distinct from the attendee "signoff" above: this stamps the signed-in
      // user's name + title + timestamp onto the matching signatures[] row (by
      // role) and moves the exercise to "Signed".
      if (id && action === "sign") {
        const [ex] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
        if (!ex) return json(404, { error: "Exercise not found." });
        const role = (body.role || "").toString().trim();
        if (!role) return json(400, { error: "Missing signature role." });
        const signatures = arr(ex.signatures);
        const signerTitle = userTitle(user);
        const stamp = new Date().toISOString();
        const sig = signatures.find((s: any) => (s.role || "").trim().toLowerCase() === role.toLowerCase());
        if (sig) {
          sig.name = name;
          sig.title = signerTitle;
          sig.signedAt = stamp;
        } else {
          signatures.push({ role, name, title: signerTitle, signedAt: stamp });
        }
        await db
          .update(crisisExercises)
          .set({ signatures, status: "Signed", modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(crisisExercises.id, id));
        await logChange(id, "signoff", `Electronic sign-off (${role}) by ${name}`, actor);
        return json(200, await loadFull(id));
      }

      // ── Create a new exercise ─────────────────────────────────────────────
      const year = (body.exerciseDate && /^\d{4}/.test(body.exerciseDate))
        ? body.exerciseDate.slice(0, 4)
        : String(new Date().getFullYear());
      const newId = await nextExerciseId(year);
      const now = new Date();
      const row = toRow(body);
      // Facilitator defaults to the signed-in user when not supplied.
      if (!row.facilitator) row.facilitator = name;
      const [created] = await db
        .insert(crisisExercises)
        .values({ id: newId, ...row, createdBy: actor, createdAt: now, modifiedBy: actor, modifiedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "Exercise id collision, please retry." });
      await logChange(newId, "create", `Created crisis exercise — ${created.scenarioName || created.exerciseType}`, actor);
      return json(201, await loadFull(newId));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing exercise id." });
      const [existing] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
      if (!existing) return json(404, { error: "Exercise not found." });

      const body = await req.json();
      const now = new Date();
      const row = toRow(body);
      if (!body.site) row.site = existing.site;
      if (!row.facilitator) row.facilitator = existing.facilitator;

      // ── Exercise ID rename ────────────────────────────────────────────────
      // The id is editable from the edit form. When a different id is supplied,
      // validate it is free, then rename and cascade to the live response log,
      // capa_links (capa_id / source_id) and the audit-log history so every
      // reference is preserved.
      const newIdRaw = (body.newId ?? body.new_id ?? "").toString().trim();
      const renaming = !!newIdRaw && newIdRaw !== id;
      const targetId = renaming ? newIdRaw : id;
      if (renaming) {
        const [clash] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, newIdRaw));
        if (clash) return json(409, { error: "An exercise with id " + newIdRaw + " already exists." });
      }

      // Only admins may mark an exercise Complete (close it out).
      if (row.status === "Complete" && existing.status !== "Complete" && !admin) {
        return json(403, { error: "Only an administrator can mark an exercise Complete." });
      }

      await db.update(crisisExercises).set({ ...row, id: targetId, modifiedBy: actor, modifiedAt: now }).where(eq(crisisExercises.id, id));
      if (renaming) {
        await db.update(crisisResponseLog).set({ exerciseId: targetId }).where(eq(crisisResponseLog.exerciseId, id));
        await db.update(capaLinks).set({ capaId: targetId }).where(eq(capaLinks.capaId, id));
        await db.update(capaLinks).set({ sourceId: targetId }).where(eq(capaLinks.sourceId, id));
        await db.update(auditLog).set({ recordId: targetId }).where(eq(auditLog.recordId, id));
        await logChange(targetId, "id_change", `Record ID changed: ${id} → ${targetId}`, actor);
      }
      if (existing.status !== row.status) {
        await logChange(targetId, "status_change", `Status ${existing.status} → ${row.status}`, actor);
      }
      await logChange(targetId, "update", "Exercise saved", actor);
      return json(200, await loadFull(targetId));
    }

    if (req.method === "DELETE") {
      if (!admin) return json(403, { error: "Only an administrator can delete exercises." });
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing exercise id." });
      const [existing] = await db.select().from(crisisExercises).where(eq(crisisExercises.id, id));
      if (!existing) return json(404, { error: "Exercise not found." });
      await db.delete(crisisResponseLog).where(eq(crisisResponseLog.exerciseId, id));
      await db.delete(crisisExercises).where(eq(crisisExercises.id, id));
      await logChange(id, "delete", `Deleted crisis exercise ${id}`, actor);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/crisis",
};
