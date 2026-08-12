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
/**
 * The expand-phase file that installs the write guards and the release-mode gate.
 * It is not the last file of the expand phase any more — round 4 added two
 * migrations that sort after the contract phase — so it is named for what it
 * declares, not for its position.
 */
const GUARDS_FILE = "20260814000000_l0_round3_authorization_and_integrity.sql";
const CONTRACT_FILE = "20260818000000_money_direct_write_contract_phase.sql";
const MANIFEST_PATH = "infra/release/release-manifest.json";
const COMPANION = "rollback_money_direct_write_contract_phase.sql";
/** The production stamp the replay's history phase stops at. */
const PRODUCTION_STAMP = "20260805202917";

const doc = read(DOC_PATH);
const expandSql = read(`supabase/migrations/${GUARDS_FILE}`);
/**
 * The expand phase is several files, and a routine's signature is declared in
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
  assert.ok(
    expected.includes(GUARDS_FILE),
    "the migration that installs the write guards and seeds the mode row must be in the expand phase",
  );
  assert.deepEqual(fence("contract"), [CONTRACT_FILE]);

  // And the document has to say why the split cannot be left to the tooling.
  assert.match(doc, /supabase db push` applies every pending migration in one\s*\n?run/);
});

test("the two phases in the document are the two phases in the release manifest", () => {
  // The split is executable only because something machine-readable defines it.
  // Round-4 review C7 refused the previous answer — an operator moving the
  // contract-phase file out of supabase/migrations/ for the duration of the first
  // push — so the phases now live in infra/release/release-manifest.json and
  // scripts/db-phase-push.mjs applies one of them. The document and the manifest
  // must therefore say the same thing.
  const manifest = JSON.parse(read(MANIFEST_PATH));
  const required = manifest.required_for_app.map((entry) => entry.file);
  const deferred = manifest.deferred_contract.map((entry) => entry.file);

  assert.deepEqual(fence("expand"), required, "the document's expand list is not the manifest's required_for_app");
  assert.deepEqual(fence("contract"), deferred, "the document's contract list is not the manifest's deferred_contract");
  assert.deepEqual(deferred, [CONTRACT_FILE]);

  // The contract phase is the highest version in the release. That is what makes
  // the expand set a contiguous prefix again: an operator who uses the CLI cannot
  // apply the contract phase before the round-4 migrations, and production's
  // application order is the version order the replay harness tests.
  const afterContract = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((name) => /^\d{14}_.*\.sql$/.test(name))
    .filter((name) => name.slice(0, 14) > CONTRACT_FILE.slice(0, 14));
  assert.deepEqual(
    afterContract,
    [],
    "a migration sorts after the contract phase: either renumber it below 20260818000000 or the phase split stops being a prefix",
  );

  // And the document must give the operator the tool, not a file-moving ritual.
  assert.match(doc, /How the split is executed: a manifest, not a moved file/);
  assert.match(doc, /node scripts\/db-phase-push\.mjs --phase required_for_app/);
  assert.match(doc, /node scripts\/db-phase-push\.mjs --phase deferred_contract/);
  assert.doesNotMatch(
    doc,
    /moves the contract-phase file out of/,
    "moving files between the reviewed tree and the applied tree is what C7 refused",
  );
  assert.match(doc, /Do \*\*not\*\* use\s*\r?\n?\s*`supabase db push`/);

  // §6.1 query 3 tells the operator which version to expect as the newest at
  // state 2. That expectation is the first thing an added migration makes wrong.
  const newestRequired = [...required].sort().at(-1).slice(0, 14);
  assert.match(
    doc,
    new RegExp(`expect ${newestRequired} first`),
    "§6.1 query 3 must expect the highest required_for_app version as the newest",
  );
  // …and §6.3 the contract phase itself.
  assert.match(doc, new RegExp(`expect ${CONTRACT_FILE.slice(0, 14)}$`, "m"));
});

test("the round-4 refusals the document calls mode-gated are mode-gated in the SQL", () => {
  // The compatibility window is only as true as the gate each new refusal sits
  // behind. trg_guard_quotations_write was first written against
  // money_write_is_direct() — role only — which would have refused the previous
  // release's `update quotations set contract_id` from the moment the expand phase
  // applied, i.e. before any deploy and again after an application-only rollback.
  const round4 = read("supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql");

  const quotations = /create or replace function public\.guard_quotations_write\(\)[\s\S]*?\n\$\$;/.exec(round4);
  assert.ok(quotations, "guard_quotations_write() must exist in the round-4 migration");
  assert.match(quotations[0], /if not public\.money_direct_write_is_blocked\(\) then\s*\r?\n\s*return new;/);
  assert.doesNotMatch(
    quotations[0],
    /if not public\.money_write_is_direct\(\) then/,
    "a role-only gate here closes the compatibility window for quotation conversion",
  );

  // first_payment_status joins the protected set, but only in strict mode: the
  // check has to sit after the early return, not before it.
  const contracts = /create or replace function public\.guard_contracts_write\(\)[\s\S]*?\n\$\$;/.exec(round4);
  assert.ok(contracts, "guard_contracts_write() must exist in the round-4 migration");
  assert.ok(
    contracts[0].indexOf("money_direct_write_is_blocked") <
      contracts[0].indexOf("new.first_payment_status is distinct from old.first_payment_status"),
    "the first_payment_status refusal must be inside the strict-mode branch",
  );

  // Both are listed as state-4 refusals in the writer table, not as unconditional.
  assert.match(doc, /\| `src\/app\/api\/contracts\/route\.ts:341` \(PUT\) \| `contracts` \| UPDATE `first_payment_status` \|/);
  assert.match(doc, /\| `src\/app\/api\/quotations\/\[id\]\/convert\/route\.ts:173` \| `quotations` \| UPDATE `contract_id` \|/);
});

test("the positive-amount constraints are disclosed as an unconditional change", () => {
  // A validated CHECK is the one thing in the expand phase that can abort the push
  // itself, so the document has to say so and has to point at the preflight.
  const round4 = read("supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql");
  for (const name of [
    "payments_amount_positive",
    "payment_allocations_amount_positive",
    "installment_plans_amount_positive",
  ]) {
    assert.match(round4, new RegExp(`add constraint ${name} check`), `${name} must be added by the SQL`);
    assert.ok(doc.includes(name), `§3 must name ${name}`);
    assert.doesNotMatch(
      round4,
      new RegExp(`add constraint ${name} check[^;]*not valid`, "i"),
      `${name} must be validated, which is what makes the push abort rather than defer`,
    );
  }
  assert.match(round4, /refusing to add the positive-amount constraints/);
  assert.match(doc, /the migration\s*\r?\n?\s*fails if production holds a violating row/);
  assert.match(doc, /scan-money-invariants\.sql/);
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
  // The header of the contract phase promises both artifacts by name. If either moves,
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
