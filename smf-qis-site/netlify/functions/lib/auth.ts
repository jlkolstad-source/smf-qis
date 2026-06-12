// Shared role-based authorization helper for every QIS Netlify Function.
//
// Resolution model:
//   1. The current authenticated user's email is taken from the Netlify Identity
//      session (the `getUser()` context, which reads the Identity JWT from the
//      Authorization header / nf_jwt cookie the front-end sends).
//   2. That email is looked up in the `user_roles` table. If no row exists the
//      user defaults to "Member".
//   3. requireRole(minRole, ...) gates an action against the role hierarchy and
//      returns a ready-to-send 403 JSON Response when the user is insufficient.
//
// Role hierarchy, lowest → highest privilege:
//   Dock  <  Member  <  Quality Manager  <  Admin
//
// The same module also writes the access-control / integrity `action_log`
// (see logAction) used by the admin Action Log view and the 21 CFR Part 11
// validation package.
import { getUser } from "@netlify/identity";
import { eq } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { userRoles, actionLog } from "../../../db/schema.js";

export type Role = "Dock" | "Member" | "Quality Manager" | "Admin";

// Numeric rank for ≥ comparisons. Higher = more privilege.
const RANK: Record<Role, number> = {
  Dock: 0,
  Member: 1,
  "Quality Manager": 2,
  Admin: 3,
};

export const ROLES: Role[] = ["Dock", "Member", "Quality Manager", "Admin"];

// Users seeded as Admin on first run if no row exists for them yet.
const SEED_ADMINS = ["jkolstad@somafina.com", "chinson@somafina.com"];

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

export type Identity = NonNullable<Awaited<ReturnType<typeof getUser>>>;

// Normalise an arbitrary stored value onto one of the four canonical roles.
// Tolerates case / spacing drift and legacy "admin" values.
export function normalizeRole(value: any): Role {
  const v = (value == null ? "" : String(value)).trim().toLowerCase();
  if (v === "admin") return "Admin";
  if (v === "quality manager" || v === "quality_manager" || v === "qm") return "Quality Manager";
  if (v === "dock") return "Dock";
  if (v === "member") return "Member";
  return "Member";
}

// True when `role` is at least as privileged as `min`.
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

let seeded = false;

// Insert the known administrators on first use if they have no row yet. Cheap
// and idempotent (onConflictDoNothing); guarded by an in-process flag so the
// insert is attempted at most once per warm function instance.
export async function ensureRoleSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    await db
      .insert(userRoles)
      .values(
        SEED_ADMINS.map((email) => ({
          email,
          role: "Admin",
          site: "ALL",
          assignedBy: "System (seed)",
        }))
      )
      .onConflictDoNothing();
  } catch {
    // A transient seed failure must never block a request; the next call retries.
    seeded = false;
  }
}

// Look up a user's role by email. Returns "Member" when the user has no explicit
// assignment (the documented default).
export async function getUserRole(email: string): Promise<Role> {
  const e = (email || "").trim().toLowerCase();
  if (!e) return "Member";
  await ensureRoleSeed();
  const [row] = await db.select().from(userRoles).where(eq(userRoles.email, e));
  if (!row) return "Member";
  return normalizeRole(row.role);
}

export interface AuthContext {
  user: Identity;
  email: string;
  role: Role;
  // Display string for created_by / modified_by stamps: full name + title,
  // never the email, falling back to the email only when no profile name is set.
  actor: string;
  // Site stored on the user's role row (or "ALL").
  roleSite: string;
}

// Build the created_by / modified_by display string per policy (name, title).
export function actorString(user: Identity): string {
  const name = (user.name || "").trim();
  const title = ((user.userMetadata && (user.userMetadata as any).title) || "").toString().trim();
  if (name && title) return `${name}, ${title}`;
  return name || user.email || "Unknown";
}

// Resolve the full authenticated context (identity + role). Returns null when no
// user is signed in, so callers can return a 401.
export async function getAuth(): Promise<AuthContext | null> {
  const user = await getUser();
  if (!user) return null;
  const email = (user.email || "").trim().toLowerCase();
  await ensureRoleSeed();
  let role: Role = "Member";
  let roleSite = "ALL";
  if (email) {
    const [row] = await db.select().from(userRoles).where(eq(userRoles.email, email));
    if (row) {
      role = normalizeRole(row.role);
      roleSite = row.site || "ALL";
    }
  }
  return { user, email, role, actor: actorString(user), roleSite };
}

// Per the task spec: requireRole(minRole, userEmail) → a 403 JSON Response when
// the user's role is insufficient, otherwise null. Accepts either an email
// string (looked up) or an already-resolved Role for callers that have it.
export async function requireRole(minRole: Role, userOrEmail: string | Role): Promise<Response | null> {
  let role: Role;
  if (userOrEmail === "Dock" || userOrEmail === "Member" || userOrEmail === "Quality Manager" || userOrEmail === "Admin") {
    role = userOrEmail;
  } else {
    role = await getUserRole(userOrEmail);
  }
  if (!roleAtLeast(role, minRole)) {
    return json(403, {
      error: `This action requires the ${minRole} role or higher. Your role is ${role}.`,
      requiredRole: minRole,
      yourRole: role,
    });
  }
  return null;
}

// ── ACTION LOG ───────────────────────────────────────────────────────────────
export type ActionType =
  | "role_assigned"
  | "role_removed"
  | "record_created"
  | "record_closed"
  | "record_deleted"
  | "effectiveness_completed"
  | "sign_added"
  | "link_added"
  | "link_removed"
  | "concurrency_conflict_rejected"
  | "permission_denied";

let logSeq = 0;

// Append one row to action_log. Best-effort: a logging failure must never break
// the underlying request, so all errors are swallowed.
export async function logAction(params: {
  email?: string;
  role?: Role | string;
  action: ActionType;
  recordType?: string;
  recordId?: string;
  site?: string;
  detail?: Record<string, any>;
}): Promise<void> {
  try {
    const now = new Date();
    const id = `AL-${now.getTime()}-${(logSeq = (logSeq + 1) % 100000)}`;
    await db.insert(actionLog).values({
      id,
      timestamp: now,
      userEmail: (params.email || "").toLowerCase(),
      userRole: (params.role as string) || "",
      action: params.action,
      recordType: params.recordType || "",
      recordId: params.recordId || "",
      site: params.site || "",
      detail: params.detail || {},
    });
  } catch {
    // Intentionally ignored — logging is never allowed to fail a request.
  }
}

// ── OPTIMISTIC CONCURRENCY ───────────────────────────────────────────────────
// Compare the client's expected_modified_at against the row's current
// modified_at. Returns true when they match (or the client supplied nothing, so
// older clients keep working). `current` may be a Date or ISO string.
export function concurrencyMatches(expected: any, current: Date | string | null | undefined): boolean {
  if (expected == null || expected === "") return true; // legacy client → no guard
  const cur = current instanceof Date ? current.toISOString() : current ? new Date(current).toISOString() : "";
  const exp = (() => {
    try {
      return new Date(expected).toISOString();
    } catch {
      return String(expected);
    }
  })();
  return cur === exp;
}

// Build the standard 409 conflict Response body.
export function conflictResponse(opts: {
  currentRecord: any;
  lastModifiedBy: string;
  lastModifiedAt: Date | string | null | undefined;
  attemptedChanges: any;
}): Response {
  const at = opts.lastModifiedAt instanceof Date ? opts.lastModifiedAt.toISOString() : opts.lastModifiedAt || null;
  return json(409, {
    error: "This record was modified by someone else while you were editing.",
    conflict: true,
    current_record: opts.currentRecord,
    last_modified_by: opts.lastModifiedBy || "",
    last_modified_at: at,
    attempted_changes: opts.attemptedChanges,
  });
}

export { json as jsonResponse };
