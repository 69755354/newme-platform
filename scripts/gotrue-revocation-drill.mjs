#!/usr/bin/env node
// ============================================================================
// What an administrator password reset actually does to the target's sessions
// ============================================================================
// Round-4 finding A3 said the administrator reset path "does not globally revoke
// sessions", so "a pre-reset refresh token can mint a fresh access token whose
// iat is later than the reset timestamp". The first half is a fact about
// src/app/api/users/[id]/password/route.ts. The second half is a claim about
// GoTrue, and this file is the measurement that decides it.
//
// Three probes against a real GoTrue that ran its own migrations against the
// Supabase postgres image:
//
//   A  sign in, then PUT /admin/users/{id} {"password": ...} as service_role, and
//      try the pre-reset refresh token. Does GoTrue leave the session alive?
//   B  the mechanism this release ships: delete the target's session rows as the
//      migration owner (what revoke_user_sessions() does), then check that the old
//      refresh token is refused, that a login with the NEW password works, and
//      that the old password does not.
//   C  three concurrent sessions at once — do they all die together — and what
//      happens to an access token that was already minted.
//
// Not a CI gate: it needs Docker and two multi-hundred-megabyte images. It is the
// evidence behind 20260817120000_admin_reset_session_revocation.sql, re-runnable
// on demand by scripts/gotrue-revocation-drill.sh, which is what supplies the
// environment below.
//
// It ASSERTS the outcome rather than only printing it, so a GoTrue whose behaviour
// has moved is a non-zero exit and not a paragraph nobody re-reads. Note which
// direction each assertion points: the release does not depend on GoTrue revoking
// anything — that is why revoke_user_sessions() exists — so these assertions are
// here to keep the migration's header honest, not to gate the release on it.
//
// Every identity is synthetic (@drill.invalid), every secret is generated per run
// by the wrapper and exists only in this process's environment, and no production
// host is contacted.
//
// Environment (all set by scripts/gotrue-revocation-drill.sh):
//   GOTRUE_URL           base URL of the drill GoTrue, e.g. http://127.0.0.1:9999
//   GOTRUE_JWT_SECRET    the HS256 secret that GoTrue was started with
//   AUTH_DB_CONTAINER    name of the postgres container GoTrue is pointed at
// ============================================================================
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

const BASE = requireEnv("GOTRUE_URL");
const SECRET = requireEnv("GOTRUE_JWT_SECRET");
const DB_CONTAINER = requireEnv("AUTH_DB_CONTAINER");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set; run this through scripts/gotrue-revocation-drill.sh`);
    process.exit(2);
  }
  return value;
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A service_role token, which is how the admin endpoints are reached. */
function serviceToken() {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ role: "service_role", iss: "drill", iat: now, exp: now + 3600 });
  const signature = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const adminHeaders = () => ({
  Authorization: `Bearer ${serviceToken()}`,
  apikey: serviceToken(),
  "Content-Type": "application/json",
});

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * The database side, as the migration owner sees it.
 *
 * `auth` is not in PostgREST's exposed schemas, so this is deliberately not an
 * HTTP call: the point of the measurement is what only a database session can see.
 */
function sql(statement) {
  return execFileSync("docker", ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-Atc", statement], {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }).trim();
}

async function createUser(email, password) {
  const created = await call("/admin/users", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status !== 200) {
    throw new Error(`createUser ${created.status} ${JSON.stringify(created.body)}`);
  }
  return created.body.id;
}

const login = (email, password) =>
  call("/token?grant_type=password", {
    method: "POST",
    headers: { apikey: serviceToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

const refresh = (token) =>
  call("/token?grant_type=refresh_token", {
    method: "POST",
    headers: { apikey: serviceToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  });

const setPassword = (id, password) =>
  call(`/admin/users/${id}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ password }),
  });

const OLD = "drill-original-password-1";
const NEW = "drill-reset-password-2";
const report = {};
const failures = [];

function expect(condition, description) {
  if (!condition) failures.push(description);
}

// ---------------------------------------------------------------------------
// Probe A — does the admin password update leave the target's session alive?
// ---------------------------------------------------------------------------
{
  const email = "probe-a@drill.invalid";
  const id = await createUser(email, OLD);
  const signedIn = await login(email, OLD);
  const oldRefresh = signedIn.body.refresh_token;
  const sessionsBefore = sql(`select count(*) from auth.sessions where user_id = '${id}'`);

  const updated = await setPassword(id, NEW);
  const sessionsAfter = sql(`select count(*) from auth.sessions where user_id = '${id}'`);
  const refreshed = await refresh(oldRefresh);
  const mintedIat =
    refreshed.status === 200
      ? JSON.parse(Buffer.from(refreshed.body.access_token.split(".")[1], "base64url").toString()).iat
      : null;

  report.probeA = {
    adminUpdateStatus: updated.status,
    sessionsBefore,
    sessionsAfterReset: sessionsAfter,
    oldRefreshStatus: refreshed.status,
    oldRefreshError: refreshed.body?.error_code ?? refreshed.body?.error ?? null,
    mintedFreshAccessTokenIat: mintedIat,
  };

  expect(updated.status === 200, "probe A: the admin password update did not succeed");
  expect(sessionsBefore === "1", "probe A: the sign-in did not produce exactly one session");
  expect(sessionsAfter === "0", "probe A: the admin password update left a session row behind");
  expect(refreshed.status !== 200, "probe A: the pre-reset refresh token still minted a token");
  expect(mintedIat === null, "probe A: a fresh access token was minted after the reset");
}

// ---------------------------------------------------------------------------
// Probe B — the mechanism this release ships, and the read-after-write around it.
// ---------------------------------------------------------------------------
{
  const email = "probe-b@drill.invalid";
  const id = await createUser(email, OLD);
  const signedIn = await login(email, OLD);
  const oldRefresh = signedIn.body.refresh_token;

  // Deliberately BEFORE the password update, unlike the order the release uses.
  // Probe A showed GoTrue clears these rows itself, so measuring the delete after
  // it would measure nothing: the counts would already be zero and the assertion
  // below would be a tautology. This is also why revoke_user_sessions() treats
  // "nothing left to remove" as a verified no-op rather than a failure — see the
  // a3-a-second-revocation-is-a-verified-no-op replay assertion.
  const tokensBefore = sql(`select count(*) from auth.refresh_tokens where user_id = '${id}'`);
  const deleted = sql(
    `with gone as (delete from auth.sessions where user_id = '${id}' returning 1) select count(*) from gone`,
  );
  const tokensAfter = sql(`select count(*) from auth.refresh_tokens where user_id = '${id}'`);
  const refreshed = await refresh(oldRefresh);

  const updated = await setPassword(id, NEW);
  const newPassword = await login(email, NEW);
  const oldPassword = await login(email, OLD);

  report.probeB = {
    refreshTokensBeforeDelete: tokensBefore,
    sessionsDeleted: deleted,
    refreshTokensAfterDelete: tokensAfter,
    oldRefreshStatus: refreshed.status,
    oldRefreshError: refreshed.body?.error_code ?? refreshed.body?.error ?? null,
    adminUpdateStatus: updated.status,
    newPasswordLoginStatus: newPassword.status,
    oldPasswordLoginStatus: oldPassword.status,
  };

  expect(tokensBefore === "1", "probe B: there was no refresh token to delete, so the delete proves nothing");
  expect(deleted === "1", "probe B: the session delete removed nothing");
  expect(tokensAfter === "0", "probe B: a refresh token survived the session delete");
  expect(refreshed.status !== 200, "probe B: the pre-reset refresh token was accepted");
  // The half of the review's required closure that is about not breaking the
  // account: "verify the old refresh token is rejected and a new login works".
  expect(newPassword.status === 200, "probe B: a login with the new password failed");
  expect(oldPassword.status !== 200, "probe B: the old password still works");
}

// ---------------------------------------------------------------------------
// Probe C — concurrency, and the one window this cannot close.
// ---------------------------------------------------------------------------
{
  const email = "probe-c@drill.invalid";
  const id = await createUser(email, OLD);
  const first = await login(email, OLD);
  const second = await login(email, OLD);
  const third = await login(email, OLD);
  const sessionsBefore = sql(`select count(*) from auth.sessions where user_id = '${id}'`);

  sql(`delete from auth.sessions where user_id = '${id}'`);

  const statuses = [];
  for (const token of [first, second, third].map((r) => r.body.refresh_token)) {
    statuses.push((await refresh(token)).status);
  }

  // An access token GoTrue already signed stays cryptographically valid until it
  // expires. GoTrue itself refuses it because the session row is gone; PostgREST
  // has no session to check, which is why 20260813000000's restrictive policy
  // compares the token's `iat` with profiles.password_changed_at. Recorded here so
  // the residual is measured rather than assumed.
  const alreadyMinted = await call("/user", {
    headers: { Authorization: `Bearer ${first.body.access_token}`, apikey: serviceToken() },
  });

  report.probeC = {
    sessionsBeforeDelete: sessionsBefore,
    refreshStatusesAfterDelete: statuses,
    alreadyMintedAccessTokenStatus: alreadyMinted.status,
  };

  expect(sessionsBefore === "3", "probe C: three sign-ins did not produce three sessions");
  expect(
    statuses.every((status) => status !== 200),
    "probe C: a refresh token survived after every session row was deleted",
  );
}

console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  console.error("\nthe measured behaviour no longer matches what the migration header records:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\ndrill OK: every recorded observation reproduced");
