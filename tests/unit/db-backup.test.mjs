// S7 item 7: daily encrypted backup + monthly restore drill. Every database tool is
// replaced by a stub on PATH, so these tests exercise the real scripts (permission
// gates, encryption, retention, NAS sync, drill safety gates) without any database.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const infra = (name) => fileURLToPath(new URL(`../../infra/backup/${name}`, import.meta.url));
const PROD_REF = "vfopmpxlhwzpxqegayew";
const STAGING_REF = "bfsiibofuzoglziltgyd";
const PASSWORD = "p4ssw0rd-do-not-leak";

function sandbox({ dbUrl = `postgresql://postgres.${PROD_REF}:${PASSWORD}@aws-0.pooler.supabase.com:5432/postgres`, rsyncFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "newme-backup-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls.log");
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("pg_dump", `printf 'pg_dump %s\\n' "$*" >> "${calls}"
cat "$PGSERVICEFILE" | grep -c password >> "${calls}.service"
out=""; for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done
head -c 200000 /dev/zero | tr '\\0' 'x' > "$out"; printf 'SECRETROW-customer-data' >> "$out"`);
  // The stub rejects what the real pg_restore 17 rejects (an argument on --exit-on-error),
  // and only "restores" when it is called with a valid command line.
  stub("pg_restore", `for a in "$@"; do case "$a" in --exit-on-error=*) echo "pg_restore: error: option '--exit-on-error' doesn't allow an argument" >&2; exit 1;; esac; done
case "$*" in
  *--list*) exit 0;;
  *--data-only*)
    extra=0; case "$*" in *verify.dump*) extra=\${COUNT_DRIFT:-0};; esac
    printf 'COPY public.leads (id) FROM stdin;\\n1\\n2\\n3\\n'; for i in $(seq 1 $extra); do echo 9; done; printf '\\\\.\\nCOPY public.profiles (id) FROM stdin;\\n1\\n\\\\.\\n'; exit 0;;
  *) printf 'pg_restore %s\\n' "$*" >> "${calls}"; touch "${root}/restored"; exit 0;;
esac`);
  stub("psql", `printf 'psql %s\\n' "$*" >> "${calls}"
case "$*" in
  *"current_database()"*) if [ -n "\${DRILL_WRONG_DB:-}" ]; then echo postgres; else awk '/^\\[scratch\\]/{f=1;next} f&&/^dbname=/{sub(/^dbname=/,"");print;exit}' "$PGSERVICEFILE"; fi;;
  *"from pg_database"*) echo \${DRILL_DB_LEFT:-0};;
  *"count(*) from public.leads"*) [ -e "${root}/restored" ] && echo \${DRILL_LEADS:-3} || echo MISSING;;
  *"count(*) from public.profiles"*) [ -e "${root}/restored" ] && echo 1 || echo MISSING;;
  *) exit 0;;
esac`);
  stub("rsync", `printf 'rsync %s\\n' "$*" >> "${calls}"; ${rsyncFails ? "exit 23" : "exit 0"}`);
  stub("alert.sh", `printf 'alert %s %s %s\\n' "$1" "$2" "$3" >> "${calls}"`);
  const keyFile = join(root, "key"); writeFileSync(keyFile, "k".repeat(48), { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const urlFile = join(root, "db.url"); writeFileSync(urlFile, dbUrl, { mode: 0o600 }); chmodSync(urlFile, 0o600);
  const stagingUrl = join(root, "staging.url");
  writeFileSync(stagingUrl, `postgresql://postgres.${STAGING_REF}:${PASSWORD}@aws-0.pooler.supabase.com:5432/postgres`, { mode: 0o600 }); chmodSync(stagingUrl, 0o600);
  const backups = join(root, "backups");
  const env = (extra = {}) => ({
    PATH: `${bin}:${process.env.PATH}`, BACKUP_ENV_FILE: join(root, "none.env"), NEWME_DB_URL_FILE: urlFile, BACKUP_KEY_FILE: keyFile,
    BACKUP_DIR: backups, BACKUP_ALERT_SCRIPT: join(bin, "alert.sh"), STAGING_DB_URL_FILE: stagingUrl, HOME: root, TMPDIR: root, ...extra,
  });
  const backup = (args = [], extra = {}) => spawnSync("bash", [infra("newme-db-backup.sh"), ...args], { encoding: "utf8", env: env(extra) });
  const drill = (args = [], extra = {}) => spawnSync("bash", [infra("newme-restore-drill.sh"), ...args], { encoding: "utf8", env: env(extra) });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { root, backups, backup, drill, log, urlFile, keyFile, stagingUrl, env };
}

test("dry run validates configuration and dumps nothing", () => {
  const s = sandbox();
  const r = s.backup(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /configuration and permissions are valid/);
  assert.ok(!s.log().includes("pg_dump"));
  assert.equal(statSync(s.backups).mode & 0o777, 0o700);
});

test("refuses a key file or URL file that others can read", () => {
  const s = sandbox();
  chmodSync(s.keyFile, 0o644);
  const r = s.backup(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mode 400\/600/);
  chmodSync(s.keyFile, 0o600);
  chmodSync(s.urlFile, 0o640);
  assert.equal(s.backup(["--dry-run"]).status, 2);
});

test("backup is encrypted, checksummed, private, leaves no plaintext and never exposes the password", () => {
  const s = sandbox();
  const r = s.backup([], { BACKUP_STAMP: "20261105T013000Z" });
  assert.equal(r.status, 0, r.stderr);
  const enc = join(s.backups, "newme-prod-20261105T013000Z.dump.enc");
  assert.ok(existsSync(enc) && existsSync(`${enc}.sha256`) && existsSync(`${enc}.counts.tsv`));
  for (const f of [enc, `${enc}.sha256`, `${enc}.counts.tsv`]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  assert.ok(!readFileSync(enc).includes("SECRETROW"), "ciphertext must not contain the plaintext");
  assert.deepEqual(readdirSync(s.backups).filter((n) => n.startsWith(".work")), [], "work directory removed");
  assert.equal(readFileSync(`${enc}.counts.tsv`, "utf8"), "public.leads\t3\npublic.profiles\t1\n");
  assert.ok(!s.log().includes(PASSWORD), "password must never reach a command line");
  assert.match(s.log(), /pg_dump service=newme /);
  assert.ok(!r.stderr.includes(PASSWORD) && !r.stdout.includes(PASSWORD));
  const back = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-pass", `file:${s.keyFile}`, "-in", enc], { maxBuffer: 1 << 24 });
  assert.ok(back.stdout.includes("SECRETROW"), "decrypts with the key file");
  assert.match(s.log(), /alert db-backup recovery/);
});

test("retention prunes old artefacts but always keeps the newest few", () => {
  const s = sandbox();
  mkdirSync(s.backups, { recursive: true, mode: 0o700 });
  chmodSync(s.backups, 0o700);
  const old = (Date.now() - 45 * 86_400_000) / 1000;
  for (let i = 1; i <= 5; i += 1) {
    const f = join(s.backups, `newme-prod-2026090${i}T000000Z.dump.enc`);
    writeFileSync(f, "x"); writeFileSync(`${f}.sha256`, "x"); writeFileSync(`${f}.counts.tsv`, "x");
    utimesSync(f, old - i, old - i);
  }
  const r = s.backup([], { KEEP_MIN: "3", RETENTION_DAYS: "30", BACKUP_STAMP: "20261105T013000Z" });
  assert.equal(r.status, 0, r.stderr);
  const kept = readdirSync(s.backups).filter((n) => n.endsWith(".dump.enc"));
  assert.equal(kept.length, 3, kept.join(","));
  assert.ok(kept.includes("newme-prod-20261105T013000Z.dump.enc"));
});

test("NAS sync failure keeps the local backup, exits 3 and alerts", () => {
  const s = sandbox({ rsyncFails: true });
  const r = s.backup([], { SYNC_TARGET: "backup@nas.tailnet.ts.net:/volume1/newme", BACKUP_STAMP: "20261105T013000Z" });
  assert.equal(r.status, 3);
  assert.ok(existsSync(join(s.backups, "newme-prod-20261105T013000Z.dump.enc")));
  assert.match(s.log(), /alert db-backup failure database backup is stored locally but the NAS copy failed/);
  assert.match(s.log(), /rsync .*StrictHostKeyChecking=yes/);
});

test("a dump that is too small is rejected", () => {
  const s = sandbox();
  const r = s.backup([], { MIN_PLAIN_BYTES: "999999999" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /suspiciously small/);
  assert.match(s.log(), /alert db-backup failure db-backup: dump is suspiciously small/);
});

test("restore drill refuses a production or unknown target", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  writeFileSync(s.stagingUrl, `postgresql://postgres.${PROD_REF}:${PASSWORD}@aws-0.pooler.supabase.com:5432/postgres`);
  let r = s.drill(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mentions the production project/);
  writeFileSync(s.stagingUrl, `postgresql://postgres.someotherproject:${PASSWORD}@aws-0.pooler.supabase.com:5432/postgres`);
  r = s.drill(["--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pooler user is not the staging project/);
  assert.ok(!s.log().includes("create database"));
});

test("restore drill passes when every table count matches and drops the scratch database", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  assert.equal(s.drill(["--dry-run"]).status, 0);
  const r = s.drill([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DRILL PASSED: 2 tables match/);
  assert.match(s.log(), /create database "drill_/);
  assert.match(s.log(), /drop database if exists "drill_/);
  assert.match(s.log(), /alert db-restore-drill recovery/);
  assert.ok(!s.log().includes(PASSWORD));
});

test("restore drill fails loudly when a restored table differs", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const r = s.drill([], { DRILL_LEADS: "2" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MISMATCH public\.leads: backup=3 restored=2/);
  assert.match(s.log(), /alert db-restore-drill failure/);
  assert.match(s.log(), /drop database if exists "drill_/, "scratch database is dropped even on failure");
});

test("restore drill detects a tampered backup", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const enc = join(s.backups, "newme-prod-20261105T013000Z.dump.enc");
  writeFileSync(enc, Buffer.concat([readFileSync(enc), Buffer.from("tamper")]));
  const r = s.drill([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum/);
});

// ---- S7 review rework -------------------------------------------------------

const hoursAgo = (h) => (Date.now() - h * 3_600_000) / 1000;

test("every backup failure path alerts before exiting: small dump, row mismatch, missing key, missing URL file", () => {
  // too small
  let s = sandbox();
  assert.equal(s.backup([], { MIN_PLAIN_BYTES: "999999999" }).status, 1);
  assert.match(s.log(), /alert db-backup failure .*suspiciously small/);

  // decrypted row counts differ from the dump's own
  s = sandbox();
  let r = s.backup([], { COUNT_DRIFT: "2", BACKUP_STAMP: "20261105T013000Z" });
  assert.equal(r.status, 1);
  assert.match(s.log(), /alert db-backup failure .*verification counts differ/);
  assert.ok(!existsSync(join(s.backups, "newme-prod-20261105T013000Z.dump.enc")), "unverified artefact is not kept");

  // key file missing (exit 2 configuration)
  s = sandbox();
  rmSync(s.keyFile);
  r = s.backup([]);
  assert.equal(r.status, 2);
  assert.match(s.log(), /alert db-backup failure .*encryption key file is missing/);

  // connection URL file missing
  s = sandbox();
  rmSync(s.urlFile);
  assert.equal(s.backup([]).status, 2);
  assert.match(s.log(), /alert db-backup failure .*database URL file is missing/);

  // a tool dying under set -e (unexpected failure) is caught by the exit handler
  s = sandbox();
  writeFileSync(join(s.root, "bin", "openssl"), "#!/usr/bin/env bash\nexit 7\n", { mode: 0o755 });
  assert.equal(s.backup([]).status, 7);
  assert.match(s.log(), /alert db-backup failure database backup failed \(exit 7/);
  assert.equal(s.log().match(/alert db-backup failure/g).length, 1, "exactly one alert per failure");
});

test("dry runs never alert, even when configuration is wrong", () => {
  const s = sandbox();
  rmSync(s.keyFile);
  assert.equal(s.backup(["--dry-run"]).status, 2);
  assert.ok(!s.log().includes("alert"));
});

test("restore drill: no backup, checksum mismatch and missing counts file all alert", () => {
  let s = sandbox();
  let r = s.drill([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no backup file found/);
  assert.match(s.log(), /alert db-restore-drill failure .*no backup file found/);

  s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const enc = join(s.backups, "newme-prod-20261105T013000Z.dump.enc");
  writeFileSync(enc, Buffer.concat([readFileSync(enc), Buffer.from("tamper")]));
  assert.equal(s.drill([]).status, 1);
  assert.match(s.log(), /alert db-restore-drill failure .*checksum mismatch/);

  s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  rmSync(`${join(s.backups, "newme-prod-20261105T013000Z.dump.enc")}.counts.tsv`);
  assert.equal(s.drill([]).status, 2);
  assert.match(s.log(), /alert db-restore-drill failure .*counts\/checksum files missing/);
});

test("restore drill uses a valid pg_restore command line and the restore really runs", () => {
  const script = readFileSync(infra("newme-restore-drill.sh"), "utf8");
  assert.ok(!/--exit-on-error/.test(script.replace(/#.*$/gm, "")), "the illegal --exit-on-error=false is gone");
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const r = s.drill([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.log(), /pg_restore --dbname=service=scratch --no-owner --no-privileges /);
  // The same options against the REAL pg_restore on this machine must parse (it then
  // fails only on the missing input file).
  const real = spawnSync("pg_restore", ["--dbname=service=scratch", "--no-owner", "--no-privileges", "/nonexistent/x.dump"], { encoding: "utf8" });
  if (real.error?.code !== "ENOENT") {
    assert.doesNotMatch(real.stderr, /unrecognized option|doesn't allow an argument|invalid option|requires an argument/);
    assert.match(real.stderr, /could not open input file/);
    const bad = spawnSync("pg_restore", ["--exit-on-error=false", "/nonexistent/x.dump"], { encoding: "utf8" });
    assert.match(bad.stderr, /doesn't allow an argument/, "documents why the old flag could never work");
  }
});

test("restore drill refuses every way of disguising the production project (dry run, fake password)", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const POOLER = "aws-0-eu-west-1.pooler.supabase.com";
  const encodedProd = PROD_REF.replace("v", "%76");
  const bypasses = {
    "percent-encoded production id in the pooler user, staging id hidden in a parameter": `postgresql://postgres.${encodedProd}:${PASSWORD}@${POOLER}:6543/postgres?application_name=${STAGING_REF}`,
    "double-encoded production id": `postgresql://postgres.${PROD_REF.replace("v", "%2576")}:${PASSWORD}@${POOLER}:6543/postgres?x=${STAGING_REF}`,
    "upper-case production host with staging id in the query": `postgresql://postgres:${PASSWORD}@db.${PROD_REF.toUpperCase()}.supabase.co:5432/postgres?x=${STAGING_REF}`,
    "production host with staging id in the path": `postgresql://postgres:${PASSWORD}@db.${PROD_REF}.supabase.co:5432/${STAGING_REF}`,
    "production id in the user, staging id in the database name": `postgresql://postgres.${PROD_REF}:${PASSWORD}@${POOLER}:5432/${STAGING_REF}`,
    "staging id only in a comment-like fragment": `postgresql://postgres.${PROD_REF}:${PASSWORD}@${POOLER}:5432/postgres#${STAGING_REF}`,
    "staging user on a look-alike host": `postgresql://postgres.${STAGING_REF}:${PASSWORD}@${POOLER}.evil.example:5432/postgres`,
    "staging user on an unrelated host": `postgresql://postgres.${STAGING_REF}:${PASSWORD}@evil.example.com:5432/postgres`,
    "staging direct host with a suffix": `postgresql://postgres:${PASSWORD}@db.${STAGING_REF}.supabase.co.evil.example:5432/postgres`,
    "pooler with the wrong (plain) user": `postgresql://postgres:${PASSWORD}@${POOLER}:5432/postgres`,
    "pooler user is staging id plus extra": `postgresql://postgres.${STAGING_REF}x:${PASSWORD}@${POOLER}:5432/postgres`,
    "encoded dot in the host": `postgresql://postgres:${PASSWORD}@db%2E${STAGING_REF}%2Esupabase.co:5432/postgres`,
    "userinfo trick with a second at-sign": `postgresql://postgres.${STAGING_REF}:p@ss@db.${PROD_REF}.supabase.co:5432/postgres`,
  };
  for (const [name, url] of Object.entries(bypasses)) {
    writeFileSync(s.stagingUrl, url);
    const r = s.drill(["--dry-run"]);
    assert.equal(r.status, 2, `${name} must be refused: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/, name);
    assert.ok(!r.stderr.includes(PASSWORD) && !r.stdout.includes(PASSWORD));
  }
  assert.ok(!s.log().includes("create database"), "nothing was created for any refused target");
  // The two legitimate shapes still pass.
  for (const url of [
    `postgresql://postgres:${PASSWORD}@db.${STAGING_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${STAGING_REF}:${PASSWORD}@${POOLER}:6543/postgres`,
    `postgresql://postgres.${STAGING_REF.toUpperCase()}:${PASSWORD}@${POOLER.toUpperCase()}:6543/postgres`,
  ]) {
    writeFileSync(s.stagingUrl, url);
    const r = s.drill(["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
  }
});

test("restore drill checks the connected database and stops when it is not the scratch database", () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  const r = s.drill([], { DRILL_WRONG_DB: "1" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /connected database is not the scratch database/);
  assert.ok(!s.log().includes("pg_restore --dbname"), "nothing restored into the wrong database");
  assert.match(s.log(), /alert db-restore-drill failure/);
});

test("scratch database is dropped with force and its removal is verified; a leftover raises a critical alert", () => {
  let s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  let r = s.drill([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.log(), /drop database if exists "drill_[0-9]+" with \(force\)/);
  assert.match(s.log(), /select count\(\*\) from pg_database where datname = 'drill_/);

  s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  r = s.drill([], { DRILL_DB_LEFT: "1" });
  assert.equal(r.status, 1, "a drill that cannot clean up is a failure even if the counts match");
  assert.match(r.stderr, /CRITICAL: scratch database drill_/);
  assert.match(s.log(), /alert db-restore-drill failure CRITICAL: restore drill scratch database drill_/);
});

test("startup removes plaintext work directories and .part files left by a killed run, keeps fresh ones", () => {
  const s = sandbox();
  mkdirSync(s.backups, { recursive: true, mode: 0o700 });
  chmodSync(s.backups, 0o700);
  const oldWork = join(s.backups, ".work.OLDKILL");
  const newWork = join(s.backups, ".work.FRESH1");
  mkdirSync(oldWork, { mode: 0o700 }); mkdirSync(newWork, { mode: 0o700 });
  writeFileSync(join(oldWork, "plain.dump"), "PLAINTEXT-LEFTOVER");
  writeFileSync(join(newWork, "plain.dump"), "in-flight");
  utimesSync(oldWork, hoursAgo(30), hoursAgo(30));
  const oldPart = join(s.backups, "newme-prod-20261101T000000Z.dump.enc.part");
  const newPart = join(s.backups, "newme-prod-20261104T000000Z.dump.enc.part");
  writeFileSync(oldPart, "x"); writeFileSync(newPart, "x");
  utimesSync(oldPart, hoursAgo(30), hoursAgo(30));
  const r = s.backup([], { BACKUP_STAMP: "20261105T013000Z" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(oldWork) && !existsSync(oldPart), "stale leftovers removed");
  assert.ok(existsSync(newWork) && existsSync(newPart), "recent files (possibly a live run) are untouched");
});

test("freshness check: stale, missing and unfinished backups alert; a fresh one does not", () => {
  const fresh = (s, hours, stamp = "20261105T013000Z") => {
    mkdirSync(s.backups, { recursive: true, mode: 0o700 });
    const f = join(s.backups, `newme-prod-${stamp}.dump.enc`);
    writeFileSync(f, "x"); writeFileSync(`${f}.sha256`, "x");
    utimesSync(f, hoursAgo(hours), hoursAgo(hours));
    return f;
  };
  const run = (s, extra = {}) => spawnSync("bash", [infra("newme-backup-freshness.sh")], { encoding: "utf8", env: s.env(extra) });

  let s = sandbox();
  assert.equal(run(s).status, 1);
  assert.match(s.log(), /alert db-backup-freshness failure .*no finished database backup/);

  s = sandbox(); fresh(s, 27);
  let r = run(s);
  assert.equal(r.status, 1);
  assert.match(s.log(), /alert db-backup-freshness failure .*27 hours old \(limit 26\)/);

  s = sandbox(); fresh(s, 25);
  r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!s.log().includes("failure"));
  assert.match(s.log(), /alert db-backup-freshness recovery/);

  // an unfinished (.part / no checksum) newer file does not count as a backup
  s = sandbox(); fresh(s, 40, "20261103T013000Z");
  writeFileSync(join(s.backups, "newme-prod-20261105T013000Z.dump.enc.part"), "x");
  const noSum = join(s.backups, "newme-prod-20261104T013000Z.dump.enc"); writeFileSync(noSum, "x");
  assert.equal(run(s).status, 1);
  assert.match(s.log(), /alert db-backup-freshness failure .*40 hours old/);
});

test("systemd: both services have OnFailure alerting, the alert unit runs the on-failure script, freshness timer is hourly", () => {
  for (const unit of ["newme-db-backup.service", "newme-restore-drill.service", "newme-backup-freshness.service"]) {
    assert.match(readFileSync(infra(unit), "utf8"), /^OnFailure=newme-backup-alert@%n\.service$/m, unit);
  }
  assert.match(readFileSync(infra("newme-backup-alert@.service"), "utf8"), /ExecStart=\/usr\/local\/libexec\/newme\/newme-backup-onfailure\.sh %i/);
  assert.match(readFileSync(infra("newme-backup-freshness.timer"), "utf8"), /OnCalendar=\*:17:00/);
  const s = sandbox();
  const r = spawnSync("bash", [infra("newme-backup-onfailure.sh"), "newme-db-backup.service"], { encoding: "utf8", env: s.env() });
  assert.equal(r.status, 0);
  assert.match(s.log(), /alert db-backup failure systemd unit newme-db-backup\.service ended in failure/);
  const r2 = spawnSync("bash", [infra("newme-backup-onfailure.sh"), "newme-restore-drill.service"], { encoding: "utf8", env: s.env() });
  assert.equal(r2.status, 0);
  assert.match(s.log(), /alert db-restore-drill failure systemd unit newme-restore-drill\.service/);
});
