// Audit-trail sink for step-up re-authentication failures.
//
// When a user is asked to re-enter their password to confirm a sensitive action
// (signing a record, closing a record, completing an effectiveness check or audit
// session, or deleting a record) and that verification FAILS, the browser posts
// here so the failed attempt is recorded in the shared `audit_log` table.
//
// Only the failure metadata is stored — the user's email (taken server-side from
// the authenticated Identity session, never from the request body), the action
// that was attempted, the timestamp (audit_log.changed_at defaults to now()) and
// a short failure reason. The entered password is NEVER sent here, stored, or
// logged.
import type { Config } from "@netlify/functions";
import { getUser } from "@netlify/identity";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  try {
    // The actor is the signed-in Identity user — we record their email exactly,
    // and ignore any email a caller might try to put in the body.
    const user = await getUser();
    if (!user) return json(401, { error: "Sign in required." });
    const email = (user.email || "Unknown").toString();

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // Defensive: never persist anything that could carry a secret. We read only
    // the three known metadata fields and cap their length.
    const action = String(body.action || "Sensitive action").slice(0, 300);
    const recordId = String(body.recordId || "—").slice(0, 120) || "—";
    const reason = String(body.reason || "Password verification failed").slice(0, 300);

    await db.insert(auditLog).values({
      recordId,
      action: "reauth_failure",
      detail: `Re-authentication failed for "${action}" · Reason: ${reason}`,
      changedBy: email,
    });

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: (err as Error).message || "Could not record the event." });
  }
};

export const config: Config = {
  path: "/api/reauth-log",
};
