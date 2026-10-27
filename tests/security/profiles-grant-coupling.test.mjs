/**
 * F-06 · the profiles column-grant / call-site coupling.
 *
 * `authenticated` held a table-level UPDATE on public.profiles, and the only RLS
 * policy on it constrained `role`. Everything else — email, is_active,
 * password_changed_at, force_password_change — was self-writable. The live
 * takeover chain went through email: /api/auth/change-password verified the old
 * password against the address it read from profiles.email, so a user who
 * rewrote their own profiles.email could aim that verification at another
 * account. password_changed_at and force_password_change are what /api/auth/me
 * and src/proxy.ts consult to reject a token minted before a password change;
 * self-writable, they are not a control at all.
 *
 * The fix is a column-level grant, which means it can produce the F-09 failure
 * mode in reverse: revoke a column some route still writes with the caller's
 * client and that route starts failing with 42501. So the grant and the call
 * sites have to be checked against each other, which is what this file does. The
 * privileges themselves are asserted executably in
 * supabase/replay/10_assert_release_contracts.sql.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20260811100100_f06_profiles_revocation_columns.sql";

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function strip(sql) {
  return sql.replace(/--[^\n]*/g, " ").toLowerCase();
}

test("F-06 revokes the table-level UPDATE and re-grants exactly two columns", async () => {
  const sql = strip(await readFile(path.join(ROOT, MIGRATION), "utf8"));

  assert.match(
    sql,
    /revoke\s+update\s+on\s+(table\s+)?public\.profiles\s+from\s+[^;]*authenticated/,
    "the table-level UPDATE grant is what makes every column self-writable",
  );

  const grant = sql.match(
    /grant\s+update\s*\(([^)]*)\)\s*on\s+(table\s+)?public\.profiles\s+to\s+([^;]*)/,
  );
  assert.ok(grant, "F-06 must re-grant UPDATE on an explicit column list");

  const columns = grant[1].split(",").map((c) => c.trim()).sort();
  assert.deepEqual(
    columns,
    ["last_active_at", "updated_at"],
    "only the columns a caller-scoped write actually needs may be granted",
  );
  assert.match(grant[3], /authenticated/);

  // SELECT is untouched: the app reads profiles everywhere, and this finding is
  // about writes.
  assert.doesNotMatch(sql, /revoke\s+select\s+on\s+(table\s+)?public\.profiles/);
});

test("the only caller-scoped profiles write is the activity ping, and it writes only granted columns", async () => {
  const sql = strip(await readFile(path.join(ROOT, MIGRATION), "utf8"));
  const granted = new Set(
    sql
      .match(/grant\s+update\s*\(([^)]*)\)\s*on\s+(table\s+)?public\.profiles/)[1]
      .split(",")
      .map((c) => c.trim()),
  );

  const files = [
    "src/proxy.ts",
    ...(await sourceFiles("src/app")),
    ...(await sourceFiles("src/lib")),
  ];

  const callerScoped = [];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('from("profiles")')) return;
      const statement = lines.slice(Math.max(0, index - 2), index + 6).join(" ");
      if (!/\.(update|upsert)\(/.test(statement)) return;
      // Conservative: anything not attributable to the service-role client is
      // treated as caller-scoped, because a false positive here is harmless and
      // a false negative is a 42501 in production.
      if (/supabaseAdmin|getSupabaseAdmin|serviceRole|SERVICE_ROLE|\badmin\./.test(statement)) return;
      callerScoped.push({ file, line: index + 1, statement });
    });
  }

  assert.deepEqual(
    callerScoped.map((hit) => hit.file),
    ["src/proxy.ts"],
    `expected the throttled last_active_at ping to be the only caller-scoped profiles write; found ${callerScoped.map((h) => `${h.file}:${h.line}`).join(", ")}`,
  );

  // Every column that write sets must be inside the grant.
  const payload = callerScoped[0].statement.match(/\.update\(\s*\{([^}]*)\}/);
  assert.ok(payload, "could not read the update payload");
  const written = payload[1]
    .split(",")
    .map((pair) => pair.split(":")[0].trim().replace(/["']/g, ""))
    .filter(Boolean);
  assert.ok(written.length > 0);
  for (const column of written) {
    assert.ok(granted.has(column), `${column} is written by src/proxy.ts but not granted by F-06`);
  }
});

test("change-password no longer trusts profiles.email for old-password verification", async () => {
  const source = await readFile(path.join(ROOT, "src/app/api/auth/change-password/route.ts"), "utf8");

  // The takeover chain: verifying the old password against a self-writable
  // profiles.email let a user point the check at somebody else's account. The
  // address must come from the authenticated identity.
  const verification = source.slice(0, source.indexOf("updateUser"));
  assert.doesNotMatch(
    verification,
    /from\("profiles"\)[\s\S]{0,400}email/,
    "the old-password check must not read the address from profiles",
  );
  assert.match(
    source,
    /user\.email/,
    "the old-password check must use the email on the authenticated identity",
  );
});

test("the replay asserts the removed columns executably", async () => {
  const assertions = await readFile(
    path.join(ROOT, "supabase/replay/10_assert_release_contracts.sql"),
    "utf8",
  );
  for (const name of [
    "f06-authenticated-cannot-update-email",
    "f06-authenticated-cannot-update-password-changed-at",
    "f06-authenticated-cannot-update-force-password-change",
    "f06-authenticated-cannot-update-is-active",
    "f06-authenticated-cannot-update-role",
    "f06-authenticated-can-update-last-active-at",
    "f06-authenticated-retains-profiles-select",
  ]) {
    assert.match(assertions, new RegExp(name), `missing replay assertion ${name}`);
  }
});
