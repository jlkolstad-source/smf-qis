// REST API for the editable narrative drafts behind the Monthly Quality Flash
// Report and the Annual Management Review, backed by Netlify Database.
//
// The reports themselves compute every metric live from the records / OOS /
// crisis tables at generation time — none of those numbers are stored. Only the
// free-text narrative a reviewer types (attendees, policy-update notes, supplier
// performance notes, quality-objective tables, management decisions, …) is
// persisted here, keyed by (report type, period, site), so a report can be saved
// and resumed across multiple sessions.
//
// Routes (all under /api/report-drafts):
//   GET /api/report-drafts?type=monthly-flash&period=2026-05&site=Lindon
//        → the saved draft data object ({} when none exists yet)
//   PUT /api/report-drafts?type=...&period=...&site=...   body: { data: {...} }
//        → upsert the draft data object, returning the stored row
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { reportDrafts } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

// Full name and title, never the email — matches the rest of the audit trail.
function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

const VALID_TYPES = new Set(["monthly-flash", "annual-review"]);

// Read and validate the (type, period, site) key from the query string.
function keyFromUrl(url: URL): { reportType: string; period: string; site: string } | null {
  const reportType = (url.searchParams.get("type") || "").trim();
  const period = (url.searchParams.get("period") || "").trim();
  const site = (url.searchParams.get("site") || "").trim();
  if (!VALID_TYPES.has(reportType) || !period) return null;
  return { reportType, period, site };
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });

    const key = keyFromUrl(url);
    if (!key) return json(400, { error: "Missing or invalid type/period." });

    if (req.method === "GET") {
      const [row] = await db
        .select()
        .from(reportDrafts)
        .where(
          and(
            eq(reportDrafts.reportType, key.reportType),
            eq(reportDrafts.period, key.period),
            eq(reportDrafts.site, key.site),
          ),
        );
      return json(200, {
        data: (row && row.data) || {},
        updatedBy: (row && row.updatedBy) || "",
        updatedAt: row && row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row && (row.updatedAt as any)) || null,
      });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const data = body && typeof body.data === "object" && body.data ? body.data : {};
      const actor = actorString(user);
      const now = new Date();
      const [saved] = await db
        .insert(reportDrafts)
        .values({ ...key, data, updatedBy: actor, updatedAt: now })
        .onConflictDoUpdate({
          target: [reportDrafts.reportType, reportDrafts.period, reportDrafts.site],
          set: { data, updatedBy: actor, updatedAt: now },
        })
        .returning();
      return json(200, {
        data: saved.data || {},
        updatedBy: saved.updatedBy || "",
        updatedAt: saved.updatedAt instanceof Date ? saved.updatedAt.toISOString() : (saved.updatedAt as any) || null,
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/report-drafts",
};
