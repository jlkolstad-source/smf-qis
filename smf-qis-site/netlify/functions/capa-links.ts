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
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const actor = actorString(user);

    if (req.method === "GET") {
      const capaId = url.searchParams.get("capa_id");
      const sourceId = url.searchParams.get("source_id");
      let rows;
      if (capaId) {
        rows = await db.select().from(capaLinks).where(eq(capaLinks.capaId, capaId)).orderBy(asc(capaLinks.id));
      } else if (sourceId) {
        rows = await db.select().from(capaLinks).where(eq(capaLinks.sourceId, sourceId)).orderBy(asc(capaLinks.id));
      } else {
        rows = await db.select().from(capaLinks).orderBy(asc(capaLinks.id));
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
        return json(201, toClient(created));
      }

      if (action === "delete") {
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
