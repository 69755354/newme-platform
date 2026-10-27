import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const gate = await read("supabase/replay/16_concurrency_request_key.sh");
const runner = await read("scripts/replay-migrations.sh");

function modeBody(name) {
  const starts = {
    history: 'if [ "$MODE" = history ]; then',
    control: 'if [ "$MODE" = control ]; then',
    branch: 'echo "== two-session concurrency (allocate_payment) =="',
  };
  const from = runner.indexOf(starts[name]);
  assert.notEqual(from, -1, `could not find the ${name} mode block`);
  const ends = { history: starts.control, control: starts.branch, branch: null };
  const to = ends[name] ? runner.indexOf(ends[name], from) : runner.length;
  return runner.slice(from, to === -1 ? runner.length : to);
}

test("control and branch run the request-key race with opposite fail-closed expectations", () => {
  const control = modeBody("control");
  const branch = modeBody("branch");

  assert.match(runner, /REQUEST_KEY_GATE="\$REPLAY_DIR\/16_concurrency_request_key\.sh"/);
  assert.match(control, /EXPECT=duplicate bash "\$REQUEST_KEY_GATE"\s*\\?\s*\n?\s*\|\| fail /);
  assert.match(branch, /EXPECT=unique bash "\$REQUEST_KEY_GATE"\s*\\?\s*\n?\s*\|\| fail /);
  assert.doesNotMatch(control, /EXPECT=unique/);
  assert.doesNotMatch(branch, /EXPECT=duplicate/);
  assert.equal((runner.match(/bash "\$REQUEST_KEY_GATE"/g) ?? []).length, 2);
});

test("history mode never runs a concurrency claim", () => {
  assert.doesNotMatch(modeBody("history"), /REQUEST_KEY_GATE/);
});

test("the gate has no default verdict and accepts only the two measured states", () => {
  assert.match(gate, /: "\$\{EXPECT:\?[^}]*\}"/);
  assert.doesNotMatch(gate, /EXPECT:-/);
  assert.match(gate, /case "\$EXPECT" in\s*\n\s*unique\|duplicate\) ;;/);
});

test("the two sessions overlap at database-observed barriers", () => {
  assert.match(gate, /pg_advisory_xact_lock\(\$MARK_HI, \$MARK_LO\)/);
  assert.match(gate, /locktype = 'advisory' and classid = \$MARK_HI and objid = \$MARK_LO and granted/);
  assert.match(gate, /where not l\.granted and s\.application_name = 'replay_reqkey_b'/);
  assert.match(gate, /where id = '\$PAY_B'/);

  const sleeps = [...gate.matchAll(/^\s*sleep .*$/gm)].map((match) => match[0].trim());
  assert.deepEqual(sleeps, ["sleep 0.2", "sleep 0.2"], "only barrier polling may sleep");
});

test("the branch verdict proves the unique index serialized and refused session B", () => {
  assert.match(gate, /\[ "\$rows" = "1" \]/);
  assert.match(gate, /\[ "\$b_blocked" = "1" \]/);
  assert.match(gate, /grep -c 'idx_payments_request_key'/);
  assert.match(gate, /\[ "\$b_refused" != "0" \]/);
  assert.match(gate, /\[ "\$rows" = "2" \]/);
});

test("the gate validates its schema boundary and cleans only its fixed rows", () => {
  assert.match(gate, /attname = 'request_key'/);
  assert.match(gate, /indexname = 'idx_payments_request_key'/);
  assert.match(gate, /delete from public\.payments where id in \('\$PAY_A', '\$PAY_B'\)/);
  assert.match(gate, /\[ "\$left" = "0" \]/);
  assert.doesNotMatch(gate, /delete from public\.(contracts|profiles)/);
  assert.doesNotMatch(gate, /PGPASSWORD|password=|postgres:\/\//);
});
