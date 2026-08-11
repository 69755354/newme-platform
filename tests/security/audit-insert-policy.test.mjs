/**
 * F-08 · audit, activity and session records are server-owned evidence.
 *
 * docs/rls-explorer.md, generated from production, shows
 * policy_audit_logs_insert_authenticated with WITH CHECK (true) plus an INSERT
 * grant to `authenticated`. Any logged-in user could therefore append audit rows
 * attributed to any actor_id: forge an entry naming someone else, or flood the
 * table to bury a real one. An audit log that its subjects can write is not
 * evidence.
 *
 * 20260723130000_lock_definer_boundaries.sql already closed all three tables with
 * WITH CHECK (false) — and is not reflected in production, which is a separate
 * finding. Because permissive RLS policies OR together, the only correct target
 * state is that EVERY insert policy visible to `authenticated` on these tables is
 * false; a "narrower" policy added beside the closed one would widen access, not
 * restrict it. The replay asserts that enumeratively and then executes a forged
 * insert as the `authenticated` role.
 *
 * What a database cannot check is whether the application still tries to write
 * these tables as the caller. It did: src/proxy.ts inserted a PAGE_VISIT row on
 * every navigation using the caller's client, so closing the policy without
 * removing that write would have turned every page load into a silent RLS error.
 * That is what this file guards.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "supabase/migrations/20260811100000_f08_audit_logs_actor_identity.sql";
const SERVER_OWNED = ["audit_logs", "activity_logs", "user_session_daily"];

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("the migration closes INSERT for authenticated on all three tables", async () => {
  const sql = (await readFile(path.join(ROOT, MIGRATION), "utf8"))
    .replace(/--[^\n]*/g, " ")
    .toLowerCase();

  for (const table of SERVER_OWNED) {
    // Both prior policy names must be dropped: the permissive one from
    // 20260701000000_non_core_tables_rls_fix.sql and the closed one from
    // 20260723130000, so that re-applying this migration converges instead of
    // erroring on an existing policy.
    assert.match(
      sql,
      new RegExp(`drop policy if exists policy_${table}_insert_authenticated on public\\.${table}`),
      `${table}: the permissive policy must be dropped`,
    );
    assert.match(
      sql,
      new RegExp(`drop policy if exists policy_${table}_insert_server_only\\s+on public\\.${table}`),
      `${table}: the migration must be idempotent against its own policy`,
    );
    assert.match(
      sql,
      new RegExp(
        `create policy policy_${table}_insert_server_only\\s+on public\\.${table}\\s+for insert to authenticated\\s+with check \\(false\\)`,
      ),
      `${table}: the replacement policy must be WITH CHECK (false)`,
    );
  }

  // A caller-scoped predicate would OR with nothing and still be a write path.
  // actor_id = auth.uid() was the first revision of this migration and was wrong:
  // it permits self-attributed flooding, and it cannot restrict anything while a
  // false policy also exists.
  assert.doesNotMatch(sql, /with check \(\s*actor_id\s*=\s*auth\.uid\(\)/);
});

test("no application code writes the server-owned tables with a caller-scoped client", async () => {
  const files = [
    "src/proxy.ts",
    ...(await sourceFiles("src/app")),
    ...(await sourceFiles("src/lib")),
  ];

  const offenders = [];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const table = SERVER_OWNED.find((t) => line.includes(`from("${t}")`));
      if (!table) return;
      const statement = lines.slice(Math.max(0, index - 2), index + 4).join(" ");
      if (!/\.(insert|upsert)\(/.test(statement)) return;
      if (/supabaseAdmin|getSupabaseAdmin|serviceRole|SERVICE_ROLE|\badmin\./.test(statement)) return;
      offenders.push(`${file}:${index + 1} (${table})`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these writes will fail with 42501 once the policy is closed: ${offenders.join(", ")}`,
  );
});

test("the proxy no longer writes audit rows, and cannot", async () => {
  const raw = await readFile(path.join(ROOT, "src/proxy.ts"), "utf8");

  // Comments are stripped: the file keeps a note explaining why the PAGE_VISIT
  // insert was removed, and that note must not be mistaken for the code.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  assert.doesNotMatch(code, /from\("audit_logs"\)/, "the PAGE_VISIT insert must stay removed");
  assert.doesNotMatch(code, /PAGE_VISIT/);

  // The proxy runs in an edge-like runtime. Reaching for the service-role key to
  // "fix" the write would put a full-bypass credential in the request path for
  // every navigation, which is strictly worse than losing the PAGE_VISIT row.
  assert.doesNotMatch(
    code,
    /SUPABASE_SERVICE_ROLE_KEY|supabaseAdmin/,
    "the service-role key must not enter the proxy runtime",
  );

  // The removal note must stay, so the next person does not "restore" the write.
  assert.match(raw, /PAGE_VISIT/, "keep the comment recording why the insert was removed");
});

test("the replay asserts the boundary enumeratively and behaviourally", async () => {
  const assertions = await readFile(
    path.join(ROOT, "supabase/replay/10_assert_release_contracts.sql"),
    "utf8",
  );
  for (const name of [
    "f08-permissive-audit-insert-policy-is-gone",
    "f08-audit-insert-closed-for-authenticated",
    "f08-activity-insert-closed-for-authenticated",
    "f08-session-insert-closed-for-authenticated",
    "f08-authenticated-cannot-forge-audit-row",
    "f08-authenticated-cannot-append-self-attributed-audit-row",
  ]) {
    assert.match(assertions, new RegExp(name), `missing replay assertion ${name}`);
  }

  // bool_and over every INSERT policy for `authenticated`, not one policy by
  // name: that is what catches a future migration adding a permissive policy
  // beside the closed one.
  assert.match(assertions, /bool_and\(coalesce\(with_check, 'true'\) = 'false'\)/);
});
