// REST API for role-based access control, backed by Netlify Database.
//
// Routes (all under /api/user-roles):
//   GET  /api/user-roles?action=my-role     → the caller's own role (any auth user)
//   GET  /api/user-roles?action=list        → all role assignments (Admin only)
//   GET  /api/user-roles?action=action-log  → the access-control action log (Admin)
//        optional filters: user=<email>, type=<actionType>, page=<n> (100/page)
//   POST /api/user-roles  { action: "assign", email, role, site }   (Admin only)
//   POST /api/user-roles  { action: "remove", email }               (Admin only)
//
// The seed admins (jkolstad@somafina.com, chinson@somafina.com) are inserted on
// first use by the shared auth helper. Every role change and every admin read is
// recorded in the action_log for the 21 CFR Part 11 access-control trail.
import type { Config } from "@netlify/functions";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userRoles, actionLog } from "../../db/schema.js";
import {
  getAuth,
  roleAtLeast,
  normalizeRole,
  ROLES,
  logAction,
  jsonResponse as json,
} from "./lib/auth.js";

function toClient(r: typeof userRoles.$inferSelect) {
  return {
    email: r.email,
    role: r.role,
    site: r.site || "ALL",
    assignedBy: r.assignedBy || "",
    assignedAt: r.assignedAt instanceof Date ? r.assignedAt.toISOString() : r.assignedAt || null,
  };
}

const PAGE_SIZE = 100;

export default async (req: Request) => {
  const url = new URL(req.url);

  try {
    const auth = await getAuth();
    if (!auth) return json(401, { error: "Sign in required." });

    if (req.method === "GET") {
      const action = (url.searchParams.get("action") || "").toString();

      // Any authenticated user may read their own role.
      if (action === "my-role" || action === "") {
        return json(200, { email: auth.email, role: auth.role, site: auth.roleSite });
      }

      // Everything else is Admin-only.
      if (!roleAtLeast(auth.role, "Admin")) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "user_roles", detail: { action } });
        return json(403, { error: "Only an administrator may view role assignments." });
      }

      if (action === "list") {
        const rows = await db.select().from(userRoles).orderBy(desc(userRoles.assignedAt)).limit(1000);
        return json(200, rows.map(toClient));
      }

      if (action === "action-log") {
        const userFilter = (url.searchParams.get("user") || "").trim().toLowerCase();
        const typeFilter = (url.searchParams.get("type") || "").trim();
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);

        const conds: any[] = [];
        if (userFilter) conds.push(eq(actionLog.userEmail, userFilter));
        if (typeFilter) conds.push(eq(actionLog.action, typeFilter));
        const where = conds.length ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;

        const base = db.select().from(actionLog);
        const rows = await (where ? base.where(where) : base)
          .orderBy(desc(actionLog.timestamp))
          .limit(PAGE_SIZE + 1)
          .offset((page - 1) * PAGE_SIZE);

        const hasMore = rows.length > PAGE_SIZE;
        const slice = rows.slice(0, PAGE_SIZE).map((r) => ({
          id: r.id,
          timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
          userEmail: r.userEmail,
          userRole: r.userRole,
          action: r.action,
          recordType: r.recordType,
          recordId: r.recordId,
          site: r.site,
          detail: r.detail || {},
        }));
        return json(200, { rows: slice, page, pageSize: PAGE_SIZE, hasMore });
      }

      return json(400, { error: "Unknown action." });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = (url.searchParams.get("action") || body.action || "").toString();

      // All role mutations are Admin-only.
      if (!roleAtLeast(auth.role, "Admin")) {
        await logAction({ email: auth.email, role: auth.role, action: "permission_denied", recordType: "user_roles", detail: { action } });
        return json(403, { error: "Only an administrator may assign or remove roles." });
      }

      if (action === "assign") {
        const email = (body.email || "").toString().trim().toLowerCase();
        const role = normalizeRole(body.role);
        const site = (body.site || "ALL").toString().trim() || "ALL";
        if (!email || !email.includes("@")) return json(400, { error: "A valid email is required." });
        if (!ROLES.includes(role)) return json(400, { error: "Invalid role." });

        const now = new Date();
        await db
          .insert(userRoles)
          .values({ email, role, site, assignedBy: auth.email, assignedAt: now })
          .onConflictDoUpdate({
            target: userRoles.email,
            set: { role, site, assignedBy: auth.email, assignedAt: now },
          });
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "role_assigned",
          recordType: "user_roles",
          recordId: email,
          site,
          detail: { targetEmail: email, role, site },
        });
        return json(200, { ok: true, email, role, site });
      }

      if (action === "remove") {
        const email = (body.email || "").toString().trim().toLowerCase();
        if (!email) return json(400, { error: "An email is required." });
        const [existing] = await db.select().from(userRoles).where(eq(userRoles.email, email));
        if (!existing) return json(404, { error: "No role assignment found for that email." });
        await db.delete(userRoles).where(eq(userRoles.email, email));
        await logAction({
          email: auth.email,
          role: auth.role,
          action: "role_removed",
          recordType: "user_roles",
          recordId: email,
          detail: { targetEmail: email, previousRole: existing.role },
        });
        return json(200, { ok: true, email });
      }

      return json(400, { error: "Unknown action." });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err: any) {
    return json(500, { error: err?.message || "Server error" });
  }
};

export const config: Config = {
  path: "/api/user-roles",
};
