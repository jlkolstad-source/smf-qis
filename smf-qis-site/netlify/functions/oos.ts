// REST API for QIS Out of Specification (OOS) investigations, backed by Netlify
// Database for the structured record and Netlify Blobs for file attachments.
//
// OOS investigations are run under 21 CFR Part 111 and SQF Edition 9 for dietary
// supplement manufacturing.
//
// Routes (all under /api/oos):
//   GET    /api/oos?site=Lindon          → OOS records for a site (all if omitted)
//   GET    /api/oos?id=OOS-2026-001       → one OOS record (with attachment list)
//   GET    /api/oos?id=...&file=KEY       → download one attachment (binary)
//   POST   /api/oos                       → create an OOS record (auto-generates id)
//   POST   /api/oos?id=...&action=attach  → upload one file attachment to Blobs
//   PUT    /api/oos?id=...                → save / update an OOS record
//   DELETE /api/oos?id=...&file=KEY       → remove one attachment
//   DELETE /api/oos?id=...                → delete an OOS record + its files (admin)
//
// The initiated_by / closed_by / created_by / modified_by trail is always taken
// from the signed-in identity (full name and title — never the email), not from
// the request body. Every mutation also writes a row to the shared `audit_log`
// table keyed by the OOS id, giving a full audit trail.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { oosRecords, auditLog } from "../../db/schema.js";

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

// Identity string stamped into initiated_by / closed_by / created_by /
// modified_by. Per policy these show the full name and title, NOT the email.
// Falls back to email only when no profile name has been set.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

// The set of status values that represent a closed-out investigation.
const CLOSED_STATUSES = new Set(["Closed Invalidated", "Closed Confirmed"]);

async function logChange(oosId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId: oosId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

const ATTACH_STORE = "oos-attachments";

// Lazily import @netlify/blobs only when an attachment route actually needs it.
// Loading it at module scope means any problem initialising the Blobs client
// crashes the whole function on cold start — taking down the create, list, and
// update routes that never touch Blobs at all (the source of the OOS 502s).
// Deferring the import keeps those routes working regardless of Blobs state.
let _getStore: typeof import("@netlify/blobs").getStore | undefined;
async function blobStore(name: string) {
  if (!_getStore) {
    ({ getStore: _getStore } = await import("@netlify/blobs"));
  }
  return _getStore(name);
}

// Shape an OOS row for the client.
function toClient(r: typeof oosRecords.$inferSelect) {
  const createdISO = toISO(r.createdAt);
  return {
    id: r.id,
    site: r.site || "",
    materialType: r.materialType || "",
    productName: r.productName || "",
    supplier: r.supplier || "",
    internalLot: r.internalLot || "",
    supplierLot: r.supplierLot || "",
    batchRecordNumber: r.batchRecordNumber || "",
    manufacturingDate: r.manufacturingDate || "",
    expirationDate: r.expirationDate || "",
    testAnalyte: r.testAnalyte || "",
    testMethod: r.testMethod || "",
    specification: r.specification || "",
    resultObtained: r.resultObtained || "",
    units: r.units || "",
    passFail: r.passFail || "",
    classification: r.classification || "",
    phase1Notes: r.phase1Notes || "",
    phase2Notes: r.phase2Notes || "",
    rootCause: r.rootCause || "",
    rootCauseCategory: r.rootCauseCategory || "",
    correctiveAction: r.correctiveAction || "",
    disposition: r.disposition || "Pending",
    capaId: r.capaId || "",
    status: r.status || "Open",
    initiatedBy: r.initiatedBy || "",
    closedBy: r.closedBy || "",
    closedDate: r.closedDate || "",
    attachments: arr(r.attachments),
    signatures: arr(r.signatures),
    dateInitiated: createdISO ? createdISO.slice(0, 10) : "",
    createdBy: r.createdBy || "",
    createdAt: createdISO,
    modifiedBy: r.modifiedBy || "",
    modifiedAt: toISO(r.modifiedAt),
  };
}

// Site abbreviation used in the auto-generated OOS ids. Lindon → LDN, any
// Layton facility → LAY, and any all-sites / unset scope → ALL.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

// Next "OOS-[SITE]-[YYYY]-[####]" id. The running number is scoped to the
// (site, year) pair: every existing OOS record at the same site whose id carries
// the same year segment is scanned, the trailing numeric run is extracted from
// the end of each id regardless of its prefix format, the highest is found and
// incremented by one (zero-padded to four digits). Each year resets independently.
async function nextOosId(site: string, year: string) {
  const rows = await db.select({ id: oosRecords.id, site: oosRecords.site }).from(oosRecords);
  const re = new RegExp("-" + year + "-(\\d+)$");
  let max = 0;
  for (const r of rows) {
    if (r.site !== site) continue;
    const m = re.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `OOS-${siteAbbr(site)}-${year}-${String(max + 1).padStart(4, "0")}`;
}

// Normalise an incoming OOS payload into column values. Only client-editable
// fields are copied; identity / audit / closure columns are stamped separately.
function toRow(r: any) {
  return {
    site: r.site || "Lindon",
    materialType: r.materialType || "",
    productName: r.productName || "",
    supplier: r.supplier || "",
    internalLot: r.internalLot || "",
    supplierLot: r.supplierLot || "",
    batchRecordNumber: r.batchRecordNumber || "",
    manufacturingDate: r.manufacturingDate || "",
    expirationDate: r.expirationDate || "",
    testAnalyte: r.testAnalyte || "",
    testMethod: r.testMethod || "",
    specification: r.specification || "",
    resultObtained: r.resultObtained || "",
    units: r.units || "",
    passFail: r.passFail || "",
    classification: r.classification || "",
    phase1Notes: r.phase1Notes || "",
    phase2Notes: r.phase2Notes || "",
    rootCause: r.rootCause || "",
    rootCauseCategory: r.rootCauseCategory || "",
    correctiveAction: r.correctiveAction || "",
    disposition: r.disposition || "Pending",
    capaId: r.capaId || "",
    status: r.status || "Open",
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

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const actor = actorString(user);
    const admin = isAdmin(user);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const fileKey = url.searchParams.get("file");

      // ── Download one attachment (binary) ──────────────────────────────────
      if (id && fileKey) {
        const [rec] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
        if (!rec) return json(404, { error: "OOS record not found." });
        const meta = arr(rec.attachments).find((a: any) => a.key === fileKey);
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
        const [rec] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
        if (!rec) return json(404, { error: "OOS record not found." });
        return json(200, toClient(rec));
      }

      const site = url.searchParams.get("site");
      const rows = site
        ? await db.select().from(oosRecords).where(eq(oosRecords.site, site)).orderBy(asc(oosRecords.id))
        : await db.select().from(oosRecords).orderBy(asc(oosRecords.id));
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");

      // ── Upload one file attachment to Netlify Blobs ───────────────────────
      if (id && action === "attach") {
        const [rec] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
        if (!rec) return json(404, { error: "OOS record not found." });
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
        await store.set(key, bytes, { metadata: { contentType, filename, oosId: id } });
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
          .update(oosRecords)
          .set({ attachments, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(oosRecords.id, id));
        await logChange(id, "attachment", `Attached "${filename}" (${description || "no description"})`, actor);
        return json(201, entry);
      }

      // ── Electronic sign-off on a signature row, by role ───────────────────
      // Finds the matching signature row by role, stamps the signed-in user's
      // name + title + timestamp on it, and moves the record to "Signed".
      if (id && action === "sign") {
        const [existing] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
        if (!existing) return json(404, { error: "OOS record not found." });
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
        const now = new Date();
        const [updated] = await db
          .update(oosRecords)
          .set({ signatures, status: "Signed", modifiedBy: actor, modifiedAt: now })
          .where(eq(oosRecords.id, id))
          .returning();
        await logChange(id, "signoff", `Electronic sign-off (${role}) by ${signerName}`, actor);
        return json(200, toClient(updated));
      }

      // ── Create a new OOS record ───────────────────────────────────────────
      const body = await req.json().catch(() => ({}));
      const year = String(new Date().getFullYear());
      const now = new Date();
      const row = toRow(body);
      const newId = await nextOosId(row.site, year);
      const [created] = await db
        .insert(oosRecords)
        .values({
          id: newId,
          ...row,
          initiatedBy: actor,
          attachments: [],
          createdBy: actor,
          createdAt: now,
          modifiedBy: actor,
          modifiedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return json(409, { error: "OOS id collision, please retry." });
      await logChange(
        newId,
        "create",
        `Created OOS investigation — ${created.materialType || "material"} / ${created.productName || "(unnamed)"} · ${created.testAnalyte || "test"}`,
        actor,
      );
      return json(201, toClient(created));
    }

    if (req.method === "PUT") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing OOS id." });
      const [existing] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
      if (!existing) return json(404, { error: "OOS record not found." });

      const body = await req.json();
      const now = new Date();
      const row = toRow(body);
      if (!body.site) row.site = existing.site;

      // OOS record IDs are permanent and non-editable. Any id field in the
      // request body is ignored — the id is never changed by an update.

      // Only admins may close out an OOS investigation.
      const closingNow = CLOSED_STATUSES.has(row.status) && !CLOSED_STATUSES.has(existing.status);
      if (closingNow && !admin) {
        return json(403, { error: "Only an administrator can close an OOS investigation." });
      }

      // Auto-fill / clear closure stamps based on the status transition.
      let closedBy = existing.closedBy;
      let closedDate = existing.closedDate;
      if (closingNow) {
        closedBy = actor;
        closedDate = now.toISOString().slice(0, 10);
      } else if (!CLOSED_STATUSES.has(row.status) && CLOSED_STATUSES.has(existing.status)) {
        closedBy = "";
        closedDate = "";
      }

      const [updated] = await db
        .update(oosRecords)
        .set({ ...row, closedBy, closedDate, modifiedBy: actor, modifiedAt: now })
        .where(eq(oosRecords.id, id))
        .returning();

      if (existing.status !== updated.status) {
        await logChange(id, "status_change", `Status ${existing.status} → ${updated.status}`, actor);
      }
      if (existing.disposition !== updated.disposition) {
        await logChange(id, "disposition", `Disposition ${existing.disposition} → ${updated.disposition}`, actor);
      }
      await logChange(id, "update", "OOS record saved", actor);
      return json(200, toClient(updated));
    }

    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") || "").toString();
      if (!id) return json(400, { error: "Missing OOS id." });
      const fileKey = url.searchParams.get("file");
      const [existing] = await db.select().from(oosRecords).where(eq(oosRecords.id, id));
      if (!existing) return json(404, { error: "OOS record not found." });

      // ── Remove a single attachment ────────────────────────────────────────
      if (fileKey) {
        const meta = arr(existing.attachments).find((a: any) => a.key === fileKey);
        if (!meta) return json(404, { error: "Attachment not found." });
        const store = await blobStore(ATTACH_STORE);
        await store.delete(fileKey).catch(() => {});
        const attachments = arr(existing.attachments).filter((a: any) => a.key !== fileKey);
        await db
          .update(oosRecords)
          .set({ attachments, modifiedBy: actor, modifiedAt: new Date() })
          .where(eq(oosRecords.id, id));
        await logChange(id, "attachment", `Removed attachment "${meta.filename || fileKey}"`, actor);
        return json(200, { ok: true });
      }

      // ── Delete the whole record (admin only) ──────────────────────────────
      if (!admin) return json(403, { error: "Only an administrator can delete OOS records." });
      const store = await blobStore(ATTACH_STORE);
      for (const a of arr(existing.attachments)) {
        await store.delete(a.key).catch(() => {});
      }
      await db.delete(oosRecords).where(eq(oosRecords.id, id));
      await logChange(id, "delete", `Deleted OOS investigation ${id}`, actor);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/oos",
};
