/**
 * F-10 · the Meta access token was readable by every logged-in session.
 *
 * public.meta_tokens holds one row: the Meta/Facebook Marketing API access token,
 * in plaintext. docs/rls-explorer.md, generated from production, shows
 * policy_meta_tokens_select_authenticated with USING (true) alongside a SELECT
 * grant, so any authenticated user could read it straight off PostgREST —
 * /rest/v1/meta_tokens?select=access_token with their own session. From there the
 * token is usable outside this application entirely, against the ad account.
 *
 * RLS was never the whole control here: a permissive policy plus a table grant is
 * what made it readable, so the grant is what has to go. The replay proves it by
 * running a SELECT as the `authenticated` role and requiring insufficient_privilege.
 *
 * The coupling to check in source is that nothing legitimate loses access. Only
 * the OAuth callback touches this table, and it builds its own service-role
 * client, so revoking `authenticated` and `anon` costs nothing.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20260811100200_f10_meta_tokens_drop_permissive_select.sql";

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("the migration drops the permissive policy and revokes the grants", async () => {
  const sql = (await readFile(path.join(ROOT, MIGRATION), "utf8"))
    .replace(/--[^\n]*/g, " ")
    .toLowerCase();

  assert.match(
    sql,
    /drop policy if exists policy_meta_tokens_select_authenticated on public\.meta_tokens/,
  );

  // The grant is the control. Dropping the policy alone would leave the table
  // grant in place, and a future permissive policy would re-open it.
  const revoke = sql.match(/revoke\s+([^;]*?)\s+on\s+(table\s+)?public\.meta_tokens\s+from\s+([^;]*)/);
  assert.ok(revoke, "the migration must revoke privileges on meta_tokens");
  assert.match(revoke[3], /anon/);
  assert.match(revoke[3], /authenticated/);

  // service_role must keep working: the OAuth callback writes this row.
  assert.doesNotMatch(sql, /revoke[^;]*public\.meta_tokens[^;]*service_role/);
});

test("only a service-role client touches meta_tokens", async () => {
  const files = [...(await sourceFiles("src/app")), ...(await sourceFiles("src/lib"))];
  const callSites = [];
  const callerScoped = [];

  for (const file of files) {
    if (file === "src/types/database.ts") continue;
    const source = await readFile(path.join(ROOT, file), "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('from("meta_tokens")')) return;
      callSites.push(`${file}:${index + 1}`);
      const statement = lines.slice(Math.max(0, index - 8), index + 3).join(" ");
      if (/supabaseAdmin|getSupabaseAdmin|serviceRole|SERVICE_ROLE|\badmin\b/.test(statement)) return;
      callerScoped.push(`${file}:${index + 1}`);
    });
  }

  assert.ok(callSites.length > 0, "expected at least the OAuth callback to use meta_tokens");
  assert.deepEqual(
    callerScoped,
    [],
    `these reads/writes break once the grant is revoked: ${callerScoped.join(", ")}`,
  );
});

test("no client component can reach the token", async () => {
  // A "use client" file that queried meta_tokens would run in the browser with
  // the publishable key and the user's session — the exact path this finding is
  // about — and revoking the grant would break it. There must be none.
  const files = [...(await sourceFiles("src/app")), ...(await sourceFiles("src/components"))];
  const offenders = [];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    if (!/^\s*["']use client["']/m.test(source)) continue;
    if (source.includes("meta_tokens")) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("the replay asserts the grant, not just the policy", async () => {
  const assertions = await readFile(
    path.join(ROOT, "supabase/replay/10_assert_release_contracts.sql"),
    "utf8",
  );
  for (const name of [
    "f10-permissive-select-policy-is-gone",
    "f10-authenticated-has-no-select-grant",
    "f10-anon-has-no-select-grant",
    "f10-service-role-retains-select",
    "f10-service-role-retains-insert",
    "f10-service-role-retains-update",
    "f10-authenticated-cannot-read-meta-tokens",
  ]) {
    assert.match(assertions, new RegExp(name), `missing replay assertion ${name}`);
  }
});
