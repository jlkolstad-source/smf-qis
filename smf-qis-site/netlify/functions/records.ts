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
import { eq, asc, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { records, auditLog } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
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
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
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

      const site = url.searchParams.get("site");
      const rows = site
        ? await db.select().from(records).where(eq(records.site, site)).orderBy(asc(records.id))
        : await db.select().from(records).orderBy(asc(records.id));
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const body = await req.json();
      const user = (body.user || "Unknown").toString();

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
            .values({ id, ...row, createdBy: user, createdAt: now, modifiedBy: user, modifiedAt: now })
            .onConflictDoUpdate({
              target: records.id,
              set: { ...row, modifiedBy: user, modifiedAt: now },
            });
          await logChange(id, existing ? "update" : "create", existing ? "Imported (updated)" : "Imported (created)", user);
          imported++;
        }
        return json(200, { ok: true, imported });
      }

      // Single create.
      const id = body.id && String(body.id).trim() ? String(body.id).trim() : await nextQisId();
      const now = new Date();
      const row = toRow(body);
      const [created] = await db
        .insert(records)
        .values({ id, ...row, createdBy: user, createdAt: now, modifiedBy: user, modifiedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "A record with id " + id + " already exists." });
      await logChange(id, "create", `Created ${created.type} (${created.severity}) — status ${created.status}`, user);
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const body = await req.json();
      const user = (body.user || "Unknown").toString();
      const id = (url.searchParams.get("id") || body.id || "").toString();
      if (!id) return json(400, { error: "Missing record id." });

      const [existing] = await db.select().from(records).where(eq(records.id, id));
      if (!existing) return json(404, { error: "Record not found." });

      const now = new Date();
      const row = toRow(body);
      // Preserve the original site unless one is explicitly supplied.
      if (!body.site) row.site = existing.site;

      const [updated] = await db
        .update(records)
        .set({ ...row, modifiedBy: user, modifiedAt: now })
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
      ];
      const changed = tracked.filter(([, a, b]) => a !== b).map(([f]) => f);
      if (existing.status !== updated.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${updated.status}`, user);
      }
      await logChange(id, "update", changed.length ? `Updated: ${changed.join(", ")}` : "Saved (no field changes)", user);
      return json(200, toClient(updated));
    }

    if (req.method === "DELETE") {
      const user = (url.searchParams.get("user") || "Unknown").toString();
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing record id." });
      const [existing] = await db.select().from(records).where(eq(records.id, id));
      if (!existing) return json(404, { error: "Record not found." });
      await db.delete(records).where(eq(records.id, id));
      await logChange(id, "delete", `Deleted ${existing.type} (${existing.severity}) — ${existing.clause || "no clause"}`, user);
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
