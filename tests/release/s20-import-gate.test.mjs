import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  verifyImportDir, parseManifest, scanProgramText, judgeRepositoryFiles, checkRepository,
} from "../../scripts/check-s20-import-gate.mjs";
import {
  runDataImport, parseOperationArgs, takeBackup, summarizePlan, judgeSideEffects,
} from "../../scripts/data-import-gate.mjs";

// All data here is invented. The programs below are stand-ins written by this test; the real ones
// are never in the repository.

const uid = process.getuid();
const MAIN = "a".repeat(40);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const BATCH = "2d00cfc2-c8f9-450f-82fd-d416104c7fc8";

const FAKE_IMPORT = `
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const dbFile = process.env.FAKE_DB;
const db = JSON.parse(fs.readFileSync(dbFile, "utf8"));
const bundle = JSON.parse(fs.readFileSync(arg("--input"), "utf8"));
const runDir = arg("--run-dir");
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
if (!process.env.NEWME_IMPORT_DB_URL) process.exit(3);
if (!argv.includes("--apply")) {
  fs.appendFileSync(path.join(path.dirname(dbFile), "calls.log"), "plan\\n");
  const counts = {
    leads_by_action: { INSERT: bundle.insert, UPDATE: bundle.update + bundle.unarchive, NOOP: bundle.noop },
    unarchived_on_match: bundle.unarchive, skipped: bundle.skipped, held: bundle.held, conflicts: 0, to_archive: bundle.toArchive ?? 0,
    os_leads_unarchived_before: db.counts.leads_unarchived,
    expected_unarchived_after: db.counts.leads_unarchived + bundle.insert + bundle.unarchive,
    notifications_to_create: bundle.plannedNotifications ?? 0, meta_crm_stage_events_to_enqueue: 0, tasks_to_create: 0,
  };
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ counts }), { mode: 0o600 });
  process.exit(0);
}
if (!argv.includes("--confirm-production")) process.exit(4);
fs.appendFileSync(path.join(path.dirname(dbFile), "calls.log"), "apply\\n");
const manifest = { run_id: "x", committed: false, inserted_leads: [], updated_leads: [], before: { ...db.counts } };
const write = () => fs.writeFileSync(path.join(runDir, "rollback-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
if (bundle.fail) { write(); console.error("boom with customer details " + bundle.secretName); process.exit(1); }
db.counts.leads += bundle.insert;
db.counts.leads_unarchived += bundle.insert + bundle.unarchive;
db.counts.notifications += bundle.sneakNotifications ?? 0;
manifest.inserted_leads = Array.from({ length: bundle.insert }, (_, i) => ({ id: String(i) }));
manifest.updated_leads = Array.from({ length: bundle.update }, (_, i) => ({ id: String(i) }));
manifest.committed = true;
fs.writeFileSync(dbFile, JSON.stringify(db));
write();
process.exit(0);
`;

const FAKE_ROLLBACK = `
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(argv[argv.indexOf("--manifest") + 1], "utf8"));
if (!argv.includes("--apply")) process.exit(0);
const dbFile = process.env.FAKE_DB;
fs.appendFileSync(path.join(path.dirname(dbFile), "calls.log"), "rollback\\n");
const db = JSON.parse(fs.readFileSync(dbFile, "utf8"));
db.counts = { ...manifest.before };
fs.writeFileSync(dbFile, JSON.stringify(db));
`;

const BASE_BUNDLE = { insert: 3, update: 1, unarchive: 2, noop: 1, skipped: 2, held: 1, secretName: "Zed Example" };
const BASE_COUNTS = { leads: 10, leads_unarchived: 2, notifications: 5, meta_crm_stage_events: 2, whatsapp_capi_events: 1, tasks: 7 };

function writeImportDir(dir, { bundle = BASE_BUNDLE, importProgram = FAKE_IMPORT, rollbackProgram = FAKE_ROLLBACK } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const files = { "import_sheets.mjs": importProgram, "rollback_import.mjs": rollbackProgram, "bundle.json": JSON.stringify(bundle) };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  const manifest = Object.entries(files).map(([name, text]) => `${sha(text)}  ${name}`).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "MANIFEST"), manifest, { mode: 0o600 });
  return { files, manifest };
}

function world(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s20-"));
  fs.chmodSync(root, 0o755);
  const importDir = path.join(root, "opt", "current");
  fs.mkdirSync(path.dirname(importDir), { mode: 0o755 });
  writeImportDir(importDir, options);
  const dbFile = path.join(root, "db.json");
  const state = { phase: "strict", counts: { ...BASE_COUNTS }, batches: { [BATCH]: 4 } };
  fs.writeFileSync(dbFile, JSON.stringify(state));
  const readDb = () => JSON.parse(fs.readFileSync(dbFile, "utf8"));
  const lines = [];
  const events = [];
  const clock = { t: Date.parse("2026-11-19T00:00:00Z") };
  let n = 0;
  const deps = {
    uid,
    url: "not-a-real-url",
    programEnv: { FAKE_DB: dbFile },
    log: (line) => lines.push(line),
    now: () => clock.t,
    id: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    canonicalMain: () => MAIN,
    db: {
      phase: async () => readDb().phase,
      counts: async () => ({ ...readDb().counts }),
      archivedBatchCount: async (id) => readDb().batches[id] ?? 0,
    },
    backup: async () => { events.push({ backup: readDb().counts.leads }); return { file: "newme-prod-x.dump.enc", sha256: "b".repeat(64), bytes: 10 }; },
  };
  const run = (operation, words = [], override = {}) => runDataImport({
    operation, words, mainSha: MAIN, importDir, stateDir: path.join(root, "state"), modulesDir: undefined,
    deps: { ...deps, ...override },
  });
  const calls = () => (fs.existsSync(path.join(root, "calls.log")) ? fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n") : []);
  const bundleHash = () => sha(fs.readFileSync(path.join(importDir, "bundle.json")));
  return { root, importDir, dbFile, readDb, lines, events, clock, deps, run, calls, bundleHash, stateDir: path.join(root, "state") };
}

const applyWords = (planHash, bundleHash, extra = ["--min-leads", "5", "--max-leads", "9"]) => [bundleHash, planHash, ...extra];

async function planned(w) {
  const result = await w.run("data-import-plan");
  return result.planHash;
}

// --- plan ----------------------------------------------------------------------------------------------

test("plan is read-only, prints counts and hashes, never program output or personal data", async () => {
  const w = world();
  const before = w.readDb();
  const planHash = await planned(w);
  assert.deepEqual(w.readDb(), before);
  assert.deepEqual(w.calls(), ["plan"]);
  const text = w.lines.join("\n");
  assert.match(text, /insert=3 unarchive=2 update=1 noop=1 skipped=2 held=1/);
  assert.match(text, /total_leads=7 /);
  assert.ok(text.includes(`bundle_sha256=${w.bundleHash()}`));
  assert.ok(text.includes(`plan_sha256=${planHash}`));
  assert.ok(!text.includes("Zed Example"));
  const plan = path.join(w.stateDir, "plans", `plan-${planHash}.json`);
  assert.equal(fs.statSync(plan).mode & 0o777, 0o600);
  assert.equal(sha(fs.readFileSync(plan)), planHash);
  assert.equal(fs.statSync(w.stateDir).mode & 0o777, 0o700);
});

// --- apply, the good path ------------------------------------------------------------------------------

test("apply backs up first, writes, keeps the four side-effect tables unchanged and records a run", async () => {
  const w = world();
  const planHash = await planned(w);
  const result = await w.run("data-import-apply", applyWords(planHash, w.bundleHash(), ["--min-leads", "5", "--max-leads", "9", "--require-archived-batch", BATCH]));
  assert.equal(result.state, "applied");
  assert.deepEqual(w.events, [{ backup: 10 }], "the backup ran before any write");
  const db = w.readDb().counts;
  assert.equal(db.leads, 13);
  assert.equal(db.leads_unarchived, 7);
  for (const table of ["notifications", "meta_crm_stage_events", "whatsapp_capi_events", "tasks"]) assert.equal(db[table], BASE_COUNTS[table]);
  const run = JSON.parse(fs.readFileSync(path.join(w.stateDir, "runs", result.runId, "run.json"), "utf8"));
  assert.equal(run.state, "applied");
  assert.equal(run.bundle_sha256, w.bundleHash());
  assert.equal(fs.statSync(path.join(w.stateDir, "runs", result.runId, "run.json")).mode & 0o777, 0o600);
  assert.ok(!w.lines.join("\n").includes("Zed Example"));
  assert.ok(!fs.existsSync(path.join(w.stateDir, ".lock")));
});

// --- apply, refusals -----------------------------------------------------------------------------------

async function refused(w, words, pattern, override) {
  const before = w.readDb();
  await assert.rejects(() => w.run("data-import-apply", words, override), pattern);
  assert.deepEqual(w.readDb(), before, "the database is untouched");
  assert.ok(!w.calls().includes("apply"), "the import program never ran in apply mode");
  assert.ok(!fs.existsSync(path.join(w.stateDir, ".lock")), "the lock is released");
}

test("apply refuses a bundle changed on disk after the plan (hash no longer matches MANIFEST)", async () => {
  const w = world();
  const planHash = await planned(w);
  const expected = w.bundleHash();
  fs.writeFileSync(path.join(w.importDir, "bundle.json"), JSON.stringify({ ...BASE_BUNDLE, insert: 99 }));
  await refused(w, applyWords(planHash, expected), /bundle\.json does not match its MANIFEST hash/);
  assert.equal(w.events.length, 0);
});

test("apply refuses when the expected bundle hash is wrong", async () => {
  const w = world();
  const planHash = await planned(w);
  await refused(w, applyWords(planHash, "c".repeat(64)), /expected bundle hash does not match/);
});

test("apply refuses a plan file that was edited", async () => {
  const w = world();
  const planHash = await planned(w);
  const file = path.join(w.stateDir, "plans", `plan-${planHash}.json`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"insert": 3', '"insert": 30'));
  await refused(w, applyWords(planHash, w.bundleHash()), /plan file hash does not match/);
});

test("apply refuses an unknown plan hash", async () => {
  const w = world();
  await planned(w);
  await refused(w, applyWords("d".repeat(64), w.bundleHash()), /no plan file with that hash/);
});

test("apply refuses when the counts moved since the plan was approved", async () => {
  const w = world();
  const planHash = await planned(w);
  const state = w.readDb();
  state.counts.leads_unarchived += 1;
  fs.writeFileSync(w.dbFile, JSON.stringify(state));
  await refused(w, applyWords(planHash, w.bundleHash()), /counts differ from the approved plan/);
});

test("apply refuses lead counts outside the bounds", async () => {
  const w = world();
  const planHash = await planned(w);
  await refused(w, applyWords(planHash, w.bundleHash(), ["--min-leads", "8", "--max-leads", "20"]), /outside the allowed bounds/);
  await refused(w, applyWords(planHash, w.bundleHash(), ["--min-leads", "1", "--max-leads", "6"]), /outside the allowed bounds/);
});

test("apply refuses when the required archive batch is absent", async () => {
  const w = world();
  const planHash = await planned(w);
  await refused(w, applyWords(planHash, w.bundleHash(), ["--min-leads", "5", "--max-leads", "9", "--require-archived-batch", "11111111-1111-4111-8111-111111111111"]), /archive batch has no archived leads/);
});

test("apply refuses without a verified backup (service failure, no file, bad shape)", async () => {
  for (const backup of [async () => { throw Error("no new backup file appeared"); }, async () => null, async () => ({ file: "x", sha256: "short" })]) {
    const w = world();
    const planHash = await planned(w);
    await refused(w, applyWords(planHash, w.bundleHash()), /backup/, { backup });
  }
});

test("every operation refuses a database that is not strict", async () => {
  const w = world();
  const planHash = await planned(w);
  const state = w.readDb();
  state.phase = "compat";
  fs.writeFileSync(w.dbFile, JSON.stringify(state));
  await assert.rejects(() => w.run("data-import-plan"), /strict phase/);
  await refused(w, applyWords(planHash, w.bundleHash()), /strict phase/);
  await assert.rejects(() => w.run("data-import-rollback", ["00000000-0000-4000-8000-000000000001"]), /strict phase/);
});

test("every operation refuses when canonical main is not the named SHA", async () => {
  const w = world();
  const planHash = await planned(w);
  const moved = { canonicalMain: () => "f".repeat(40) };
  await assert.rejects(() => w.run("data-import-plan", [], moved), /canonical main moved/);
  await refused(w, applyWords(planHash, w.bundleHash()), /canonical main moved/, moved);
  await assert.rejects(() => w.run("data-import-rollback", ["00000000-0000-4000-8000-000000000001"], moved), /canonical main moved/);
});

test("apply refuses a plan older than 24 hours", async () => {
  const w = world();
  const planHash = await planned(w);
  w.clock.t += 25 * 3600 * 1000;
  await refused(w, applyWords(planHash, w.bundleHash()), /older than 24 hours/);
});

test("apply refuses when the program plans notifications, events or tasks, or archiving", async () => {
  for (const extra of [{ plannedNotifications: 2 }, { toArchive: 4 }]) {
    const w = world({ bundle: { ...BASE_BUNDLE, ...extra } });
    const planHash = await planned(w);
    await refused(w, applyWords(planHash, w.bundleHash()), /plans notifications|archive leads/);
  }
});

test("a second operation cannot start while the lock exists", async () => {
  const w = world();
  fs.mkdirSync(w.stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(w.stateDir, ".lock"), "1\n");
  await assert.rejects(() => w.run("data-import-plan"), /holds the lock/);
  assert.ok(fs.existsSync(path.join(w.stateDir, ".lock")), "a lock that is not ours is left alone");
});

test("apply and rollback arguments follow a fixed grammar", () => {
  const h = "a".repeat(64);
  assert.throws(() => parseOperationArgs("data-import-plan", ["x"]));
  assert.throws(() => parseOperationArgs("data-import-apply", [h, h]), /--min-leads/);
  assert.throws(() => parseOperationArgs("data-import-apply", [h, h, "--min-leads", "9", "--max-leads", "1"]));
  assert.throws(() => parseOperationArgs("data-import-apply", [h, h, "--min-leads", "1", "--max-leads", "9", "--archive-rest", "1"]));
  assert.throws(() => parseOperationArgs("data-import-apply", [h, "short", "--min-leads", "1", "--max-leads", "9"]));
  assert.throws(() => parseOperationArgs("data-import-apply", [h, h, "--min-leads", "1", "--max-leads", "9", "--require-archived-batch", "../x"]));
  assert.throws(() => parseOperationArgs("data-import-rollback", ["../../etc"]));
  assert.throws(() => parseOperationArgs("data-import-rollback", []));
  assert.equal(parseOperationArgs("data-import-apply", [h, h, "--min-leads", "1", "--max-leads", "9"]).maxLeads, 9);
});

// --- failures after the write starts ---------------------------------------------------------------------

test("apply rolls back automatically when the program fails, and never prints its output", async () => {
  const w = world({ bundle: { ...BASE_BUNDLE, fail: true } });
  const planHash = await planned(w);
  await assert.rejects(() => w.run("data-import-apply", applyWords(planHash, w.bundleHash())), (error) => {
    assert.match(error.message, /rolled back/);
    assert.ok(!error.message.includes("Zed Example"));
    return true;
  });
  assert.deepEqual(w.readDb().counts, BASE_COUNTS);
  const runs = fs.readdirSync(path.join(w.stateDir, "runs"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, "runs", runs[0], "run.json"), "utf8")).state, "failed_rolled_back");
  assert.ok(!w.lines.join("\n").includes("Zed Example"));
});

test("a side effect the program did not announce is caught after the write and rolled back", async () => {
  const w = world({ bundle: { ...BASE_BUNDLE, sneakNotifications: 2 } });
  const planHash = await planned(w);
  await assert.rejects(() => w.run("data-import-apply", applyWords(planHash, w.bundleHash())), /rolled back \(side-effect tables changed: notifications\)/);
  assert.deepEqual(w.readDb().counts, BASE_COUNTS);
  assert.ok(w.calls().includes("rollback"));
});

test("when the rollback itself cannot restore the baseline the run says so loudly", async () => {
  const broken = FAKE_ROLLBACK.replace("db.counts = { ...manifest.before };", "db.counts = { ...db.counts };");
  const w = world({ bundle: { ...BASE_BUNDLE, sneakNotifications: 1 }, rollbackProgram: broken });
  const planHash = await planned(w);
  await assert.rejects(() => w.run("data-import-apply", applyWords(planHash, w.bundleHash())), /AND the database is not back at the baseline/);
  const runs = fs.readdirSync(path.join(w.stateDir, "runs"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, "runs", runs[0], "run.json"), "utf8")).state, "rollback_failed");
});

// --- rollback operation ------------------------------------------------------------------------------------

test("data-import-rollback restores the baseline for one recorded run, once", async () => {
  const w = world();
  const planHash = await planned(w);
  const { runId } = await w.run("data-import-apply", applyWords(planHash, w.bundleHash()));
  assert.equal(w.readDb().counts.leads, 13);
  const result = await w.run("data-import-rollback", [runId]);
  assert.equal(result.state, "rolled_back");
  assert.deepEqual(w.readDb().counts, BASE_COUNTS);
  await assert.rejects(() => w.run("data-import-rollback", [runId]), /nothing to roll back/);
  await assert.rejects(() => w.run("data-import-rollback", ["00000000-0000-4000-8000-0000000000ff"]), /no such import run/);
});

test("rollback goes last in, first out and refuses a changed rollback program", async () => {
  const w = world();
  const first = (await w.run("data-import-apply", applyWords(await planned(w), w.bundleHash()))).runId;
  w.clock.t += 60000;
  const plan2 = await planned(w);
  const second = (await w.run("data-import-apply", applyWords(plan2, w.bundleHash(), ["--min-leads", "5", "--max-leads", "9"]))).runId;
  await assert.rejects(() => w.run("data-import-rollback", [first]), /later import run .* is still in place/);
  writeImportDir(w.importDir, { rollbackProgram: `${FAKE_ROLLBACK}\n// changed` });
  await assert.rejects(() => w.run("data-import-rollback", [second]), /rollback program differs/);
  writeImportDir(w.importDir);
  await w.run("data-import-rollback", [second]);
  await w.run("data-import-rollback", [first]);
  assert.deepEqual(w.readDb().counts, BASE_COUNTS);
});

// --- the import directory and the repository ------------------------------------------------------------------

function dirWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s20d-"));
  fs.chmodSync(root, 0o755);
  const dir = path.join(root, "current");
  writeImportDir(dir);
  return dir;
}
const problems = (dir) => verifyImportDir(dir, { expectedUid: uid }).problems;

test("a correct import directory verifies and reports the bundle hash", () => {
  const dir = dirWorld();
  const verdict = verifyImportDir(dir, { expectedUid: uid });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.bundleSha256, sha(fs.readFileSync(path.join(dir, "bundle.json"))));
});

for (const [label, mutate, pattern] of [
  ["a directory that is not mode 0700", (d) => fs.chmodSync(d, 0o750), /mode must be 0700/],
  ["a world-readable data file", (d) => fs.chmodSync(path.join(d, "bundle.json"), 0o644), /accessible to group or others/],
  ["a tampered bundle", (d) => fs.appendFileSync(path.join(d, "bundle.json"), " "), /bundle\.json does not match its MANIFEST hash/],
  ["a tampered program", (d) => fs.appendFileSync(path.join(d, "import_sheets.mjs"), "\n//"), /import_sheets\.mjs does not match/],
  ["an extra file", (d) => fs.writeFileSync(path.join(d, "notes.txt"), "x", { mode: 0o600 }), /unexpected entry/],
  ["a missing MANIFEST", (d) => fs.rmSync(path.join(d, "MANIFEST")), /MANIFEST is missing/],
  ["a MANIFEST that omits a file", (d) => fs.writeFileSync(path.join(d, "MANIFEST"), fs.readFileSync(path.join(d, "MANIFEST"), "utf8").split("\n").slice(1).join("\n")), /does not list/],
  ["a symlinked data file", (d) => { fs.rmSync(path.join(d, "bundle.json")); fs.symlinkSync("/etc/hostname", path.join(d, "bundle.json")); }, /not a plain file/],
  ["a connection string inside a program", (d) => {
    const text = `${FAKE_IMPORT}\nconst u = "${"post" + "gres"}://user:pw@host/db";\n`;
    fs.writeFileSync(path.join(d, "import_sheets.mjs"), text);
    const lines = fs.readFileSync(path.join(d, "MANIFEST"), "utf8").split("\n").map((l) => (l.endsWith("import_sheets.mjs") ? `${sha(text)}  import_sheets.mjs` : l));
    fs.writeFileSync(path.join(d, "MANIFEST"), lines.join("\n"));
  }, /import_sheets\.mjs contains a connection string/],
]) {
  test(`the import directory check refuses ${label}`, () => {
    const dir = dirWorld();
    mutate(dir);
    assert.match(problems(dir).join("; "), pattern);
  });
}

test("the import directory check refuses a missing directory, a symlink and a foreign owner", () => {
  const dir = dirWorld();
  assert.match(problems(`${dir}-none`).join(";"), /does not exist/);
  const link = `${dir}-link`;
  fs.symlinkSync(dir, link);
  assert.match(problems(link).join(";"), /not a real directory/);
  assert.match(verifyImportDir(dir, { expectedUid: uid + 1 }).problems.join(";"), /not owned by root/);
});

test("the program scan names rules only", () => {
  assert.deepEqual(scanProgramText("const a = process.env.NEWME_IMPORT_DB_URL;"), []);
  assert.deepEqual(scanProgramText(`password: "${"hunter"}22"`), ["literal password"]);
  assert.deepEqual(scanProgramText("-----BEGIN " + "RSA PRIVATE KEY-----"), ["private key block"]);
  assert.equal(parseManifest("nonsense\n").problems.length > 0, true);
});

test("no import program, data bundle or run artifact is tracked in the repository", () => {
  assert.deepEqual(checkRepository(new URL("../..", import.meta.url).pathname), []);
  assert.ok(judgeRepositoryFiles(["tools/bundle.json"]).length === 1);
  assert.ok(judgeRepositoryFiles(["x/import_sheets.mjs"]).length === 1);
  assert.ok(judgeRepositoryFiles(["review/reimport/runs/a.log"]).length === 1);
  assert.ok(judgeRepositoryFiles(["data/export.json"], () => '{"Master Lead ID":"X"}').length === 1);
  assert.deepEqual(judgeRepositoryFiles(["package.json"], () => '{"name":"x"}'), []);
});

// --- backup helper --------------------------------------------------------------------------------------------

function backupWorld(behaviour) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s20b-"));
  fs.writeFileSync(path.join(dir, "newme-prod-old.dump.enc"), "old");
  const spawn = () => {
    behaviour(dir);
    return { status: behaviour.status ?? 0 };
  };
  return { dir, spawn };
}

test("takeBackup accepts a new checksummed dump and refuses everything else", () => {
  const good = backupWorld((dir) => {
    fs.writeFileSync(path.join(dir, "newme-prod-new.dump.enc"), "dump");
    fs.writeFileSync(path.join(dir, "newme-prod-new.dump.enc.sha256"), `${sha("dump")}  newme-prod-new.dump.enc\n`);
  });
  assert.equal(takeBackup({ backupDir: good.dir, spawn: good.spawn }).file, "newme-prod-new.dump.enc");
  const none = backupWorld(() => {});
  assert.throws(() => takeBackup({ backupDir: none.dir, spawn: none.spawn }), /no new backup/);
  const noSum = backupWorld((dir) => fs.writeFileSync(path.join(dir, "newme-prod-new.dump.enc"), "dump"));
  assert.throws(() => takeBackup({ backupDir: noSum.dir, spawn: noSum.spawn }), /no checksum/);
  const wrong = backupWorld((dir) => {
    fs.writeFileSync(path.join(dir, "newme-prod-new.dump.enc"), "dump");
    fs.writeFileSync(path.join(dir, "newme-prod-new.dump.enc.sha256"), `${"0".repeat(64)}  x\n`);
  });
  assert.throws(() => takeBackup({ backupDir: wrong.dir, spawn: wrong.spawn }), /does not match its checksum/);
  assert.throws(() => takeBackup({ backupDir: none.dir, spawn: () => ({ status: 1 }) }), /did not complete/);
});

test("plan summary needs every count; side-effect judgement flags any change or unknown", () => {
  assert.throws(() => summarizePlan({ counts: { leads_by_action: { INSERT: 1 } } }), /lacks a valid/);
  assert.deepEqual(judgeSideEffects({ notifications: 1, tasks: 1, meta_crm_stage_events: 1, whatsapp_capi_events: null }, { notifications: 1, tasks: 2, meta_crm_stage_events: 1, whatsapp_capi_events: null }), ["tasks"]);
  assert.equal(judgeSideEffects({}, {}).length, 4);
});

// --- the command line and the deploy wrapper ----------------------------------------------------------------------

test("the command line takes only the fixed flags", () => {
  const script = new URL("../../scripts/data-import-gate.mjs", import.meta.url).pathname;
  for (const argv of [[], ["--operation", "data-import-plan"], ["--import-dir", "/tmp", "--"], ["--operation", "data-import-plan", "--main-sha", MAIN, "--url-file", "x", "--modules-dir", "y"]]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid data-import arguments/);
  }
});

test("the runner never asks the program to archive the rest, allow side effects or hold sales-only rows", () => {
  const source = fs.readFileSync(new URL("../../scripts/data-import-gate.mjs", import.meta.url), "utf8");
  for (const forbidden of ["--archive-rest", "--allow-side-effects", "--hold-sales-only", "--owner-map", "--synthesize-identity"]) assert.ok(!source.includes(forbidden), forbidden);
  assert.ok(!/postgres(?:ql)?:\/\//i.test(source));
  assert.ok(source.includes("NEWME_IMPORT_DB_URL"));
});

test("the deploy wrapper gates the data-import operations like the other additive switches", () => {
  const wrapper = fs.readFileSync(new URL("../../infra/systemd/newme-deploy.sh", import.meta.url), "utf8");
  assert.match(wrapper, /data-import-plan\|data-import-apply\|data-import-rollback\) ;;/);
  assert.match(wrapper, /\|data-import-plan\|data-import-apply\|data-import-rollback(?:\|[a-z0-9-]+)*>" >&2/);
  const start = wrapper.indexOf('= data-import-plan ]');
  const block = wrapper.slice(start, wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in', start));
  assert.match(block, /merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(block, /--phase deferred_contract --verify-only/);
  assert.match(block, /check-s20-import-gate\.mjs[\s\S]*--import-dir \/opt\/newme-import\/current/);
  assert.match(block, /require_canonical_main_sha "\$SHA" \|\| exit 65/);
  assert.match(block, /require_ci_gate_still_fresh \|\| exit 65/);
  assert.match(wrapper, /data-import-plan\|data-import-apply\|data-import-rollback\)\s+"\$NODE_BIN" "\$WORKTREE\/scripts\/data-import-gate\.mjs"[\s\S]*?--url-file "\$MIGRATION_DB_URL_FILE"/);
  // the extra words are parked in an array, never evaluated, and only for these three operations
  assert.match(wrapper, /DATA_IMPORT_ARGS=\("\$\{@:4\}"\)/);
  assert.ok(!/eval\s/.test(wrapper.slice(wrapper.indexOf("DATA_IMPORT_ARGS=()"), wrapper.indexOf("DATA_IMPORT_ARGS=()") + 600)));
  // every other operation still requires exactly three words
  assert.match(wrapper, /if \[ "\$#" -ne 3 \] \|\| ! \[\[ "\$SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then/);
  assert.match(wrapper, /s18-db-plan\|s18-db-provision\) ;;/);
});
