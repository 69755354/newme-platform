// ============================================================================
// Contract test: the expand/contract procedure vs the SQL it describes
// ============================================================================
// Round-3 review item 5 asked for a compatibility statement covering the old
// production app, the candidate app, the expand phase, the contract phase and the
// rollback point. That statement is a document — supabase/preflight/expand-contract-rollback.md
// — because the compatibility window is a deployment procedure and not a property
// of any single file: `supabase db push` applies every pending migration in one
// run, so the window exists only if an operator splits the push.
//
// A document is exactly the artifact that rots. So every load-bearing claim in it
// is parsed back out of the SQL here:
//
//   * the expand set is the real pending migration set, computed from the
//     directory and the production stamp — adding a migration and forgetting the
//     document fails this test
//   * the contract phase is the one file the document names, no more
//   * the status graph in the document is the graph in
//     contract_transition_is_allowed(), pair for pair
//   * the RPC signatures the previous release calls are the signatures the
//     migrations declare, character for character
//   * the three release-mode values are the values the three SQL files write
//   * every verification query in the document is read-only, because the document
//     tells an operator to run them against production
//
// It does not, and cannot, assert that anything was applied. §7 of the document
// says so and this file checks that it says so.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const DOC_PATH = "supabase/preflight/expand-contract-rollback.md";
const EXPAND_LAST = "20260814000000_l0_round3_authorization_and_integrity.sql";
const CONTRACT_FILE = "20260815000000_money_direct_write_contract_phase.sql";
const COMPANION = "rollback_money_direct_write_contract_phase.sql";
/** The production stamp the replay's history phase stops at. */
const PRODUCTION_STAMP = "20260805202917";

const doc = read(DOC_PATH);
const expandSql = read(`supabase/migrations/${EXPAND_LAST}`);
/**
 * The expand phase is ten files, and a routine's signature is declared in
 * whichever of them last touched it — approve_contract() in 20260812000000,
 * void_payment() in 20260814000000. Signature and predicate lookups are made
 * against the whole set, because "the expand phase declares this" is the claim.
 */
const expandSetSql = readdirSync(path.join(ROOT, "supabase/migrations"))
  .filter((name) => /^\d{14}_.*\.sql$/.test(name))
  .filter((name) => name.slice(0, 14) > PRODUCTION_STAMP && name !== CONTRACT_FILE)
  .sort()
  .map((name) => read(`supabase/migrations/${name}`))
  .join("\n");
const contractSql = read(`supabase/migrations/${CONTRACT_FILE}`);
const companionSql = read(`supabase/migrations/${COMPANION}`);

/** The contents of a ```<tag> fenced block, as trimmed non-empty lines. */
function fence(tag) {
  const match = new RegExp("```" + tag + "\\r?\\n([\\s\\S]*?)```").exec(doc);
  assert.ok(match, `the document must contain a \`\`\`${tag} block`);
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test("the document leads with what has not been done, and marks every action", () => {
  assert.match(doc, /Status: \*\*NOT PERFORMED\.\*\*/);
  assert.match(doc, /does not apply a migration/);
  const actions = doc.match(/\*\*\[AUTHORISED ACTION\]/g) ?? [];
  assert.ok(
    actions.length >= 3,
    `each production step must be marked [AUTHORISED ACTION]; found ${actions.length}`,
  );
  // The three that must be marked, by name.
  assert.match(doc, /\*\*\[AUTHORISED ACTION\] Apply the expand phase\.\*\*/);
  assert.match(doc, /\*\*\[AUTHORISED ACTION\] Deploy the candidate release\.\*\*/);
  assert.match(doc, /\*\*\[AUTHORISED ACTION\] Apply the contract phase\.\*\*/);
});

test("the documented expand set is the real pending migration set", () => {
  const pending = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .filter((name) => name.slice(0, 14) > PRODUCTION_STAMP)
    .sort();

  assert.ok(pending.includes(CONTRACT_FILE), "the contract phase must be one of the pending files");
  const expected = pending.filter((name) => name !== CONTRACT_FILE);

  assert.deepEqual(
    fence("expand"),
    expected,
    "the expand list in the document must be every pending migration except the contract phase, in order",
  );
  assert.equal(expected[expected.length - 1], EXPAND_LAST, "the expand phase must end at 20260814000000");
  assert.deepEqual(fence("contract"), [CONTRACT_FILE]);

  // And the document has to say why the split cannot be left to the tooling.
  assert.match(doc, /supabase db push` applies every pending migration in one\s*\n?run/);
});

test("the status graph in the document is the graph in the SQL", () => {
  const body = /contract_transition_is_allowed\(p_from text, p_to text\)[\s\S]*?\n\$\$;/.exec(expandSql);
  assert.ok(body, "contract_transition_is_allowed() must exist in the expand phase");
  const sqlPairs = [...body[0].matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]} -> ${m[2]}`);
  assert.ok(sqlPairs.length >= 20, `expected the whole graph in one function, saw ${sqlPairs.length} pairs`);

  const docPairs = fence("graph");
  assert.deepEqual(
    [...docPairs].sort(),
    [...sqlPairs].sort(),
    "the documented transitions and contract_transition_is_allowed() disagree",
  );
  assert.equal(new Set(docPairs).size, docPairs.length, "duplicate transitions in the document");

  // Terminality is the property the P1-8 reproduction was about, so it is stated
  // in the document and checked against the graph rather than trusted.
  assert.match(doc, /`completed`, `terminated` and `superseded` are terminal/);
  for (const terminal of ["completed", "terminated", "superseded"]) {
    assert.ok(
      !sqlPairs.some((pair) => pair.startsWith(`${terminal} ->`)),
      `${terminal} is documented as terminal but the graph leaves it`,
    );
  }
  // The trigger is what makes the graph apply to the previous release too.
  assert.match(expandSql, /create trigger trg_guard_contract_transition\s*\n\s*before update of status on public\.contracts/);
  assert.match(doc, /trg_guard_contract_transition/);
});

test("the RPC signatures the previous release calls are the declared ones", () => {
  for (const signature of fence("rpc")) {
    const match = /^public\.(\w+)\((.*)\)$/.exec(signature);
    assert.ok(match, `unparseable signature in the document: ${signature}`);
    const [, name, args] = match;
    // The identity-argument form appears verbatim in the grant/revoke lines of a
    // migration, so a changed argument list cannot leave the document standing.
    const declared = new RegExp(
      `(?:revoke all|grant execute) on function public\\.${name}\\(${args.replace(/[()]/g, "\\$&")}\\)`,
    );
    assert.ok(
      declared.test(expandSetSql),
      `${signature} is not a signature the expand phase grants`,
    );
  }

  // The reason the signatures could be kept: the actor parameter is validated
  // instead of removed. If money_actor() stopped binding to the JWT subject the
  // compatibility claim would be true and the security claim false.
  assert.match(doc, /`money_actor\(\)` binds the actor to the session's JWT subject/);
  assert.match(expandSql, /create or replace function public\.money_actor\(/);
  assert.match(expandSql, /auth\.uid\(\)/);
});

test("the three release-mode values are the values the SQL writes", () => {
  // Expand seeds compat.
  assert.match(expandSql, /insert into public\.money_release_mode \(id, direct_write_mode, reason\)[\s\S]{0,200}?'compat'/);
  // The gate fails closed to strict when the row or the table is absent.
  assert.match(expandSql, /coalesce\(\(select m\.direct_write_mode from public\.money_release_mode m where m\.id = 'only'\),\s*\n?\s*'strict'\)/);
  // Contract phase flips to strict and verifies it took.
  assert.match(contractSql, /'strict'/);
  assert.match(contractSql, /if v_mode <> 'strict' then/);
  // Companion returns to compat and verifies it took.
  assert.match(companionSql, /set direct_write_mode = 'compat'/);
  assert.match(companionSql, /if v_mode <> 'compat' then/);

  // The document's matrix must use those exact values, and must call state 3 the
  // rollback boundary — that is the whole point of the two-push procedure.
  assert.match(doc, /\| 2 · expand applied \|.*`compat` \|/);
  assert.match(doc, /\| 4 · contract applied \|.*`strict` \|/);
  assert.match(doc, /\| 5 · companion run \|.*`compat` \|/);
  assert.match(doc, /State 3 is the rollback boundary/);
  assert.match(doc, /point of no return is step 7/);
  assert.match(doc, new RegExp(COMPANION.replace(/\./g, "\\.")));
});

test("the document is right about which gate function sees the calling role", () => {
  // money_direct_write_is_blocked() must be SECURITY INVOKER: as DEFINER it would
  // read the owner's current_user and every guard would stand down. The document
  // states this and the operator's verification query checks it in production, so
  // both have to match the SQL.
  const blocked = /create or replace function public\.money_direct_write_is_blocked\(\)[\s\S]*?\n\$\$;/.exec(expandSql);
  assert.ok(blocked, "money_direct_write_is_blocked() must exist");
  assert.doesNotMatch(blocked[0], /security definer/i, "the invoker/definer split is inverted");

  const mode = /create or replace function public\.money_direct_write_mode\(\)[\s\S]*?\n\$\$;/.exec(expandSql);
  assert.ok(mode, "money_direct_write_mode() must exist");
  assert.match(mode[0], /security definer/i);

  assert.match(doc, /`public\.money_direct_write_is_blocked\(\)` is SECURITY INVOKER on purpose/);
  assert.match(doc, /\*\*fails closed to `'strict'`\*\*/);
  assert.match(doc, /money_direct_write_is_blocked = false \(invoker, must see current_user\)/);

  // money_write_is_direct() is the predicate the whole compatibility story rests
  // on, including the claim that service_role paths are unaffected. The document
  // quotes it, so it has to quote it as written.
  const predicate = /create or replace function public\.money_write_is_direct\(\)[\s\S]*?as \$\$ (select [^$]*?) \$\$;/.exec(
    expandSetSql,
  );
  assert.ok(predicate, "money_write_is_direct() must exist in the expand phase");
  assert.equal(predicate[1], "select current_user in ('authenticated', 'anon')");
  assert.ok(
    doc.includes("`current_user in ('authenticated', 'anon')`"),
    "the document must quote money_write_is_direct()'s predicate as written",
  );
});

test("every verification query in the document is read-only", () => {
  // An operator is told to run these against production. A stray DML line here is
  // a production mutation with a checklist next to it.
  const blocks = [...doc.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3, `expected the verification sections to carry SQL, saw ${blocks.length} blocks`);

  const forbidden = /^\s*(insert|update|delete|alter|drop|grant|revoke|truncate|create|call|do|set|copy)\b/i;
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
      if (/^\s*--/.test(line) || !line.trim()) continue;
      assert.ok(
        !forbidden.test(line),
        `a verification block contains a non-read-only statement: ${line.trim()}`,
      );
    }
  }
  // And the document must forbid the one "verification" that is really a write.
  assert.match(doc, /Do \*\*not\*\* verify strict mode by attempting a direct write/);
  // Evidence limits, restated where the operator will be looking.
  assert.match(doc, /No row contents\./);
  assert.match(doc, /Record\s+the HTTP status and the route, not the payload\./);
});

test("every path the document cites exists", () => {
  const cited = new Set(
    [...doc.matchAll(/(?:^|[\s(`])((?:src|supabase|scripts|infra|tests)\/[\w./[\]-]*\.(?:sql|mjs|ts|sh|json|md))/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(cited.size >= 8, `expected the document to cite its sources, found ${cited.size}`);
  const missing = [...cited].filter((rel) => !existsSync(path.join(ROOT, rel)));
  assert.deepEqual(missing, [], `the document cites paths that do not exist: ${missing.join(", ")}`);
});

test("the contract-phase migration points at this document and this test", () => {
  // The header of 20260815000000 promises both artifacts by name. If either moves,
  // the promise becomes a dead reference in a file an operator reads at a
  // deployment.
  assert.match(contractSql, new RegExp(DOC_PATH.replace(/\//g, "\\/")));
  const self = path.relative(ROOT, import.meta.filename).replace(/\\/g, "/");
  assert.match(contractSql, new RegExp(self.replace(/\//g, "\\/")));
});

test("the document does not close anything a code round cannot close", () => {
  assert.match(doc, /None of these may be marked ✅ from a code round\./);
  assert.match(doc, /not that anything has been applied to production/);
  // ✅ may appear only in a sentence that withholds it. A document that ticks
  // something off is a document that has been used to close a production step.
  const ticked = doc.split(/\r?\n/).filter((line) => line.includes("✅"));
  assert.ok(ticked.length > 0, "the document must say what may not be ticked");
  for (const line of ticked) {
    assert.match(
      line,
      /None of these may be marked|may not be marked|only with the output/,
      `a ✅ appears without withholding it: ${line.trim()}`,
    );
  }
});
