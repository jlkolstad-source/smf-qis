// One-shot account bootstrap for the QIS deploy preview.
//
// The invite-by-email flow is awkward to use against a deploy preview, so this
// endpoint provisions a single, known administrator account directly through the
// Netlify Identity admin API (which auto-confirms the user — no email round-trip).
// It is intentionally fixed to ONE email + password and ignores any request body,
// so the worst anyone can do by calling it is (re)create the very account whose
// credentials are already meant to be shared for the preview.
//
// Sign-in (public/index.html) calls this automatically the first time the known
// account fails to log in, then retries — so the user never has to hit it by hand.
import { admin } from "@netlify/identity";
import type { Config } from "@netlify/functions";

const EMAIL = "jkolstad@somafina.com";
const PASSWORD = "admin";

export default async () => {
  try {
    await admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      data: { role: "admin", user_metadata: { full_name: "J Kolstad" } },
    });
    return Response.json({ ok: true, status: "created" });
  } catch {
    // Most likely the account already exists. Reset its password so the known
    // credentials keep working, and make sure it is confirmed.
    try {
      const users = await admin.listUsers();
      const existing = users.find(
        (u) => (u.email || "").toLowerCase() === EMAIL,
      );
      if (!existing) {
        return Response.json(
          { ok: false, error: "Could not create or locate the account." },
          { status: 500 },
        );
      }
      await admin.updateUser(existing.id, {
        password: PASSWORD,
        confirm: true,
        role: "admin",
      });
      return Response.json({ ok: true, status: "reset" });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error).message || "Bootstrap failed." },
        { status: 500 },
      );
    }
  }
};

export const config: Config = { path: "/api/bootstrap-user" };
