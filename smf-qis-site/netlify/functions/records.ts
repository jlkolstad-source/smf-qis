// REST API for QIS CAPA / NCR / Audit records, backed by Netlify Database.
//
// Routes (all under /api/records):
//   GET    /api/records?site=Lindon   → records for a site (all sites if omitted)
//   GET    /api/records?log=QIS-0001   → audit-trail history for one record
//   POST   /api/records                → create one record, or bulk-import { records: [...] }
//   PUT    /api/records?id=QIS-0001     → update a record
//   DELETE /api/records?id=QIS-0001     → delete a record
//
// Every mutation writes a row to `audit_log`, and create/update also stamp the
// record's created_by/at and modified_by/at columns, giving a full audit trail.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, asc, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { records, auditLog, effectivenessChecks } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

// Admin users may additionally delete records and close findings. Everyone else
// has full create/edit access. Membership is enforced here on the server so the
// rules hold regardless of what the browser sends.
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

// Build the string stamped into created_by / modified_by / changed_by. Per
// policy this shows the user's full name and title, never their email address;
// it falls back to the email only when no profile name has been set yet.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

// Initial Lindon audit findings — used only to seed a brand-new (empty)
// database so the app opens with the same data it shipped with.
const SEED = [
  { type: "AUDIT", severity: "Minor", clause: "2.4.3.2", desc: "Supplier approval records not maintained for three packaging suppliers (third party certification and food grade materials usage information).", owner: "Purchasing", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "2.4.8.1", desc: "Environmental monitoring plan is not risk based. Zones established but no testing in zone 2 and 4. Schedule not well descriptive.", owner: "Quality", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "2.5.4.1", desc: "Internal audit not completed against all SQF requirements. Some GMP module elements covered in GMP or other inspections but incomplete.", owner: "Quality", status: "In Progress", due: "2026-06-18", rca: "Internal audit program lacked formal clause-level checklist.", ca: "SOP #22 Rev 05 §11 implemented. Appendix A and Appendix B issued. First audit executing May 29, 2026.", evidence: "SOP #22 Rev 05 issued May 2026. AUDIT-LDN-2026-001-S1 executing May 29.", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "2.6.3.2", desc: "Recall system tested, reviewed and verified before audit — documentation to be formalized.", owner: "Quality", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "2.6.4.2", desc: "Crisis plan not tested before the audit.", owner: "Quality", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.1.5.1", desc: "Two doors (warehouse dock door 9 and overhead door) not maintained. Daylight and gaps observed at time of audit.", owner: "Facilities", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.2.1.3", desc: "Breakdown and repair records not always maintained. Repairs done but records not consistently kept.", owner: "Maintenance", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.2.1.6", desc: "Three incidents of temporary repairs observed: bottle line cardboard, gummy line plastic wrap, glove and cleaning cloth used to cover drip.", owner: "Maintenance", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.2.5.1", desc: "No master cleaning and sanitation schedule. Periodic cleaning not recorded. Machine records bundled without specific task detail. Pre-ops lack line/area specifics. All-clear tasks bundled.", owner: "Sanitation", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.3.2.3", desc: "Water at appropriate temperature not available at gummy line hand washing station.", owner: "Facilities", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Major", clause: "17.4.1.1", desc: "Multiple GMP violations: kettle cover on non-food surface; food contact liner touching floor (5 incidents); food contact pouches stored uncovered; employees with cell phones in production (5 incidents); water bottles in gummy area; employee at stick packaging not following GMP — cross-contaminated hands, touched shoes, skipped handwashing, touched product packaging. Escort did not intervene.", owner: "Operations", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.6.4.2", desc: "Unattended non-food chemical (lubricant) observed stored with food grade chemicals in ropack area.", owner: "Sanitation", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.6.5.1", desc: "Inbound material and truck inspection records not maintained. Inspections performed but not recorded.", owner: "Receiving", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
  { type: "AUDIT", severity: "Minor", clause: "17.7.3.8", desc: "Unattended snap-off blade observed in warehouse during audit.", owner: "Warehouse", status: "Open", due: "2026-06-18", rca: "", ca: "", evidence: "", created: "2026-05-19" },
];

// Shape a DB row into the object the existing front-end expects (desc / due /
// created), while also exposing the new audit-trail fields.
function toClient(r: typeof records.$inferSelect) {
  const createdISO = r.createdAt instanceof Date ? r.createdAt.toISOString() : (r.createdAt as any) || null;
  const modifiedISO = r.modifiedAt instanceof Date ? r.modifiedAt.toISOString() : (r.modifiedAt as any) || null;
  return {
    id: r.id,
    type: r.type,
    severity: r.severity,
    clause: r.clause,
    status: r.status,
    due: r.dueDate || "",
    owner: r.owner || "",
    ca: r.ca || "",
    rca: r.rca || "",
    desc: r.description || "",
    site: r.site || "",
    evidence: r.evidence || "",
    photos: r.photos || [],
    selfAssigned: !!r.selfAssigned,
    auditId: r.auditId || "",
    sourceBody: r.sourceBody || "",
    capaId: r.capaId || "",
    effectivenessCheckDueDate: r.effectivenessCheckDueDate || "",
    effectivenessCheckOwner: r.effectivenessCheckOwner || "",
    effectivenessStatus: r.effectivenessStatus || "",
    signatures: Array.isArray(r.signatures) ? r.signatures : [],
    created: createdISO ? createdISO.slice(0, 10) : "",
    createdBy: r.createdBy || "",
    createdAt: createdISO,
    modifiedBy: r.modifiedBy || "",
    modifiedAt: modifiedISO,
  };
}

async function logChange(recordId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId, action, detail, changedBy: user || "Unknown" });
}

// Seed the database the first time it is used (table empty). Idempotent.
async function ensureSeed() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(records);
  if (count > 0) return;
  const rows = SEED.map((f, i) => {
    const ts = new Date(f.created + "T00:00:00Z");
    return {
      id: "QIS-" + String(i + 1).padStart(4, "0"),
      type: f.type,
      severity: f.severity,
      clause: f.clause,
      status: f.status,
      dueDate: f.due,
      owner: f.owner,
      ca: f.ca,
      rca: f.rca,
      description: f.desc,
      site: "Lindon",
      evidence: f.evidence,
      photos: [] as any[],
      selfAssigned: false,
      createdBy: "System (seed)",
      createdAt: ts,
      modifiedBy: "System (seed)",
      modifiedAt: ts,
    };
  });
  await db.insert(records).values(rows).onConflictDoNothing();
  for (const row of rows) {
    await logChange(row.id, "create", "Seeded initial audit finding", "System (seed)");
  }
}

// Compute the next "QIS-####" id across ALL sites so ids never collide.
async function nextQisId() {
  const rows = await db.select({ id: records.id }).from(records);
  let max = 0;
  for (const { id } of rows) {
    const m = /^QIS-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "QIS-" + String(max + 1).padStart(4, "0");
}

// Site abbreviation used in the auto-generated record ids. Lindon → LDN, any
// Layton facility → LAY, and any all-sites / unset scope → ALL.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

// Next sequential id for a record TYPE at a given site and year in the
// "[PREFIX]-[SITE]-[YYYY]-[####]" convention (e.g. "NCR-LDN-2026-0001"). The
// running number is scoped to the (type, site, year) triple: every existing
// record of the same type and site whose id carries the same year segment is
// scanned, the trailing numeric run is extracted from the end of each id
// regardless of its prefix format, the highest is found and incremented by one
// (zero-padded to four digits). Each year resets independently, so a new year
// starts back at 0001.
async function nextTypeId(type: string, prefix: string, site: string, year: string): Promise<string> {
  const rows = await db
    .select({ id: records.id, type: records.type, site: records.site })
    .from(records);
  const re = new RegExp("-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.type !== type || r.site !== site) continue;
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${siteAbbr(site)}-${year}-${String(max + 1).padStart(4, "0")}`;
}

// Next prefixed Audit-Finding id for a given certification-body prefix, site and
// year, e.g. "NSF-LDN-2026-0001". Sequential numbering is tracked per prefix per
// site per year independently — NSF-LDN-2026 and SQF-LDN-2026 each advance on
// their own sequence — so only existing AUDIT findings at the same site whose id
// starts with this prefix and carries the same year segment continue the run.
async function nextAuditId(prefix: string, site: string, year: string): Promise<string> {
  const rows = await db
    .select({ id: records.id, type: records.type, site: records.site })
    .from(records);
  const tail = new RegExp("-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.type !== "AUDIT" || r.site !== site) continue;
    if (!r.id.startsWith(prefix + "-")) continue;
    const m = tail.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${siteAbbr(site)}-${year}-${String(max + 1).padStart(4, "0")}`;
}

// Normalise an incoming record payload into DB column values.
function toRow(r: any) {
  return {
    type: r.type || "CAPA",
    severity: r.severity || "Minor",
    clause: (r.clause || "").trim(),
    status: r.status || "Open",
    dueDate: r.due || "",
    owner: (r.owner || "").trim(),
    ca: r.ca || "",
    rca: r.rca || "",
    description: r.desc || "",
    site: r.site || "Lindon",
    evidence: r.evidence || "",
    photos: Array.isArray(r.photos) ? r.photos : [],
    selfAssigned: !!r.selfAssigned,
    auditId: (r.auditId || "").toString(),
    sourceBody: (r.sourceBody ?? r.source_body ?? "").toString().trim().toUpperCase(),
    capaId: (r.capaId ?? r.capa_id ?? "").toString(),
    effectivenessCheckDueDate: (r.effectivenessCheckDueDate ?? r.effectiveness_check_due_date ?? "").toString(),
    effectivenessCheckOwner: (r.effectivenessCheckOwner ?? r.effectiveness_check_owner ?? "").toString(),
    effectivenessStatus: (r.effectivenessStatus ?? r.effectiveness_status ?? "").toString(),
  };
}

// Has the caller supplied a value for one of the effectiveness fields? Accepts
// camelCase or snake_case so the field can be preserved through a PUT exactly
// like `site` is when the body omits it.
function bodyHas(body: any, ...keys: string[]): boolean {
  return keys.some((k) => body[k] !== undefined);
}

// Date string (YYYY-MM-DD) n days from today, used to default the 90-day
// effectiveness-check due date on close.
function plusDaysISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Sequential "EFF-####" id for effectiveness_checks rows.
async function nextEffId() {
  const rows = await db.select({ id: effectivenessChecks.id }).from(effectivenessChecks);
  let max = 0;
  for (const { id } of rows) {
    const m = /^EFF-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "EFF-" + String(max + 1).padStart(4, "0");
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    // Every operation requires an authenticated Identity user. The created_by /
    // modified_by trail is taken from this user, never from the request body.
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const actor = actorString(user);
    const admin = isAdmin(user);

    if (req.method === "GET") {
      await ensureSeed();

      const logId = url.searchParams.get("log");
      if (logId) {
        const entries = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.recordId, logId))
          .orderBy(asc(auditLog.id));
        return json(200, entries);
      }

      // Effectiveness-check detail for one CAPA (the authoritative row from
      // effectiveness_checks). Returns null when no check exists yet.
      const effId = url.searchParams.get("effectiveness");
      if (effId) {
        const [check] = await db
          .select()
          .from(effectivenessChecks)
          .where(eq(effectivenessChecks.capaId, effId))
          .orderBy(asc(effectivenessChecks.id));
        if (!check) return json(200, null);
        const vAt = check.verifiedAt instanceof Date ? check.verifiedAt.toISOString() : (check.verifiedAt as any) || null;
        return json(200, {
          id: check.id,
          capaId: check.capaId,
          dueDate: check.dueDate || "",
          owner: check.owner || "",
          status: check.status || "",
          rootCauseEliminated: check.rootCauseEliminated || "",
          evidence: check.evidence || "",
          recurred: check.recurred || "",
          determination: check.determination || "",
          verifiedBy: check.verifiedBy || "",
          verifiedAt: vAt,
        });
      }

      const site = url.searchParams.get("site");
      const rows = site
        ? await db.select().from(records).where(eq(records.site, site)).orderBy(asc(records.id))
        : await db.select().from(records).orderBy(asc(records.id));
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const body = await req.json();
      const action = (url.searchParams.get("action") || body.action || "").toString();

      // ── Electronic sign-off on a signature row, by role ───────────────────
      // Finds the matching signature row by role, stamps the signed-in user's
      // name + title + timestamp on it, and moves the record to "Signed".
      if (action === "sign") {
        const id = (url.searchParams.get("id") || body.id || "").toString();
        if (!id) return json(400, { error: "Missing record id." });
        const role = (body.role || "").toString().trim();
        if (!role) return json(400, { error: "Missing signature role." });
        const [existing] = await db.select().from(records).where(eq(records.id, id));
        if (!existing) return json(404, { error: "Record not found." });

        const signatures = Array.isArray(existing.signatures) ? existing.signatures : [];
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
        const now = new Date();
        const [updated] = await db
          .update(records)
          .set({ signatures, status: "Signed", modifiedBy: actor, modifiedAt: now })
          .where(eq(records.id, id))
          .returning();
        await logChange(id, "signoff", `Electronic sign-off (${role}) by ${signerName}`, actor);
        return json(200, toClient(updated));
      }

      // ── Save / update a CAPA effectiveness check ──────────────────────────
      // Upserts the effectiveness_checks row for the CAPA and mirrors the
      // resulting state onto the CAPA record. The determination drives both the
      // effectiveness_status and the CAPA record's own status.
      if (action === "save-effectiveness") {
        const capaId = (body.capa_id || body.capaId || "").toString().trim();
        if (!capaId) return json(400, { error: "Missing capa_id." });
        const [existing] = await db.select().from(records).where(eq(records.id, capaId));
        if (!existing) return json(404, { error: "Record not found." });

        const dueDate = body.due_date !== undefined ? (body.due_date || "").toString() : existing.effectivenessCheckDueDate;
        const owner = body.owner !== undefined ? (body.owner || "").toString() : existing.effectivenessCheckOwner;
        const rootCauseEliminated = (body.root_cause_eliminated || "").toString();
        const evidence = (body.evidence || "").toString();
        const recurred = (body.recurred || "").toString();
        const determination = (body.determination || "").toString().trim();

        // Derive the resulting effectiveness_status, the CAPA record status and
        // whether the verification stamp / failure note should be written.
        let effStatus = existing.effectivenessStatus || "Pending";
        let recordStatus = existing.status;
        let verifiedBy = "";
        let verifiedAt: Date | null = null;
        let failureNote = false;
        const now = new Date();

        if (determination === "Effective") {
          effStatus = "Completed";
          recordStatus = "Closed — Verified Effective";
          verifiedBy = actor;
          verifiedAt = now;
        } else if (determination === "Ineffective") {
          effStatus = "Completed";
          recordStatus = "In Progress";
          verifiedBy = actor;
          verifiedAt = now;
          failureNote = true;
        } else if (determination === "Requires Additional Action") {
          effStatus = "In Progress";
        } else if (!existing.effectivenessStatus && existing.status === "Closed — Awaiting Effectiveness Assignment") {
          // First assignment of a check owner on a CAPA closed without one:
          // schedule the check (Pending) and move the record into the
          // pending-effectiveness state so closure can complete.
          effStatus = "Pending";
          recordStatus = "Closed — Pending Effectiveness Check";
        }

        // Upsert the effectiveness_checks row (one per CAPA).
        const [check] = await db
          .select()
          .from(effectivenessChecks)
          .where(eq(effectivenessChecks.capaId, capaId))
          .orderBy(asc(effectivenessChecks.id));
        if (check) {
          await db
            .update(effectivenessChecks)
            .set({
              dueDate,
              owner,
              status: effStatus,
              rootCauseEliminated,
              evidence,
              recurred,
              determination,
              verifiedBy: verifiedBy || check.verifiedBy,
              verifiedAt: verifiedAt || check.verifiedAt,
              modifiedBy: actor,
              modifiedAt: now,
            })
            .where(eq(effectivenessChecks.id, check.id));
        } else {
          const effId = await nextEffId();
          await db.insert(effectivenessChecks).values({
            id: effId,
            capaId,
            dueDate,
            owner,
            status: effStatus,
            rootCauseEliminated,
            evidence,
            recurred,
            determination,
            verifiedBy,
            verifiedAt,
            createdAt: now,
            modifiedBy: actor,
            modifiedAt: now,
          });
        }

        const [updated] = await db
          .update(records)
          .set({
            effectivenessCheckDueDate: dueDate || "",
            effectivenessCheckOwner: owner || "",
            effectivenessStatus: effStatus,
            status: recordStatus,
            modifiedBy: actor,
            modifiedAt: now,
          })
          .where(eq(records.id, capaId))
          .returning();

        if (failureNote) {
          await logChange(capaId, "effectiveness", "Effectiveness check failed — new investigation required.", actor);
        }
        if (existing.status !== recordStatus) {
          await logChange(capaId, "status_change", `Status ${existing.status} → ${recordStatus}`, actor);
        }
        await logChange(
          capaId,
          "effectiveness",
          `Effectiveness check saved${determination ? ` — determination: ${determination}` : ""}`,
          actor
        );
        return json(200, toClient(updated));
      }

      // ── Adjust only the effectiveness-check due date ──────────────────────
      // Allowed at any time while the check is not yet Completed.
      if (action === "update-effectiveness-date") {
        const capaId = (body.capa_id || body.capaId || "").toString().trim();
        if (!capaId) return json(400, { error: "Missing capa_id." });
        const dueDate = (body.due_date || body.dueDate || "").toString();
        const [existing] = await db.select().from(records).where(eq(records.id, capaId));
        if (!existing) return json(404, { error: "Record not found." });
        if (existing.effectivenessStatus === "Completed") {
          return json(400, { error: "Effectiveness check already completed; the due date can no longer be changed." });
        }

        const now = new Date();
        const [updated] = await db
          .update(records)
          .set({ effectivenessCheckDueDate: dueDate, modifiedBy: actor, modifiedAt: now })
          .where(eq(records.id, capaId))
          .returning();

        const [check] = await db
          .select()
          .from(effectivenessChecks)
          .where(eq(effectivenessChecks.capaId, capaId))
          .orderBy(asc(effectivenessChecks.id));
        if (check) {
          await db
            .update(effectivenessChecks)
            .set({ dueDate, modifiedBy: actor, modifiedAt: now })
            .where(eq(effectivenessChecks.id, check.id));
        }
        await logChange(capaId, "effectiveness", `Effectiveness-check due date set to ${dueDate || "(cleared)"}`, actor);
        return json(200, toClient(updated));
      }

      // Bulk import: { records: [...] }
      if (Array.isArray(body.records)) {
        let base = await nextQisId();
        let counter = parseInt(base.split("-")[1], 10);
        let imported = 0;
        for (const rec of body.records) {
          const id = rec.id && String(rec.id).trim()
            ? String(rec.id).trim()
            : "QIS-" + String(counter++).padStart(4, "0");
          const now = new Date();
          const row = toRow(rec);
          const [existing] = await db.select().from(records).where(eq(records.id, id));
          await db
            .insert(records)
            .values({ id, ...row, createdBy: actor, createdAt: now, modifiedBy: actor, modifiedAt: now })
            .onConflictDoUpdate({
              target: records.id,
              set: { ...row, modifiedBy: actor, modifiedAt: now },
            });
          await logChange(id, existing ? "update" : "create", existing ? "Imported (updated)" : "Imported (created)", actor);
          imported++;
        }
        return json(200, { ok: true, imported });
      }

      // Single create.
      const row = toRow(body);
      // Auto-generate the id when the client did not supply one, using the
      // "[PREFIX]-[SITE]-[YYYY]-[####]" convention. NCR / CAPA are numbered per
      // type/site/year; Audit Findings take their prefix from the
      // certification-body source and are numbered per prefix/site/year. Record
      // ids are permanent — they are generated once here and never change.
      const year = String(new Date().getFullYear());
      let id: string;
      if (body.id && String(body.id).trim()) {
        id = String(body.id).trim();
      } else if (row.type === "AUDIT") {
        id = await nextAuditId(row.sourceBody || "AUDIT", row.site, year);
      } else if (row.type === "NCR") {
        id = await nextTypeId("NCR", "NCR", row.site, year);
      } else if (row.type === "CAPA") {
        id = await nextTypeId("CAPA", "CAPA", row.site, year);
      } else {
        id = await nextQisId();
      }
      const now = new Date();
      const [created] = await db
        .insert(records)
        .values({ id, ...row, createdBy: actor, createdAt: now, modifiedBy: actor, modifiedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "A record with id " + id + " already exists." });
      await logChange(id, "create", `Created ${created.type} (${created.severity}) — status ${created.status}`, actor);
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const body = await req.json();
      const id = (url.searchParams.get("id") || body.id || "").toString();
      if (!id) return json(400, { error: "Missing record id." });

      const [existing] = await db.select().from(records).where(eq(records.id, id));
      if (!existing) return json(404, { error: "Record not found." });

      const now = new Date();
      const row = toRow(body);
      // Preserve the original site / audit link unless one is explicitly supplied.
      if (!body.site) row.site = existing.site;
      if (!body.auditId) row.auditId = existing.auditId;
      // Preserve the effectiveness fields unless the body explicitly supplies
      // them — they are normally managed by the effectiveness actions above.
      if (!bodyHas(body, "capaId", "capa_id")) row.capaId = existing.capaId;
      if (!bodyHas(body, "effectivenessCheckDueDate", "effectiveness_check_due_date"))
        row.effectivenessCheckDueDate = existing.effectivenessCheckDueDate;
      if (!bodyHas(body, "effectivenessCheckOwner", "effectiveness_check_owner"))
        row.effectivenessCheckOwner = existing.effectivenessCheckOwner;
      if (!bodyHas(body, "effectivenessStatus", "effectiveness_status"))
        row.effectivenessStatus = existing.effectivenessStatus;
      // Preserve the certification-body source unless explicitly supplied.
      if (!bodyHas(body, "sourceBody", "source_body")) row.sourceBody = existing.sourceBody;

      // Record IDs are permanent and non-editable. Any id field in the request
      // body is ignored — the id is never changed by an update.

      // Only admins may close a finding.
      if (row.status === "Closed" && existing.status !== "Closed" && !admin) {
        return json(403, { error: "Only an administrator can close a finding." });
      }

      // CAPA close gating: a CAPA cannot reach a plain "Closed" state until an
      // effectiveness check has been completed. When a CAPA is being closed,
      // route it through the effectiveness-check lifecycle instead — scheduling
      // the check (90 days out) if an owner is assigned, or holding it awaiting
      // owner assignment otherwise.
      if (row.status === "Closed" && existing.type === "CAPA") {
        const checkOwner = (row.effectivenessCheckOwner || "").trim();
        if (checkOwner) {
          row.status = "Closed — Pending Effectiveness Check";
          row.effectivenessStatus = "Pending";
          if (!row.effectivenessCheckDueDate) row.effectivenessCheckDueDate = plusDaysISO(90);
        } else {
          row.status = "Closed — Awaiting Effectiveness Assignment";
        }
      }

      const [updated] = await db
        .update(records)
        .set({ ...row, modifiedBy: actor, modifiedAt: now })
        .where(eq(records.id, id))
        .returning();

      // Audit trail: log changed fields, and the status transition specifically.
      const tracked: [string, any, any][] = [
        ["type", existing.type, updated.type],
        ["severity", existing.severity, updated.severity],
        ["clause", existing.clause, updated.clause],
        ["status", existing.status, updated.status],
        ["due_date", existing.dueDate, updated.dueDate],
        ["owner", existing.owner, updated.owner],
        ["description", existing.description, updated.description],
        ["rca", existing.rca, updated.rca],
        ["ca", existing.ca, updated.ca],
        ["evidence", existing.evidence, updated.evidence],
        ["source_body", existing.sourceBody, updated.sourceBody],
      ];
      const changed = tracked.filter(([, a, b]) => a !== b).map(([f]) => f);
      if (existing.status !== updated.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${updated.status}`, actor);
      }
      await logChange(id, "update", changed.length ? `Updated: ${changed.join(", ")}` : "Saved (no field changes)", actor);
      return json(200, toClient(updated));
    }

    if (req.method === "DELETE") {
      // Only admins may delete records.
      if (!admin) return json(403, { error: "Only an administrator can delete records." });
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing record id." });
      const [existing] = await db.select().from(records).where(eq(records.id, id));
      if (!existing) return json(404, { error: "Record not found." });
      await db.delete(records).where(eq(records.id, id));
      await logChange(id, "delete", `Deleted ${existing.type} (${existing.severity}) — ${existing.clause || "no clause"}`, actor);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/records",
};
