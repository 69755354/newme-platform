// S7 item 7: daily encrypted backup + monthly restore drill. Every database tool is
// replaced by a stub on PATH, so these tests exercise the real scripts (permission
// gates, encryption, retention, NAS sync, drill safety gates) without any database.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const infra = (name) => fileURLToPath(new URL(`../../infra/backup/${name}`, import.meta.url));
const PROD_REF = "vfopmpxlhwzpxqegayew";
const PASSWORD = "p4ssw0rd-do-not-leak";
const hoursAgo = (h) => (Date.now() - h * 3_600_000) / 1000;

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
  *) printf 'pg_restore %s\\n' "$*" >> "${calls}"; touch "${root}/restored"; [ -n "\${DRILL_RESTORE_ERR:-}" ] && printf '%b\\n' "$DRILL_RESTORE_ERR"; exit 0;;
esac`);
  stub("psql", `printf 'psql %s\\n' "$*" >> "${calls}"
case "$*" in
  *"data_directory"*) if [ -n "\${DRILL_WRONG_DIR:-}" ]; then echo /var/lib/other; else echo "$DRILL_ROOT/data"; fi;;
  *"inet_server_addr"*) if [ -n "\${DRILL_TCP:-}" ]; then echo f; else echo t; fi;;
  *"count(*) from public.leads"*) [ -e "${root}/restored" ] && echo \${DRILL_LEADS:-3} || echo MISSING;;
  *"count(*) from public.profiles"*) [ -e "${root}/restored" ] && echo 1 || echo MISSING;;
  *) exit 0;;
esac`);
  stub("runuser", `printf 'runuser %s\\n' "$*" >> "${calls}"; shift 3; exec "$@"`);
  stub("initdb", `printf 'initdb %s\\n' "$*" >> "${calls}"; while [ $# -gt 0 ]; do [ "$1" = -D ] && mkdir -p "$2"; shift; done`);
  stub("pg_ctl", `printf 'pg_ctl %s\\n' "$*" >> "${calls}"; case "$*" in *" start"*) : > "$DRILL_ROOT/data/postmaster.pid";; esac; exit 0`);
  stub("rm", `if [ -n "\${DRILL_RM_FAILS:-}" ]; then for a in "$@"; do [ "$a" = "$DRILL_ROOT" ] && exit 0; done; fi; exec /bin/rm "$@"`);
  stub("rsync", `printf 'rsync %s\\n' "$*" >> "${calls}"; ${rsyncFails ? "exit 23" : "exit 0"}`);
  stub("alert.sh", `printf 'alert %s %s %s\\n' "$1" "$2" "$3" >> "${calls}"`);
  const keyFile = join(root, "key"); writeFileSync(keyFile, "k".repeat(48), { mode: 0o600 }); chmodSync(keyFile, 0o600);
  const urlFile = join(root, "db.url"); writeFileSync(urlFile, dbUrl, { mode: 0o600 }); chmodSync(urlFile, 0o600);
  const backups = join(root, "backups");
  const env = (extra = {}) => ({
    PATH: `${bin}:${process.env.PATH}`, BACKUP_ENV_FILE: join(root, "none.env"), NEWME_DB_URL_FILE: urlFile, BACKUP_KEY_FILE: keyFile,
    BACKUP_DIR: backups, BACKUP_ALERT_SCRIPT: join(bin, "alert.sh"), PG_BIN: bin, DRILL_ROOT: join(root, "drill"), DRILL_PG_USER: userInfo().username, DRILL_PG_PORT: "5439", HOME: root, TMPDIR: root, ...extra,
  });
  const backup = (args = [], extra = {}) => spawnSync("bash", [infra("newme-db-backup.sh"), ...args], { encoding: "utf8", env: env(extra) });
  const drill = (args = [], extra = {}) => spawnSync("bash", [infra("newme-restore-drill.sh"), ...args], { encoding: "utf8", env: env(extra) });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { root, backups, backup, drill, log, urlFile, keyFile, env };
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


// ---- restore drill into a throwaway local PostgreSQL 17 ---------------------

const setupBackup = () => {
  const s = sandbox();
  assert.equal(s.backup([], { BACKUP_STAMP: "20261105T013000Z" }).status, 0);
  return s;
};

test("drill reads /etc/newme/backup.env-style config: values in the file take effect (regression: ENV_FILE line was lost)", () => {
  const s = setupBackup();
  const envFile = join(s.root, "backup.env");
  writeFileSync(envFile, `BACKUP_DIR=${s.backups}\n`, { mode: 0o600 }); chmodSync(envFile, 0o600);
  // BACKUP_DIR is deliberately NOT in the process environment: only the file knows it.
  const r = s.drill(["--dry-run"], { BACKUP_ENV_FILE: envFile, BACKUP_DIR: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`newme-prod-20261105T013000Z`));
  // And the file is held to the same permission rule as for the backup script.
  chmodSync(envFile, 0o644);
  const bad = s.drill(["--dry-run"], { BACKUP_ENV_FILE: envFile, BACKUP_DIR: "" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /mode 400\/600/);
  // Same for the other two scripts.
  chmodSync(envFile, 0o600);
  const fresh = spawnSync("bash", [infra("newme-backup-freshness.sh")], { encoding: "utf8", env: s.env({ BACKUP_ENV_FILE: envFile, BACKUP_DIR: "" }) });
  assert.equal(fresh.status, 0, fresh.stderr);
});

test("drill restores into a local socket-only instance: no URL file, no network, role/extension bootstrap before the restore", () => {
  const s = setupBackup();
  const r = s.drill([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DRILL PASSED: 2 tables match/);
  const log = s.log();
  assert.match(log, /runuser -u \S+ -- .*\/initdb -D .*\/drill\/data -U postgres -A trust --no-sync/);
  assert.match(log, /pg_ctl -D .*\/drill\/data -w -s -o -c listen_addresses='' -k .*\/drill\/sock -p 5439 .*shared_buffers=128MB.*fsync=off/);
  // every client connection goes through the socket directory, never a host name
  for (const line of log.split("\n").filter((l) => /^(psql|pg_restore) /.test(l))) assert.match(line, /-h \S+\/drill\/sock /, line);
  assert.ok(!/service=|postgres(ql)?:\/\//.test(log.slice(log.indexOf("runuser"))), "the drill uses no connection URL or service file");
  assert.ok(log.indexOf("create role anon") < log.indexOf("pg_restore -h"), "bootstrap runs before the restore");
  for (const need of ["anon", "authenticated", "service_role", "supabase_auth_admin", "create schema if not exists extensions", 'uuid-ossp', "pgcrypto"]) assert.ok(log.includes(need), need);
  assert.match(log, /pg_restore -h \S+\/drill\/sock -p 5439 -U postgres -d drill --no-owner --no-privileges /);
  assert.match(log, /pg_ctl -D \S+\/drill\/data -m immediate -w stop/);
  assert.ok(!existsSync(join(s.root, "drill")), "instance directory removed");
  assert.match(log, /alert db-restore-drill recovery/);
  assert.ok(existsSync(join(s.backups, ".restore-drill-last-pass")), "pass stamp written for the 35-day check");
  assert.ok(!log.includes(PASSWORD));
});

test("drill never starts the throwaway instance on a dry run and leaves an existing drill directory alone", () => {
  const s = setupBackup();
  mkdirSync(join(s.root, "drill"));
  assert.equal(s.drill(["--dry-run"]).status, 0);
  assert.ok(existsSync(join(s.root, "drill")));
  assert.ok(!s.log().includes("initdb"));
});

test("drill refuses to restore unless the session is a socket connection to its own data directory", () => {
  for (const extra of [{ DRILL_WRONG_DIR: "1" }, { DRILL_TCP: "1" }]) {
    const s = setupBackup();
    const r = s.drill([], extra);
    assert.equal(r.status, 2, JSON.stringify(extra));
    assert.match(r.stderr, /not connected to the throwaway local instance/);
    assert.ok(!s.log().includes("pg_restore -h"), "nothing restored");
    assert.match(s.log(), /pg_ctl -D \S+ -m immediate -w stop/, "instance stopped on refusal");
    assert.match(s.log(), /alert db-restore-drill failure/);
    assert.ok(!existsSync(join(s.root, "drill")));
  }
});

test("drill fails loudly when a restored table differs, and still stops and deletes the instance", () => {
  const s = setupBackup();
  const r = s.drill([], { DRILL_LEADS: "2" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MISMATCH public\.leads: backup=3 restored=2/);
  assert.match(s.log(), /alert db-restore-drill failure/);
  assert.match(s.log(), /pg_ctl -D \S+ -m immediate -w stop/);
  assert.ok(!existsSync(join(s.root, "drill")));
  assert.ok(!existsSync(join(s.backups, ".restore-drill-last-pass")));
});

test("drill: known harmless restore errors are allowed, unknown categories raise an alert but row counts decide the result", () => {
  let s = setupBackup();
  let r = s.drill([], { DRILL_RESTORE_ERR: 'pg_restore: error: could not execute query: ERROR:  schema "public" already exists' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restore error category \(1x\): schema "X" already exists/);
  assert.match(s.log(), /alert db-restore-drill recovery/);

  s = setupBackup();
  r = s.drill([], { DRILL_RESTORE_ERR: 'pg_restore: error: could not execute query: ERROR:  function "foo" does not exist' });
  assert.equal(r.status, 0, "counts match, so the drill passes");
  assert.match(s.log(), /alert db-restore-drill failure restore drill: all 2 table counts match, but 1 unexpected restore error categories/);
  assert.ok(!s.log().includes("alert db-restore-drill recovery"));
});

test("drill: no backup, checksum mismatch, missing counts file, missing server programs all alert", () => {
  let s = sandbox();
  let r = s.drill([]);
  assert.equal(r.status, 2);
  assert.match(s.log(), /alert db-restore-drill failure .*no backup file found/);

  s = setupBackup();
  const enc = join(s.backups, "newme-prod-20261105T013000Z.dump.enc");
  writeFileSync(enc, Buffer.concat([readFileSync(enc), Buffer.from("tamper")]));
  assert.equal(s.drill([]).status, 1);
  assert.match(s.log(), /alert db-restore-drill failure .*checksum mismatch/);
  assert.ok(!existsSync(join(s.root, "drill")));

  s = setupBackup();
  rmSync(`${join(s.backups, "newme-prod-20261105T013000Z.dump.enc")}.counts.tsv`);
  assert.equal(s.drill([]).status, 2);
  assert.match(s.log(), /alert db-restore-drill failure .*counts\/checksum files missing/);

  s = setupBackup();
  r = s.drill([], { PG_BIN: join(s.root, "nowhere") });
  assert.equal(r.status, 2);
  assert.match(s.log(), /alert db-restore-drill failure .*PostgreSQL 17 server programs not found/);
});

test("drill uses a valid pg_restore command line (checked against the real pg_restore 17 parser)", () => {
  const script = readFileSync(infra("newme-restore-drill.sh"), "utf8");
  assert.ok(!/--exit-on-error/.test(script.replace(/#.*$/gm, "")));
  const real = spawnSync("pg_restore", ["-h", "/tmp/x", "-p", "5439", "-U", "postgres", "-d", "drill", "--no-owner", "--no-privileges", "/nonexistent/x.dump"], { encoding: "utf8" });
  if (real.error?.code !== "ENOENT") {
    assert.doesNotMatch(real.stderr, /unrecognized option|doesn't allow an argument|invalid option|requires an argument/);
    assert.match(real.stderr, /could not open input file/);
  }
});

test("a directory that cannot be removed after the drill is a CRITICAL alert and a failed drill", () => {
  const s = setupBackup();
  const r = s.drill([], { DRILL_RM_FAILS: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CRITICAL: drill directory/);
  assert.match(s.log(), /alert db-restore-drill failure CRITICAL: restore drill directory/);
});

test("the drill no longer knows about staging or any connection URL", () => {
  const script = readFileSync(infra("newme-restore-drill.sh"), "utf8").replace(/#.*$/gm, "");
  assert.ok(!/STAGING|staging-db|service=|PGSERVICEFILE=|write_pg_service|supabase\.co/.test(script));
  assert.ok(!/staging/i.test(readFileSync(infra("newme-restore-drill.service"), "utf8")));
  assert.ok(!/staging/i.test(readFileSync(infra("backup.env.example"), "utf8")));
});

test("connection strings with control characters (raw or percent-encoded) are refused by the backup", () => {
  for (const url of [
    `postgresql://postgres.${PROD_REF}:x%0Ahostaddr=203.0.113.9@aws-0.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${PROD_REF}:x%0Dy@aws-0.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${PROD_REF}:x%00y@aws-0.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${PROD_REF}:pw@aws-0.pooler.supabase.com:5432/postgres?x=%0A`,
    `postgresql://postgres.${PROD_REF}:pw@aws-0.pooler.supabase.com:5432/postgres\nhostaddr=203.0.113.9`,
  ]) {
    const s = sandbox({ dbUrl: url });
    const r = s.backup([]);
    assert.notEqual(r.status, 0, url);
    assert.match(r.stderr, /control characters/);
    assert.ok(!s.log().includes("pg_dump"), "no connection attempted");
    assert.match(s.log(), /alert db-backup failure/);
  }
});

test("freshness: the monthly drill must have passed within 35 days once it is in use", () => {
  const run = (s, extra = {}) => spawnSync("bash", [infra("newme-backup-freshness.sh")], { encoding: "utf8", env: s.env(extra) });
  const s = setupBackup();
  assert.equal(run(s).status, 0, "no stamp and drill not required: not checked");
  const stamp = join(s.backups, ".restore-drill-last-pass");
  assert.equal(run(s, { DRILL_REQUIRED: "1" }).status, 1);
  assert.match(s.log(), /alert db-restore-drill-freshness failure .*no restore drill has passed yet/);
  writeFileSync(stamp, ""); utimesSync(stamp, hoursAgo(24 * 36), hoursAgo(24 * 36));
  assert.equal(run(s).status, 1);
  assert.match(s.log(), /alert db-restore-drill-freshness failure .*36 days old \(limit 35\)/);
  utimesSync(stamp, hoursAgo(24 * 20), hoursAgo(24 * 20));
  assert.equal(run(s).status, 0);
  assert.match(s.log(), /alert db-restore-drill-freshness recovery/);
});
