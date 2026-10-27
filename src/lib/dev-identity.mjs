// Round-4 review A0: the development admin identity had its password written
// into the source tree.
//
// Two routes shared one published credential. `/api/dev/setup` created the
// identity with an `admin` profile row using a literal password, and
// `/api/auth/dev-login` signed in with `process.env.DEV_PASSWORD || "<literal>"`
// — an environment variable that looked like configuration but silently fell
// back to the same published value whenever it was unset, which is every
// environment nobody remembered to configure.
//
// Removing the literals is necessary and is not the remediation: the values are
// in this repository's public git history, so they must be treated as known to
// anyone who has ever cloned it. The identity ban, the session revocation and
// the credential rotation are production actions with their own authorisation;
// supabase/preflight/f02-credential-cutover.md is the contract they have to
// satisfy and the record of what is still open.
//
// What this module changes is the shape of the failure. There is no default
// identity any more: the bootstrap routes resolve their credential here or they
// refuse to run, and "unconfigured" now produces a 503 instead of an admin
// account whose password is on GitHub.
//
// Every refusal below is deliberately about the *environment*, never about the
// value. `reason` is a code, not a message containing what was read, so a route
// can return it and a log can record it without republishing anything.

/** Reasons resolveDevIdentity() refuses. Ordered as the checks run. */
export const DEV_IDENTITY_REFUSALS = Object.freeze({
  PRODUCTION: "dev_identity_disabled_in_production",
  NOT_OPTED_IN: "dev_identity_bootstrap_not_enabled",
  UNCONFIGURED: "dev_identity_unconfigured",
  EMAIL_NOT_AN_ADDRESS: "dev_identity_email_is_not_an_address",
  PASSWORD_TOO_SHORT: "dev_identity_password_too_short",
});

/**
 * The minimum length a bootstrap password may have.
 *
 * It exists to stop the removed default — and anything else of that character —
 * from being pasted back in as configuration. Both published values were
 * shorter than this, which is the only property of them recorded here.
 */
export const DEV_IDENTITY_MIN_PASSWORD_LENGTH = 16;

/**
 * The opt-in. Deliberately not `NEXT_PUBLIC_*`: those are inlined into the
 * client bundle at build time, so they are neither server-only nor a runtime
 * decision. `/api/dev/setup` used to gate on `NEXT_PUBLIC_DEV_MODE`, which
 * means its guard was a build artefact shipped to every browser.
 */
export const DEV_IDENTITY_OPT_IN = "ALLOW_DEV_IDENTITY_BOOTSTRAP";

const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * Resolve the development bootstrap identity from the environment, or refuse.
 *
 * @param {Record<string, string | undefined>} [env] defaults to process.env
 * @returns {{ok: true, email: string, password: string}
 *          |{ok: false, reason: string, status: number}}
 *
 * The password is returned, because the caller has to send it to GoTrue; it is
 * never logged, never included in a refusal, and never given a default.
 */
export function resolveDevIdentity(env = process.env) {
  const refuse = (reason, status) => ({ ok: false, reason, status });

  // A production build has no legitimate use for either route. This is first so
  // that a misconfigured production server refuses before it reads anything.
  if (env.NODE_ENV === "production") {
    return refuse(DEV_IDENTITY_REFUSALS.PRODUCTION, 403);
  }

  // Opt-in, not opt-out: an environment that says nothing gets nothing.
  if (env[DEV_IDENTITY_OPT_IN] !== "true") {
    return refuse(DEV_IDENTITY_REFUSALS.NOT_OPTED_IN, 403);
  }

  const email = nonEmpty(env.DEV_EMAIL);
  const password = nonEmpty(env.DEV_PASSWORD);
  if (!email || !password) {
    return refuse(DEV_IDENTITY_REFUSALS.UNCONFIGURED, 503);
  }

  // Not validation for its own sake: a blank-ish or malformed address would be
  // sent to auth.admin.createUser(), and whatever it created would be a second
  // unaccounted identity in whatever database this is pointed at.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return refuse(DEV_IDENTITY_REFUSALS.EMAIL_NOT_AN_ADDRESS, 503);
  }

  if (password.length < DEV_IDENTITY_MIN_PASSWORD_LENGTH) {
    return refuse(DEV_IDENTITY_REFUSALS.PASSWORD_TOO_SHORT, 503);
  }

  return { ok: true, email: email.trim(), password };
}
