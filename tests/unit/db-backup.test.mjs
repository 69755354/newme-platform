// S7 item 7: daily encrypted backup + monthly restore drill. Every database tool is
// replaced by a stub on PATH, so these tests exercise the real scripts (permission
// gates, encryption, retention, NAS sync, drill safety gates) without any database.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  stub("pg_restore", `case "$*" in
  *--list*) exit 0;;
  *--data-only*) printf 'COPY public.leads (id) FROM stdin;\\n1\\n2\\n3\\n\\\\.\\nCOPY public.profiles (id) FROM stdin;\\n1\\n\\\\.\\n'; exit 0;;
  *) printf 'pg_restore %s\\n' "$*" >> "${calls}"; exit 0;;
esac`);
  stub("psql", `printf 'psql %s\\n' "$*" >> "${calls}"
case "$*" in
  *"count(*) from public.leads"*) echo \${DRILL_LEADS:-3};;
  *"count(*) from public.profiles"*) echo 1;;
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
  assert.match(r.stderr, /does not mention the staging project/);
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
