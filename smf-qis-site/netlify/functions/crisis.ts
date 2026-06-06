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
import { eq, and, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { crisisExercises, crisisResponseLog, auditLog } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Risk matrix (Likelihood × Severity) ───────────────────────────────────
// Both inputs are 1-5. The product (1-25) is bucketed into a qualitative level:
//   1-4 = Low · 5-9 = Medium · 10-16 = High · 17-25 = Critical.
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

// Recompute the risk fields on every lessons-learned row from its likelihood /
// severity, and roll the results up into an aggregate summary stored on the
// crisis_exercises.findings_risk_summary column. The summary carries the per-
// level counts, the single highest score / level and a compact list of the
// scored rows so reports can render a risk profile without re-deriving it.
function applyLessonsRisk(lessons: any[]): { lessons: any[]; summary: Record<string, any> } {
  const counts: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const items: any[] = [];
  let highest = 0;
  let highestLevel = "";
  const out = (Array.isArray(lessons) ? lessons : []).map((l: any) => {
    const r = computeRisk(l?.likelihood, l?.riskSeverity ?? l?.risk_severity);
    const row = { ...l, likelihood: r.likelihood, riskSeverity: r.riskSeverity, riskScore: r.riskScore, riskLevel: r.riskLevel };
    if (r.riskLevel) {
      counts[r.riskLevel] = (counts[r.riskLevel] || 0) + 1;
      items.push({ item: l?.item || "", riskScore: r.riskScore, riskLevel: r.riskLevel, likelihood: r.likelihood, riskSeverity: r.riskSeverity });
      if (r.riskScore > highest) { highest = r.riskScore; highestLevel = r.riskLevel; }
    }
    return row;
  });
  return { lessons: out, summary: { counts, highest, highestLevel, items } };
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
    findingsRiskSummary: (r.findingsRiskSummary && typeof r.findingsRiskSummary === "object") ? r.findingsRiskSummary : {},
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

// Site abbreviation used in the auto-generated exercise ids. Lindon → LDN, any
// Layton facility → LAY, and any all-sites / unset scope → ALL.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

// Next "CMT-[SITE]-[YYYY]-[####]" id. The running number is scoped to the
// (site, year) pair: every existing crisis exercise at the same site whose id
// carries the same year segment is scanned, the trailing numeric run is
// extracted from the end of each id regardless of its prefix format, the highest
// is found and incremented by one (zero-padded to four digits). Each year resets
// independently.
async function nextExerciseId(site: string, year: string) {
  const rows = await db.select({ id: crisisExercises.id, site: crisisExercises.site }).from(crisisExercises);
  const re = new RegExp("-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.site !== site) continue;
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `CMT-${siteAbbr(site)}-${year}-${String(max + 1).padStart(4, "0")}`;
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
      // Exercise list. site / status filters run against the indexed columns
      // (crisis_exercises_site_idx, crisis_exercises_status_idx) in SQL, and the
      // result set is capped at 500 rows. The single-exercise path above pulls
      // its response log with one indexed query — no per-row fan-out.
      const site = url.searchParams.get("site");
      const status = url.searchParams.get("status");
      const conditions = [];
      if (site) conditions.push(eq(crisisExercises.site, site));
      if (status) conditions.push(eq(crisisExercises.status, status));
      const rows = await db
        .select()
        .from(crisisExercises)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(crisisExercises.id))
        .limit(500);
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
      const now = new Date();
      const row = toRow(body);
      // Facilitator defaults to the signed-in user when not supplied.
      if (!row.facilitator) row.facilitator = name;
      // Score any lessons supplied at creation and roll up the risk summary.
      const { lessons: seedLessons, summary: seedSummary } = applyLessonsRisk(row.lessonsLearned);
      row.lessonsLearned = seedLessons;
      // Id year is the current year at time of creation (per record-id policy).
      const year = String(new Date().getFullYear());
      const newId = await nextExerciseId(row.site, year);
      const [created] = await db
        .insert(crisisExercises)
        .values({ id: newId, ...row, findingsRiskSummary: seedSummary, createdBy: actor, createdAt: now, modifiedBy: actor, modifiedAt: now })
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

      // Exercise IDs are permanent and non-editable. Any id field in the
      // request body is ignored — the id is never changed by an update.

      // Only admins may mark an exercise Complete (close it out).
      if (row.status === "Complete" && existing.status !== "Complete" && !admin) {
        return json(403, { error: "Only an administrator can mark an exercise Complete." });
      }

      // Recompute per-lesson risk scores and the rolled-up risk summary.
      const { lessons: scoredLessons, summary: riskSummary } = applyLessonsRisk(row.lessonsLearned);
      row.lessonsLearned = scoredLessons;

      await db.update(crisisExercises).set({ ...row, findingsRiskSummary: riskSummary, modifiedBy: actor, modifiedAt: now }).where(eq(crisisExercises.id, id));
      if (existing.status !== row.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${row.status}`, actor);
      }
      await logChange(id, "update", "Exercise saved", actor);
      return json(200, await loadFull(id));
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
