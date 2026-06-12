// REST API for the Food Safety Culture Survey module, backed by Netlify
// Database. A survey is scored on a 1-5.00 scale; the 0-100 `percentage_score`
// is the value the UI shows as the primary number so culture metrics line up
// with the other 0-100% QIS KPIs (the raw 5.0 score is never multiplied by 20).
//
// Routes (all under /api/culture-survey):
//   GET    /api/culture-survey?site=Lindon          → surveys for a site, newest first
//   GET    /api/culture-survey?id=CSR-LDN-2026-0001 → one survey + its categories
//   POST   /api/culture-survey  { action:"create", ... }         → save a new survey
//   POST   /api/culture-survey  { action:"sync-sharepoint", ...} → pull latest from SharePoint
//
// Every response is JSON. Unauthenticated requests get a 401. All handlers are
// wrapped in try/catch so failures surface as a meaningful JSON error message.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { getAuth, roleAtLeast, logAction } from "./lib/auth.js";
import { eq, asc, desc } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "../../db/index.js";
import { cultureSurveys, cultureSurveyCategories } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// The nine categories every Food Safety Culture survey scores, in display order.
const CATEGORY_NAMES = [
  "Management Commitment",
  "Communication",
  "Training and Competency",
  "Employee Empowerment",
  "Hazard Knowledge",
  "Teamwork",
  "Change Management",
  "Contamination Prevention",
  "Personal Accountability",
];

// SharePoint drive + item the survey workbook lives at (Microsoft Graph).
const GRAPH_FILE_URL =
  "https://graph.microsoft.com/v1.0/drives/b!5dll_2VB4ku03lbR50PlUnOCtNA-dqlHjT533U6Llld9Nbp1BiB7TqGUrcX1wXxy/items/01L2RYW64BPWHWJHAYCFBZEBZOLEWD3QR7/content";

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

// Site abbreviation used in the generated ids (mirrors the other modules):
// Lindon → LDN, any Layton facility → LAY, all-sites / unset → ALL.
function siteAbbr(site: string): string {
  const s = (site || "").trim().toLowerCase();
  if (s === "lindon") return "LDN";
  if (s.includes("layton")) return "LAY";
  if (s === "all sites" || s === "all" || s === "") return "ALL";
  return (site || "SMF").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SMF";
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Highest existing sequential number for a "CSR-[SITE]-[YYYY]-" prefix, so a new
// survey id can be allocated one past it without colliding.
async function highestSeq(prefix: string): Promise<number> {
  const rows = await db.select({ id: cultureSurveys.id }).from(cultureSurveys);
  const re = new RegExp("^" + escapeRegExp(prefix) + "(\\d+)$");
  let max = 0;
  for (const { id } of rows) {
    const m = re.exec(id as string);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// Derive the colour-coding status from a 0-100 percentage score.
function deriveStatus(pct: number): string {
  if (pct >= 80) return "Good";
  if (pct >= 60) return "Needs Attention";
  return "Critical";
}

// Derive the action priority from the share of low ratings for a category.
function derivePriority(lowPct: number): string {
  if (lowPct >= 30) return "HIGH";
  if (lowPct >= 20) return "MEDIUM";
  if (lowPct > 0) return "LOW";
  return "OK";
}

function num(v: any, dflt = 0): number {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : dflt;
}

// Shape a survey row + its categories into the object the front-end consumes.
function toClient(survey: typeof cultureSurveys.$inferSelect, cats: (typeof cultureSurveyCategories.$inferSelect)[]) {
  const createdISO = survey.createdAt instanceof Date ? survey.createdAt.toISOString() : (survey.createdAt as any) || null;
  return {
    id: survey.id,
    site: survey.site,
    surveyPeriod: survey.surveyPeriod || "",
    surveyDate: survey.surveyDate || "",
    overallScore: num(survey.overallScore),
    percentageScore: num(survey.percentageScore),
    totalResponses: survey.totalResponses || 0,
    targetScore: num(survey.targetScore, 80),
    sqfRating: survey.sqfRating || "",
    sharepointFileUrl: survey.sharepointFileUrl || "",
    createdBy: survey.createdBy || "",
    createdAt: createdISO,
    categories: cats.map((c) => ({
      id: c.id,
      categoryName: c.categoryName,
      score: num(c.score),
      percentageScore: num(c.percentageScore),
      status: c.status || "Good",
      lowRatingPct: num(c.lowRatingPct),
      priority: c.priority || "OK",
    })),
  };
}

// Persist a fully-formed survey (header + nine categories) as a new record with
// an auto-generated CSR id. `categories` may carry explicit status/priority or
// leave them blank, in which case they are derived from the numbers.
async function createSurvey(payload: any, actor: string, sharepointUrl = "") {
  const site = (payload.site || "Lindon").toString();
  // Pull a 4-digit year from anywhere in the (free-text) survey date for the id.
  const yearMatch = /(\d{4})/.exec(String(payload.surveyDate || ""));
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
  const prefix = `CSR-${siteAbbr(site)}-${year}-`;

  const cats = Array.isArray(payload.categories) ? payload.categories : [];
  const header = {
    site,
    surveyPeriod: (payload.surveyPeriod || "").toString(),
    surveyDate: (payload.surveyDate || "").toString(),
    overallScore: String(num(payload.overallScore)),
    percentageScore: String(num(payload.percentageScore)),
    totalResponses: Math.round(num(payload.totalResponses)),
    targetScore: String(num(payload.targetScore, 80)),
    sqfRating: (payload.sqfRating || "").toString(),
    sharepointFileUrl: sharepointUrl,
    createdBy: actor,
  };

  // Allocate a unique id; onConflictDoNothing makes the loop retry the next
  // number when a candidate id is already taken.
  let seq = await highestSeq(prefix);
  let created: typeof cultureSurveys.$inferSelect | undefined;
  let newId = "";
  for (let attempt = 0; attempt < 100 && !created; attempt++) {
    seq += 1;
    newId = `${prefix}${String(seq).padStart(4, "0")}`;
    [created] = await db
      .insert(cultureSurveys)
      .values({ id: newId, ...header })
      .onConflictDoNothing()
      .returning();
  }
  if (!created) throw new Error("Could not generate a unique survey id, please retry.");

  const catRows = cats.map((c: any, i: number) => {
    const pct = num(c.percentageScore);
    const low = num(c.lowRatingPct);
    return {
      id: `${newId}-C${String(i + 1).padStart(2, "0")}`,
      surveyId: newId,
      categoryName: (c.categoryName || "").toString(),
      score: String(num(c.score)),
      percentageScore: String(pct),
      status: (c.status || deriveStatus(pct)).toString(),
      lowRatingPct: String(low),
      priority: (c.priority || derivePriority(low)).toString(),
    };
  });
  if (catRows.length) await db.insert(cultureSurveyCategories).values(catRows);

  const saved = await db.select().from(cultureSurveyCategories).where(eq(cultureSurveyCategories.surveyId, newId)).orderBy(asc(cultureSurveyCategories.id));
  return toClient(created, saved);
}

// ── Workbook parsing ─────────────────────────────────────────────────────────
// The Food Safety Culture Survey workbook has a fixed layout, so the figures are
// read from their exact cells rather than searched for. The two sheets that
// matter are:
//
//   "SQF Dashboard"      — the at-a-glance summary
//     A7  overall culture score (1-5)      E7  percentage score ("85%")
//     I7  total responses                  rows 14-22: the nine categories,
//     col A category name · col B score (1-5) · col C "%" · col D status glyph
//
//   "SQF Culture Report" — the detailed report
//     B8  survey period ("April 19 - May 6, 2026")
//     A2  "...| Report Generated: May 6, 2026"   (survey date is parsed from here)
//     B83 SQF maturity rating
//
// Anything that cannot be read is returned as null so the caller can save what
// it did find and report the rest as missing rather than failing the whole save.

type ParsedCategory = {
  categoryName: string;
  score: number | null;
  percentageScore: number | null;
  status: string | null;
  lowRatingPct: number | null;
  priority: string | null;
};
type ParsedSurvey = {
  overallScore: number | null;
  percentageScore: number | null;
  totalResponses: number | null;
  surveyPeriod: string | null;
  surveyDate: string | null;
  sqfRating: string | null;
  categories: ParsedCategory[];
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Raw value of a single cell (e.g. "A7"), or null when the cell is empty/absent.
function cellVal(ws: XLSX.WorkSheet, addr: string): any {
  const c = (ws as any)[addr];
  if (!c) return null;
  return c.v != null ? c.v : c.w != null ? c.w : null;
}

// Numeric value of a cell, tolerant of "%"/text decoration. null if not numeric.
function cellNum(ws: XLSX.WorkSheet, addr: string): number | null {
  const v = cellVal(ws, addr);
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Trimmed text value of a cell, or null when empty.
function cellText(ws: XLSX.WorkSheet, addr: string): string | null {
  const v = cellVal(ws, addr);
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Map the dashboard's status glyph (✓ / ⚠ / ✗) to a status label, falling back
// to deriving it from the percentage when the glyph is missing/unrecognised.
function statusFromGlyph(glyph: any, pct: number | null): string | null {
  const s = String(glyph ?? "").trim();
  if (s.includes("✓") || s.includes("✔")) return "Good"; // ✓ ✔
  if (s.includes("⚠")) return "Needs Attention"; // ⚠
  if (s.includes("✗") || s.includes("✘") || s.includes("✖")) return "Critical"; // ✗ ✘ ✖
  return pct != null ? deriveStatus(pct) : null;
}

// Normalise a date string such as "May 6, 2026" (or an embedded ISO date) into
// "YYYY-MM-DD" so it sorts correctly and feeds the id's year. null if unparsable.
function normalizeDate(text: string | null | undefined): string | null {
  const t = String(text || "");
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return iso[0];
  const m = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
  }
  return null;
}

// Extract the survey from a parsed workbook using the known cell layout. Every
// cell read is logged so a future layout change can be diagnosed from the logs.
function extractSurvey(wb: XLSX.WorkBook): ParsedSurvey {
  console.log("[culture-survey] workbook sheet names:", JSON.stringify(wb.SheetNames));

  const dashName = wb.SheetNames.find((n) => /dashboard/i.test(n)) || wb.SheetNames[0];
  const reportName = wb.SheetNames.find((n) => /report/i.test(n));
  console.log(`[culture-survey] using dashboard sheet "${dashName}", report sheet "${reportName || "(none)"}"`);

  const dash = wb.Sheets[dashName];
  const overallScore = cellNum(dash, "A7");
  const percentageScore = cellNum(dash, "E7");
  const totalResponses = totalResponsesInt(cellNum(dash, "I7"));
  console.log(
    `[culture-survey] dashboard A7 overall=${overallScore} E7 percentage=${percentageScore} I7 responses=${totalResponses}`
  );

  // The nine categories sit in dashboard rows 14-22 in the canonical order, so
  // each is read positionally rather than by matching its (variably-worded) name.
  const categories: ParsedCategory[] = CATEGORY_NAMES.map((name, i) => {
    const row = 14 + i;
    const score = cellNum(dash, `B${row}`);
    const pct = cellNum(dash, `C${row}`);
    const glyph = cellVal(dash, `D${row}`);
    const status = statusFromGlyph(glyph, pct);
    console.log(
      `[culture-survey] category "${name}" (row ${row}): B=${score} C=${pct} D=${JSON.stringify(glyph)} -> status=${status}`
    );
    // low_rating_pct / priority are not broken out per category in this workbook.
    return { categoryName: name, score, percentageScore: pct, status, lowRatingPct: null, priority: null };
  });

  let surveyPeriod: string | null = null;
  let surveyDate: string | null = null;
  let sqfRating: string | null = null;
  if (reportName) {
    const rep = wb.Sheets[reportName];
    surveyPeriod = cellText(rep, "B8");
    sqfRating = cellText(rep, "B83");
    const a2 = String(cellVal(rep, "A2") || "");
    const gen = /Report Generated:\s*(.+)$/i.exec(a2);
    surveyDate = normalizeDate(gen ? gen[1] : a2) || normalizeDate(surveyPeriod);
    console.log(
      `[culture-survey] report B8 period=${JSON.stringify(surveyPeriod)} B83 rating=${JSON.stringify(
        sqfRating
      )} A2=${JSON.stringify(a2)} -> surveyDate=${surveyDate}`
    );
  }

  return { overallScore, percentageScore, totalResponses, surveyPeriod, surveyDate, sqfRating, categories };
}

function totalResponsesInt(n: number | null): number | null {
  return n == null ? null : Math.round(n);
}

// Build the {found, missing} breakdown for an extracted survey, used both to
// guard the save and to tell the front-end exactly what was and wasn't read.
function fieldReport(p: ParsedSurvey): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  const core: Record<string, unknown> = {
    overall_score: p.overallScore,
    percentage_score: p.percentageScore,
    total_responses: p.totalResponses,
    survey_period: p.surveyPeriod,
    survey_date: p.surveyDate,
    sqf_rating: p.sqfRating,
  };
  for (const [k, v] of Object.entries(core)) (v == null || v === "" ? missing : found).push(k);
  for (const c of p.categories) {
    (c.score != null || c.percentageScore != null ? found : missing).push(`category:${c.categoryName}`);
  }
  return { found, missing };
}

// Shape an extracted survey into the payload createSurvey() expects. Front-end
// overrides (e.g. an explicit site/period) win over what was read from the file.
function parsedToPayload(p: ParsedSurvey, site: string, overrides: any = {}) {
  return {
    site,
    surveyPeriod: overrides.surveyPeriod || p.surveyPeriod || "",
    surveyDate: overrides.surveyDate || p.surveyDate || new Date().toISOString().slice(0, 10),
    overallScore: p.overallScore,
    percentageScore: p.percentageScore,
    totalResponses: p.totalResponses,
    targetScore: 80,
    sqfRating: overrides.sqfRating || p.sqfRating || "",
    categories: p.categories,
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });
    const user = auth.user;
    const actor = actorString(user);
    const canEdit = roleAtLeast(auth.role, "Member");

    // Culture surveys are not a truck-inspection module, so Dock is read-only:
    // any non-GET request requires at least the Member role.
    if (req.method !== "GET" && !canEdit) {
      await logAction({
        email: auth.email,
        role: auth.role,
        action: "permission_denied",
        recordType: "Culture Survey",
        site: auth.roleSite,
      });
      return json(403, { error: "Your role does not have access to modify culture surveys." });
    }

    if (req.method === "GET") {
      // Single survey + its categories.
      const id = url.searchParams.get("id");
      if (id) {
        const [survey] = await db.select().from(cultureSurveys).where(eq(cultureSurveys.id, id));
        if (!survey) return json(404, { error: "Survey not found." });
        const cats = await db
          .select()
          .from(cultureSurveyCategories)
          .where(eq(cultureSurveyCategories.surveyId, id))
          .orderBy(asc(cultureSurveyCategories.id));
        return json(200, toClient(survey, cats));
      }

      // Survey list for a site, newest first. Categories are included on each so
      // the dashboard culture tile and trend can render without extra round-trips.
      const site = url.searchParams.get("site");
      const rows = await db
        .select()
        .from(cultureSurveys)
        .where(site ? eq(cultureSurveys.site, site) : undefined)
        .orderBy(desc(cultureSurveys.surveyDate))
        .limit(200);
      const all = await Promise.all(
        rows.map(async (s) => {
          const cats = await db
            .select()
            .from(cultureSurveyCategories)
            .where(eq(cultureSurveyCategories.surveyId, s.id))
            .orderBy(asc(cultureSurveyCategories.id));
          return toClient(s, cats);
        })
      );
      return json(200, all);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = (url.searchParams.get("action") || body.action || "").toString();

      if (action === "create") {
        const saved = await createSurvey(body, actor);
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "record_created",
          recordType: "Culture Survey",
          recordId: saved.id,
          site: saved.site,
        });
        return json(201, saved);
      }

      // Manual upload — the front-end sends the .xlsx as base64; everything is
      // parsed and saved server-side so the exact cell reads can be logged and
      // the response can report precisely which fields were found vs missing.
      if (action === "upload") {
        const b64 = (body.fileBase64 || body.file || "").toString();
        if (!b64) return json(400, { error: "No file was provided in the upload.", found: [], missing: ["file"] });

        let wb: XLSX.WorkBook;
        try {
          const buf = Buffer.from(b64, "base64");
          wb = XLSX.read(buf, { type: "buffer" });
        } catch (e: any) {
          return json(422, {
            error: "Could not read the uploaded file as an Excel workbook: " + (e?.message || "unknown format"),
            found: [],
            missing: [],
          });
        }

        const parsed = extractSurvey(wb);
        const { found, missing } = fieldReport(parsed);
        console.log(`[culture-survey] upload found=[${found.join(", ")}] missing=[${missing.join(", ")}]`);

        // Need at least one real score to have something worth saving.
        const haveScores =
          parsed.percentageScore != null ||
          parsed.overallScore != null ||
          parsed.categories.some((c) => c.score != null || c.percentageScore != null);
        if (!haveScores) {
          return json(422, {
            error:
              "No survey scores could be read from that file. Make sure it is the Food Safety Culture Survey workbook with the 'SQF Dashboard' sheet.",
            found,
            missing,
          });
        }

        const site = (body.site || url.searchParams.get("site") || "Lindon").toString();
        const payload = parsedToPayload(parsed, site, body);
        const sourceLabel = body.filename ? `upload:${body.filename}` : "upload";
        let saved;
        try {
          saved = await createSurvey(payload, actor, sourceLabel);
        } catch (e: any) {
          // Don't collapse a save failure into a generic 500 — tell the caller
          // exactly what was parsed so the problem can be diagnosed.
          console.error("[culture-survey] upload save failed:", e?.message || e);
          return json(500, {
            error: "The survey was parsed but could not be saved: " + (e?.message || "database error"),
            found,
            missing,
            parsed,
          });
        }
        console.log(`[culture-survey] upload saved survey ${saved.id} for site ${site}`);
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "record_created",
          recordType: "Culture Survey",
          recordId: saved.id,
          site: saved.site,
        });
        return json(201, { survey: saved, found, missing });
      }

      if (action === "sync-sharepoint") {
        const token = process.env.MICROSOFT_GRAPH_TOKEN;
        if (!token) {
          return json(400, {
            error:
              "SharePoint sync is not configured — set the MICROSOFT_GRAPH_TOKEN environment variable, or use Upload Survey to add the file manually.",
          });
        }
        let res: Response;
        try {
          res = await fetch(GRAPH_FILE_URL, { headers: { Authorization: `Bearer ${token}` } });
        } catch (e: any) {
          return json(502, { error: "Could not reach SharePoint: " + (e?.message || "network error") });
        }
        if (!res.ok) {
          return json(502, { error: `SharePoint download failed (HTTP ${res.status}).` });
        }
        const buf = await res.arrayBuffer();
        let parsed: ParsedSurvey;
        try {
          parsed = extractSurvey(XLSX.read(buf, { type: "array" }));
        } catch (e: any) {
          return json(422, { error: "Could not parse the survey workbook: " + (e?.message || "unknown format") });
        }
        const { found, missing } = fieldReport(parsed);
        const site = (body.site || url.searchParams.get("site") || "Lindon").toString();
        const payload = parsedToPayload(parsed, site, body);
        try {
          const saved = await createSurvey(payload, actor, GRAPH_FILE_URL);
          await logAction({
            email: auth.email,
            role: auth.role,
            action: "record_created",
            recordType: "Culture Survey",
            recordId: saved.id,
            site: saved.site,
          });
          return json(201, { survey: saved, found, missing });
        } catch (e: any) {
          console.error("[culture-survey] sharepoint save failed:", e?.message || e);
          return json(500, {
            error: "The survey was parsed but could not be saved: " + (e?.message || "database error"),
            found,
            missing,
          });
        }
      }

      return json(400, { error: "Unknown action." });
    }

    return json(405, { error: "Method not allowed." });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/culture-survey",
};
