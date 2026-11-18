// S17 B-2: backups live outside /root so the sandbox (ProtectHome=true) cannot hide them, the NAS
// pulls them through a read-only forced command, and a missing pull raises an alert.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const BACKUP_DIR = "/var/backups/newme-db";
const PULL_DIR = "/var/backups/newme-db-pull";
const units = ["newme-db-backup.service", "newme-backup-freshness.service", "newme-restore-drill.service"];

test("nothing in the backup tooling points at /root or the old claude-ops-backups directory", () => {
  for (const f of readdirSync(join(root, "infra/backup"))) {
    assert.ok(!/claude-ops-backups|\/root\b/.test(read(`infra/backup/${f}`).replace(/#.*$/gm, "")), `${f} still references /root`);
  }
});

test("the default backup directory is /var/backups/newme-db everywhere and every unit may write exactly there", () => {
  assert.match(read("infra/backup/backup.env.example"), new RegExp(`^BACKUP_DIR=${BACKUP_DIR}$`, "m"));
  for (const f of ["newme-db-backup.sh", "newme-backup-freshness.sh", "newme-restore-drill.sh"]) {
    assert.ok(read(`infra/backup/${f}`).includes(`BACKUP_DIR="\${BACKUP_DIR:-${BACKUP_DIR}}"`), `${f} default`);
  }
  for (const u of units) {
    const text = read(`infra/backup/${u}`);
    assert.match(text, /^ProtectHome=true$/m, `${u} keeps ProtectHome`);
    const rw = [...text.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1].split(/\s+/)).map((p) => p.replace(/^-/, ""));
    assert.ok(rw.includes(BACKUP_DIR), `${u} can write ${BACKUP_DIR}`);
    for (const p of rw) assert.ok(!/^\/(home|root|run\/user)(\/|$)/.test(p), `${u}: ${p} is hidden by ProtectHome`);
  }
  assert.match(read("infra/backup/newme-db-backup.service"), /^ProtectSystem=strict$/m);
});

test("alerts from the backup tooling go through the WhatsApp sender by default", () => {
  for (const f of ["newme-db-backup.sh", "newme-backup-freshness.sh", "newme-restore-drill.sh", "newme-backup-onfailure.sh"]) {
    assert.ok(read(`infra/backup/${f}`).includes("/usr/local/libexec/newme/newme-whatsapp-alert.sh"), f);
    assert.ok(!read(`infra/backup/${f}`).includes("hermes-alert-state-v1"), `${f} no longer defaults to the Telegram state machine`);
  }
});

// ---- harness for the scripts -------------------------------------------------------------------------
function box() {
  const dir = mkdtempSync(join(tmpdir(), "newme-s17-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "calls.log");
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("alert.sh", `echo "alert $1 $2 $3" >> "${log}"`);
  stub("rsync", `echo "rsync $*" >> "${log}"; exit 0`);
  return { dir, bin, log, stub, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

// ---- NAS pull: forced command ------------------------------------------------------------------------
const wrapper = join(root, "infra/backup/newme-nas-rsync-ro.sh");
function pull(original, extra = {}) {
  const b = box();
  const state = join(b.dir, "state");
  const r = spawnSync("sh", [wrapper], {
    encoding: "utf8",
    env: { PATH: `${b.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: original, NAS_PULL_DIR: PULL_DIR, NAS_PULL_STATE: state, RSYNC_BIN: join(b.bin, "rsync"), ...extra },
  });
  return { ...r, b, state };
}

test("NAS pull: the rsync command a NAS sends for a read-only pull is allowed and stamps success", () => {
  const r = pull(`rsync --server --sender -vlogDtpre.iLsfxCIvu --numeric-ids --timeout=120 . ${PULL_DIR}/`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.b.calls(), new RegExp(`rsync --server --sender -vlogDtpre.iLsfxCIvu --numeric-ids --timeout=120 \\. ${PULL_DIR}/`));
  assert.ok(existsSync(join(r.state, "last-pull-ok")), "a finished pull is recorded");
  assert.match(readFileSync(join(r.state, "last-pull-ok"), "utf8"), /^\d{10}$/m);
});

test("NAS pull: a failed rsync does not stamp success", () => {
  const b = box();
  b.stub("rsync", "exit 23");
  const state = join(b.dir, "state");
  const r = spawnSync("sh", [wrapper], { encoding: "utf8", env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/`, NAS_PULL_DIR: PULL_DIR, NAS_PULL_STATE: state, RSYNC_BIN: join(b.bin, "rsync") } });
  assert.equal(r.status, 23);
  assert.ok(!existsSync(join(state, "last-pull-ok")));
});

test("NAS pull: everything that is not a read-only pull of the backup directory is refused", () => {
  const bad = [
    "", "bash", "bash -c id", "sh", "scp -f /etc/passwd", "cat /etc/shadow",
    `rsync --server -logDtpre.iLsfxC . ${PULL_DIR}/`,                       // receiver mode = upload
    `rsync --server --sender -logDtpre.iLsfxC . /etc/`,                     // other directory
    `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/../../etc`,     // traversal
    `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/; id`,
    `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/ $(id)`,
    `rsync --server --sender -logDtpre.iLsfxC --remove-source-files . ${PULL_DIR}/`,
    `rsync --server --sender -logDtpre.iLsfxC --rsync-path=/bin/sh . ${PULL_DIR}/`,
    `rsync --server --sender -logDtpre.iLsfxC --delete . ${PULL_DIR}/`,
    `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/ extra`,
    `rsync --server --sender -logDtpre.iLsfxC .`,
    `rsync --server --sender -e'sh -c id' . ${PULL_DIR}/`,
    `rsync --server --sender -slogDtpre.iLsfxCIvu . ${PULL_DIR}/`,          // -s: real path is read from the stream
    `rsync --server --sender -logDtprse.iLsfxC . ${PULL_DIR}/`,
    `rsync --server --sender -se.iLsfxC . ${PULL_DIR}/`,
    `rsync --server --sender -M--delete . ${PULL_DIR}/`,
    `rsync --server --sender -M--files-from=/x -logDtpre.iLsfxC . ${PULL_DIR}/`,
    `rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/\nid`,
  ];
  for (const cmd of bad) {
    const r = pull(cmd);
    assert.notEqual(r.status, 0, JSON.stringify(cmd));
    assert.ok(!/rsync --server/.test(r.b.calls()), `never ran rsync for ${JSON.stringify(cmd)}`);
    assert.ok(!existsSync(join(r.state, "last-pull-ok")));
  }
});

test("NAS pull: the -s cluster check does not reject the protocol flags after e.", () => {
  // after "e." rsync's own capability letters follow (they contain s); only the part before is options.
  assert.equal(pull(`rsync --server --sender -vlogDtpre.iLsfxCIvu . ${PULL_DIR}/`).status, 0);
});

test("NAS pull end to end with real rsync: normal pull works, a forged -s request cannot read outside the directory", () => {
  if (spawnSync("rsync", ["--version"]).status !== 0) return;
  const b = box();
  const pullDir = join(b.dir, "pull"); mkdirSync(pullDir);
  const outside = join(b.dir, "outside"); mkdirSync(outside);
  writeFileSync(join(pullDir, "newme-prod-1.dump.enc"), "ENCRYPTED");
  writeFileSync(join(outside, "leak.txt"), "OUTSIDE-SECRET");
  const state = join(b.dir, "state");
  const common = `NAS_PULL_DIR="${pullDir}" NAS_PULL_STATE="${state}" RSYNC_BIN="$(command -v rsync)"`;
  // fake ssh: <host> <command words...>; hands the command to the forced command like sshd does
  const honest = join(b.dir, "ssh-honest"); writeFileSync(honest, `#!/bin/sh\nshift\nexport ${common.replace(/ /g, " export ")}\nSSH_ORIGINAL_COMMAND="$*" exec sh "${wrapper}"\n`); chmodSync(honest, 0o755);
  // attacker: takes the client's own "-s" command line (which carries no path) and appends the allowed directory
  const forged = join(b.dir, "ssh-forged"); writeFileSync(forged, `#!/bin/sh\nshift\nexport ${common.replace(/ /g, " export ")}\nSSH_ORIGINAL_COMMAND="$* . ${pullDir}/" exec sh "${wrapper}"\n`); chmodSync(forged, 0o755);
  const ok = join(b.dir, "dest-ok"); mkdirSync(ok);
  const r1 = spawnSync("rsync", ["-a", "-e", honest, `nas:${pullDir}/`, `${ok}/`], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readFileSync(join(ok, "newme-prod-1.dump.enc"), "utf8"), "ENCRYPTED");
  assert.ok(existsSync(join(state, "last-pull-ok")));
  const bad = join(b.dir, "dest-bad"); mkdirSync(bad);
  const r2 = spawnSync("rsync", ["-s", "-a", "-e", forged, `nas:${outside}/leak.txt`, `${bad}/`], { encoding: "utf8" });
  assert.ok(!existsSync(join(bad, "leak.txt")), "nothing outside the pull directory is readable");
});

test("NAS pull: a sub-path inside the pull directory is fine", () => {
  assert.equal(pull(`rsync --server --sender -logDtpre.iLsfxC . ${PULL_DIR}/sub/file.enc`).status, 0);
});

// ---- NAS pull: account setup ------------------------------------------------------------------------
const setup = join(root, "infra/backup/newme-nas-pull-setup.sh");
test("NAS pull setup: the authorized_keys line is restricted to the forced command and the NAS address", () => {
  const dir = mkdtempSync(join(tmpdir(), "newme-key-"));
  const keyPath = join(dir, "nas");
  if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "nas-test", "-f", keyPath]).status !== 0) return;
  const r = spawnSync("sh", [setup, "--print-authorized-keys-line", "--pubkey-file", `${keyPath}.pub`, "--from", "203.0.113.7"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim();
  assert.match(line, /^restrict,from="203\.0\.113\.7",command="\/usr\/local\/libexec\/newme\/newme-nas-rsync-ro\.sh" ssh-ed25519 \S+ nas-test$/);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("NAS pull setup: private keys, option-carrying keys, multi-line files and bad --from values are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "newme-key-"));
  const keyPath = join(dir, "nas");
  if (spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]).status !== 0) return;
  const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
  const tryKey = (content, from = "203.0.113.7") => {
    const f = join(dir, `k${Math.random()}`); writeFileSync(f, content);
    return spawnSync("sh", [setup, "--print-authorized-keys-line", "--pubkey-file", f, "--from", from], { encoding: "utf8" });
  };
  assert.notEqual(tryKey(readFileSync(keyPath, "utf8")).status, 0, "private key");
  assert.notEqual(tryKey(`command="id" ${pub}\n`).status, 0, "key with its own options");
  assert.notEqual(tryKey(`${pub}\n${pub}\n`).status, 0, "two keys");
  assert.notEqual(tryKey(`${pub}\n`, 'x",command="id').status, 0, "quote injection through --from");
  assert.notEqual(tryKey(`${pub}\n`, "").status, 0, "an address is required");
});

test("NAS pull setup and wrapper pass shellcheck when it is installed", () => {
  if (spawnSync("shellcheck", ["--version"]).status !== 0) return;
  for (const f of [wrapper, setup]) {
    const r = spawnSync("shellcheck", ["-s", "sh", f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
  }
});

// ---- backup keeps a pull copy ------------------------------------------------------------------------
test("the unit that creates backups also lists the pull directory and the alert state directory as writable", () => {
  const text = read("infra/backup/newme-db-backup.service");
  assert.match(text, new RegExp(`ReadWritePaths=${BACKUP_DIR}(\\s|$)`));
  assert.ok(text.includes(`-${PULL_DIR}`));
  assert.ok(text.includes("-/var/lib/newme-alerts"));
});

// ---- freshness: NAS pull -----------------------------------------------------------------------------
function freshness(extra, { localAgeH = 1, pullAgeH = null } = {}) {
  const b = box();
  const backups = join(b.dir, "backups"); mkdirSync(backups, { mode: 0o700 });
  const enc = join(backups, "newme-prod-20261117T000000Z.dump.enc");
  writeFileSync(enc, "x"); writeFileSync(`${enc}.sha256`, "x");
  const t = (Date.now() - localAgeH * 3_600_000) / 1000; utimesSync(enc, t, t);
  const state = join(b.dir, "nas-state"); mkdirSync(state);
  if (pullAgeH !== null) { const f = join(state, "last-pull-ok"); writeFileSync(f, "1"); const p = (Date.now() - pullAgeH * 3_600_000) / 1000; utimesSync(f, p, p); }
  const r = spawnSync("bash", [join(root, "infra/backup/newme-backup-freshness.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BACKUP_ENV_FILE: join(b.dir, "none.env"), BACKUP_DIR: backups, BACKUP_ALERT_SCRIPT: join(b.bin, "alert.sh"), NAS_PULL_STATE_DIR: state, ...extra },
  });
  return { ...r, b };
}

test("freshness: the recovery message waits for every fatal check; a stale drill keeps the failure open", () => {
  const ok = freshness({ NAS_PULL_REQUIRED: "1" }, { pullAgeH: 40 });
  assert.equal(ok.status, 0);
  assert.ok(ok.b.calls().includes("alert db-backup-freshness recovery"), "recovery after all checks passed");
  assert.equal((ok.b.calls().match(/failure/g) ?? []).length, 1, "only the NAS failure message");
  const stale = freshness({ DRILL_REQUIRED: "1" }, { pullAgeH: null });
  assert.equal(stale.status, 1, "no drill has passed: the unit fails");
  assert.ok(!stale.b.calls().includes("alert db-backup-freshness recovery"), "no recovery while the unit is failing");
});

test("freshness: NAS pull is not checked until NAS_PULL_REQUIRED=1", () => {
  const r = freshness({}, { pullAgeH: null });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/nas-pull/.test(r.b.calls()));
});

test("freshness: a NAS that has not pulled for longer than the limit raises an alert; a recent pull is fine", () => {
  const stale = freshness({ NAS_PULL_REQUIRED: "1" }, { pullAgeH: 40 });
  assert.equal(stale.status, 0, "one alert under its own key; no OnFailure second alert with another key");
  assert.match(stale.b.calls(), /alert nas-pull-freshness failure .*NAS.*40 hours/);
  const never = freshness({ NAS_PULL_REQUIRED: "1" }, { pullAgeH: null });
  assert.equal(never.status, 0);
  assert.match(never.b.calls(), /alert nas-pull-freshness failure .*never/);
  const ok = freshness({ NAS_PULL_REQUIRED: "1" }, { pullAgeH: 5 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.b.calls(), /alert nas-pull-freshness recovery/);
  const custom = freshness({ NAS_PULL_REQUIRED: "1", NAS_PULL_MAX_AGE_HOURS: "48" }, { pullAgeH: 40 });
  assert.equal(custom.status, 0, custom.stderr);
});

// ---- backup run: pull export ------------------------------------------------------------------------
test("pull export directory gets a 0640 copy of the newest backups and nothing the local retention removed", () => {
  // Reuse the S7 sandbox from db-backup.test.mjs through a tiny inline version of it.
  const b = box();
  const calls = b.log;
  b.stub("pg_dump", `out=""; for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done; head -c 200000 /dev/zero | tr '\\0' 'x' > "$out"`);
  b.stub("pg_restore", `case "$*" in *--list*) exit 0;; *--data-only*) printf 'COPY public.leads (id) FROM stdin;\\n1\\n\\\\.\\n'; exit 0;; esac; exit 0`);
  const key = join(b.dir, "key"); writeFileSync(key, "k".repeat(48), { mode: 0o600 });
  const url = join(b.dir, "db.url"); writeFileSync(url, "postgresql://postgres.abc:pw@h.example:5432/postgres", { mode: 0o600 });
  const backups = join(b.dir, "backups"), pullDir = join(b.dir, "pull"); mkdirSync(pullDir, { mode: 0o750 });
  // A leftover in the pull dir that the main directory no longer has must be removed.
  writeFileSync(join(pullDir, "newme-prod-20250101T000000Z.dump.enc"), "old");
  const r = spawnSync("bash", [join(root, "infra/backup/newme-db-backup.sh")], {
    encoding: "utf8",
    env: { PATH: `${b.bin}:${process.env.PATH}`, BACKUP_ENV_FILE: join(b.dir, "none.env"), NEWME_DB_URL_FILE: url, BACKUP_KEY_FILE: key, BACKUP_DIR: backups, BACKUP_ALERT_SCRIPT: join(b.bin, "alert.sh"), PULL_EXPORT_DIR: pullDir, PULL_EXPORT_GROUP: "", BACKUP_STAMP: "20261117T010000Z", HOME: b.dir, TMPDIR: b.dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(pullDir).sort();
  assert.deepEqual(names, ["newme-prod-20261117T010000Z.dump.enc", "newme-prod-20261117T010000Z.dump.enc.counts.tsv", "newme-prod-20261117T010000Z.dump.enc.sha256"]);
  for (const n of names) assert.equal(statSync(join(pullDir, n)).mode & 0o777, 0o640, n);
  assert.equal(statSync(backups).mode & 0o777, 0o700, "the main directory stays private");
  assert.ok(calls);
});

test("the pull copy is written through a staging area and moved in, never written into the pull directory directly", () => {
  const b = box();
  b.stub("pg_dump", `out=""; for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done; head -c 200000 /dev/zero | tr '\\0' 'x' > "$out"`);
  b.stub("pg_restore", `case "$*" in *--list*) exit 0;; *--data-only*) printf 'COPY public.leads (id) FROM stdin;\\n1\\n\\\\.\\n'; exit 0;; esac; exit 0`);
  const realInstall = spawnSync("sh", ["-c", "command -v install"], { encoding: "utf8" }).stdout.trim();
  b.stub("install", `echo "$*" >> "${b.dir}/install.log"; exec ${realInstall} "$@"`);
  const key = join(b.dir, "key"); writeFileSync(key, "k".repeat(48), { mode: 0o600 });
  const url = join(b.dir, "db.url"); writeFileSync(url, "postgresql://postgres.abc:pw@h.example:5432/postgres", { mode: 0o600 });
  const pullDir = join(b.dir, "pull"); mkdirSync(pullDir, { mode: 0o750 });
  const r = spawnSync("bash", [join(root, "infra/backup/newme-db-backup.sh")], {
    encoding: "utf8",
    env: { PATH: `${b.bin}:${process.env.PATH}`, BACKUP_ENV_FILE: join(b.dir, "none.env"), NEWME_DB_URL_FILE: url, BACKUP_KEY_FILE: key, BACKUP_DIR: join(b.dir, "backups"), BACKUP_ALERT_SCRIPT: join(b.bin, "alert.sh"), PULL_EXPORT_DIR: pullDir, PULL_EXPORT_GROUP: "", BACKUP_STAMP: "20261117T010000Z", HOME: b.dir, TMPDIR: b.dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const installs = readFileSync(join(b.dir, "install.log"), "utf8");
  assert.ok(!installs.includes(`${pullDir}/`), "install never targets the pull directory itself");
  assert.equal(readdirSync(pullDir).length, 3);
  assert.deepEqual(readdirSync(join(b.dir, "backups")).filter((n) => n.startsWith(".pull-stage")), [], "staging area removed");
  assert.ok(!readdirSync(pullDir).some((n) => n.startsWith(".")), "no hidden temp names inside the pull directory");
});

test("without a pull directory the backup behaves as before", () => {
  const b = box();
  b.stub("pg_dump", `out=""; for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}";; esac; done; head -c 200000 /dev/zero | tr '\\0' 'x' > "$out"`);
  b.stub("pg_restore", `case "$*" in *--list*) exit 0;; *--data-only*) printf 'COPY public.leads (id) FROM stdin;\\n1\\n\\\\.\\n'; exit 0;; esac; exit 0`);
  const key = join(b.dir, "key"); writeFileSync(key, "k".repeat(48), { mode: 0o600 });
  const url = join(b.dir, "db.url"); writeFileSync(url, "postgresql://postgres.abc:pw@h.example:5432/postgres", { mode: 0o600 });
  const r = spawnSync("bash", [join(root, "infra/backup/newme-db-backup.sh")], {
    encoding: "utf8",
    env: { PATH: `${b.bin}:${process.env.PATH}`, BACKUP_ENV_FILE: join(b.dir, "none.env"), NEWME_DB_URL_FILE: url, BACKUP_KEY_FILE: key, BACKUP_DIR: join(b.dir, "backups"), BACKUP_ALERT_SCRIPT: join(b.bin, "alert.sh"), PULL_EXPORT_DIR: join(b.dir, "absent"), HOME: b.dir, TMPDIR: b.dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(b.dir, "absent")));
});
