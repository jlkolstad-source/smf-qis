// REST API for CAPA linkage rows, backed by Netlify Database.
//
// A CAPA can roll up many source items (NCRs, Audit Findings, OOS
// investigations, Crisis Exercises). Each link is one row in `capa_links`.
//
// Routes (all under /api/capa-links):
//   GET    /api/capa-links?capa_id=QIS-0001   → links for one CAPA
//   GET    /api/capa-links?source_id=NCR-...   → links pointing at one source
//   GET    /api/capa-links                     → all links
//   POST   /api/capa-links  { action: "create", capa_id, source_type, source_id }
//   POST   /api/capa-links  { action: "delete", id }
//
// The `linked_by` stamp is always taken from the signed-in identity, never the
// request body. Every mutation also writes a row to the shared `audit_log`.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { capaLinks, auditLog } from "../../db/schema.js";
import { getAuth, roleAtLeast, logAction } from "./lib/auth.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

// Full name + title for the audit trail; never the email when a name is set.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

async function logChange(recordId: string, action: string, detail: string, user: string) {
  await db.insert(auditLog).values({ recordId, action, detail, changedBy: user || "Unknown" });
}

function toISO(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return (v as string) || null;
}

function toClient(r: typeof capaLinks.$inferSelect) {
  return {
    id: r.id,
    capaId: r.capaId,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    linkedBy: r.linkedBy || "",
    linkedAt: toISO(r.linkedAt),
  };
}

// Sequential "LINK-####" id across all rows so ids never collide.
async function nextLinkId() {
  const rows = await db.select({ id: capaLinks.id }).from(capaLinks);
  let max = 0;
  for (const { id } of rows) {
    const m = /^LINK-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "LINK-" + String(max + 1).padStart(4, "0");
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });
    const user = auth.user;
    const actor = actorString(user);
    const canEdit = roleAtLeast(auth.role, "Member");
    const canManageLinks = roleAtLeast(auth.role, "Quality Manager");

    // Dock is read-only: any non-GET request from a role below Member is denied.
    if (req.method !== "GET" && !canEdit) {
      await logAction({
        email: auth.email,
        role: auth.role,
        action: "permission_denied",
        recordType: "capa_link",
      });
      return json(403, { error: "Your role does not have access to modify CAPA links." });
    }

    if (req.method === "GET") {
      // Links are fetched by capa_id or source_id — both indexed columns
      // (capa_links_capa_idx / capa_links_source_idx) — so each lookup is an
      // index scan rather than a full-table scan. Every branch is capped at 500
      // rows; a single CAPA or source never accumulates anywhere near that many
      // links, and the unfiltered "all" branch is bounded for safety.
      const capaId = url.searchParams.get("capa_id");
      const sourceId = url.searchParams.get("source_id");
      let rows;
      if (capaId) {
        rows = await db.select().from(capaLinks).where(eq(capaLinks.capaId, capaId)).orderBy(asc(capaLinks.id)).limit(500);
      } else if (sourceId) {
        rows = await db.select().from(capaLinks).where(eq(capaLinks.sourceId, sourceId)).orderBy(asc(capaLinks.id)).limit(500);
      } else {
        rows = await db.select().from(capaLinks).orderBy(asc(capaLinks.id)).limit(500);
      }
      return json(200, rows.map(toClient));
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = (url.searchParams.get("action") || body.action || "").toString();

      if (action === "create") {
        const capaId = (body.capa_id || body.capaId || "").toString().trim();
        const sourceType = (body.source_type || body.sourceType || "").toString().trim();
        const sourceId = (body.source_id || body.sourceId || "").toString().trim();
        if (!capaId) return json(400, { error: "Missing capa_id." });
        if (!sourceType) return json(400, { error: "Missing source_type." });
        if (!sourceId) return json(400, { error: "Missing source_id." });

        const id = await nextLinkId();
        const now = new Date();
        const [created] = await db
          .insert(capaLinks)
          .values({ id, capaId, sourceType, sourceId, linkedBy: actor, linkedAt: now })
          .returning();
        await logChange(capaId, "link", `Linked ${sourceType} ${sourceId} to CAPA ${capaId}`, actor);
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "link_added",
          recordType: "capa_link",
          recordId: capaId,
          detail: { sourceType, sourceId },
        });
        return json(201, toClient(created));
      }

      if (action === "delete") {
        if (!canManageLinks) {
          await logAction({
            email: auth.email,
            role: auth.role,
            action: "permission_denied",
            recordType: "capa_link",
            detail: { attempted: "unlink" },
          });
          return json(403, { error: "Unlinking records requires the Quality Manager role or above." });
        }
        const id = (body.id || "").toString().trim();
        if (!id) return json(400, { error: "Missing link id." });
        const [existing] = await db.select().from(capaLinks).where(eq(capaLinks.id, id));
        if (!existing) return json(404, { error: "Link not found." });
        await db.delete(capaLinks).where(eq(capaLinks.id, id));
        await logChange(
          existing.capaId,
          "unlink",
          `Removed link to ${existing.sourceType} ${existing.sourceId} from CAPA ${existing.capaId}`,
          actor
        );
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "link_removed",
          recordType: "capa_link",
          recordId: existing.capaId,
          detail: { sourceType: existing.sourceType, sourceId: existing.sourceId },
        });
        return json(200, { ok: true });
      }

      return json(400, { error: "Unknown action." });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/capa-links",
};
