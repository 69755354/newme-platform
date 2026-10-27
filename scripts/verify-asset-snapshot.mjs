#!/usr/bin/env node
/**
 * Verify that an asset snapshot is a restore point for THIS release's control plane.
 *
 * Round-4 review C1. infra/release/control-plane-bootstrap.md used to tell the
 * operator to take the pre-bootstrap snapshot with the installed helper:
 *
 *     bash /usr/local/libexec/newme/newme-install-systemd-assets snapshot
 *
 * On production that helper is the f37c203 one, and `git show
 * f37c203:scripts/install-systemd-assets.sh` remembers only MANAGED[] plus the three
 * extra paths — it has no CONTROL_PLANE[] at all (that set is what this release
 * added). Snapshot mode still exists there, still validates its record, still
 * prints `snapshot=<dir>`, and still exits 0. So the procedure appeared to work
 * while producing a backup whose managed.list omits every path the bootstrap is
 * about to replace: the wrapper, both libexec helpers, both sbin controllers, the
 * sudoers fragment, and /etc/sudoers.d/ubuntu-nopasswd which the install removes
 * unconditionally.
 *
 * Restoring that snapshot then also succeeds — scripts/rollback-systemd-assets.sh
 * iterates managed.list, so it restores the versioned assets, prints "restored
 * systemd and observability assets from <dir>" and exits 0 — while leaving the
 * candidate control plane installed and ubuntu-nopasswd removed. A silent partial
 * restore reported as a complete one is worse than no restore point, because the
 * operator stops looking.
 *
 * This script is the check that makes the restore point a fact instead of a claim.
 * It is read-only. It mutates nothing, starts nothing, and reads no application
 * data.
 *
 *   node scripts/verify-asset-snapshot.mjs --snapshot /var/backups/newme-systemd-assets/<stamp>.XXXXXX
 *
 * Options:
 *   --snapshot <dir>     required; the directory `snapshot` mode printed
 *   --installer <path>   the installer whose managed set defines "complete"
 *                        (default: scripts/install-systemd-assets.sh beside this file)
 *   --skip-live          compare the snapshot against itself only, for fixtures that
 *                        are not the live host. Never use it on production: the
 *                        point of the live comparison is that the snapshot holds the
 *                        bytes that are running right now.
 *
 * On success it prints counts, per-control-plane-path booleans and the sha256 of
 * managed.list. It never prints file contents and never prints a hash of any
 * managed asset — two of them (/etc/newme/newme-runtime.env,
 * /etc/hermes/observability/hermes-alert-v1.env) are runtime environment files.
 * Their integrity is verified by comparison and reported as a boolean.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

class Refused extends Error {}

function refuse(message) {
  throw new Refused(message);
}

export function parseManagedSet(installerSource) {
  const array = (name) => {
    const match = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)$`, "m").exec(installerSource);
    if (!match) refuse(`the installer has no ${name}[] set`);
    return match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  };
  const loop = /^for p in "\$\{MANAGED\[@\]\}" "\$\{CONTROL_PLANE\[@\]\}"([^\n]*?); do remember "\$p"; done$/m.exec(
    installerSource,
  );
  if (!loop) refuse("the installer does not remember MANAGED[] and CONTROL_PLANE[] in one loop");
  const extras = loop[1].trim().split(/\s+/).filter(Boolean);
  const managed = array("MANAGED");
  const controlPlane = array("CONTROL_PLANE");
  for (const entry of [...managed, ...controlPlane, ...extras]) {
    if (!entry.startsWith("/")) refuse(`the installer's managed set contains a non-absolute path: ${entry}`);
  }
  return { managed, controlPlane, extras, all: [...managed, ...controlPlane, ...extras] };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readLines(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text === "") return [];
  if (!text.endsWith("\n")) refuse(`${file} does not end with a newline`);
  return text.slice(0, -1).split("\n");
}

/** lstat, or null when the path does not exist. Never follows a symlink. */
function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function verifySnapshot({ snapshot, installerSource, compareLive = true, statLive = lstatOrNull, readLive = fs.readFileSync, readLiveLink = fs.readlinkSync }) {
  const expected = parseManagedSet(installerSource);

  const snapshotStat = lstatOrNull(snapshot);
  if (!snapshotStat) refuse(`the snapshot directory does not exist: ${snapshot}`);
  if (!snapshotStat.isDirectory()) refuse(`the snapshot is not a directory: ${snapshot}`);
  if (process.getuid && process.getuid() === 0) {
    if (snapshotStat.uid !== 0 || snapshotStat.gid !== 0) refuse("the snapshot is not owned by root:root");
    if ((snapshotStat.mode & 0o777) !== 0o700) {
      refuse(`the snapshot directory mode is ${(snapshotStat.mode & 0o777).toString(8)}, not 700`);
    }
  }
  for (const artifact of ["managed.list", "present.list", "manifest.sha256", "symlink.sha256"]) {
    const stat = lstatOrNull(path.join(snapshot, artifact));
    if (!stat || !stat.isFile()) refuse(`the snapshot has no ${artifact}`);
  }
  const rootfsStat = lstatOrNull(path.join(snapshot, "rootfs"));
  if (!rootfsStat || !rootfsStat.isDirectory()) refuse("the snapshot has no rootfs directory");

  const managedList = readLines(path.join(snapshot, "managed.list"));
  const presentList = readLines(path.join(snapshot, "present.list"));

  // 1 · The snapshot must have been taken by an installer whose managed set is this
  //     release's. This is the check the f37c203 snapshot fails.
  const missing = expected.all.filter((entry) => !managedList.includes(entry));
  if (missing.length > 0) {
    refuse(
      `the snapshot was taken by an installer that does not manage ${missing.length} of this release's paths, ` +
        `so restoring it would not put them back: ${missing.join(", ")}`,
    );
  }
  const unexpected = managedList.filter((entry) => !expected.all.includes(entry));
  if (unexpected.length > 0) {
    refuse(`the snapshot manages paths this release does not: ${unexpected.join(", ")}`);
  }
  if (managedList.join("\n") !== expected.all.join("\n")) {
    refuse("the snapshot's managed set is this release's, but not in the order the installer records it");
  }
  const missingControlPlane = expected.controlPlane.filter((entry) => !managedList.includes(entry));
  if (missingControlPlane.length > 0) refuse(`unreachable: control plane not covered (${missingControlPlane.join(", ")})`);

  // 2 · present.list must be a subset, and must be exactly the paths that exist.
  for (const entry of presentList) {
    if (!managedList.includes(entry)) refuse(`${entry} is recorded as present but is not managed`);
  }
  if (new Set(presentList).size !== presentList.length) refuse("present.list repeats a path");

  const manifest = new Map();
  for (const line of readLines(path.join(snapshot, "manifest.sha256"))) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) refuse("manifest.sha256 has a line this verifier does not recognise");
    // sha256sum was run inside rootfs, so the path is relative to it.
    if (manifest.has(match[2])) refuse(`manifest.sha256 repeats ${match[2]}`);
    manifest.set(match[2], match[1]);
  }
  const symlinks = new Map();
  for (const line of readLines(path.join(snapshot, "symlink.sha256"))) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) refuse("symlink.sha256 has a line this verifier does not recognise");
    if (symlinks.has(match[2])) refuse(`symlink.sha256 repeats ${match[2]}`);
    symlinks.set(match[2], match[1]);
  }

  let files = 0;
  let links = 0;
  const controlPlanePresent = [];
  for (const entry of presentList) {
    const relative = entry.replace(/^\//, "");
    const copy = path.join(snapshot, "rootfs", relative);
    const copyStat = lstatOrNull(copy);
    if (!copyStat) refuse(`${entry} is recorded as present but has no copy in the snapshot`);

    if (copyStat.isSymbolicLink()) {
      links += 1;
      const target = fs.readlinkSync(copy);
      const digest = sha256(Buffer.from(target, "utf8"));
      if (!symlinks.has(entry)) refuse(`${entry} is a symlink with no symlink.sha256 entry`);
      if (symlinks.get(entry) !== digest) refuse(`the snapshot's copy of the symlink ${entry} does not match its recorded hash`);
      if (compareLive) {
        const liveStat = statLive(entry);
        if (!liveStat) refuse(`${entry} is in the snapshot but is missing on this host, so the snapshot is not of this host`);
        if (!liveStat.isSymbolicLink()) refuse(`${entry} is a symlink in the snapshot and a file on this host`);
        if (readLiveLink(entry) !== target) refuse(`${entry} points somewhere else on this host than in the snapshot`);
      }
    } else if (copyStat.isFile()) {
      files += 1;
      // Relative to rootfs is how this release writes it; `./` is how sha256sum
      // writes a `./x` argument, and the absolute form is what backups taken before
      // the key was made relative contain.
      const key = [relative, `./${relative}`, path.join(snapshot, "rootfs", relative)].find((candidate) =>
        manifest.has(candidate),
      );
      if (!key) refuse(`${entry} is a regular file with no manifest.sha256 entry`);
      const digest = sha256(fs.readFileSync(copy));
      if (manifest.get(key) !== digest) refuse(`the snapshot's copy of ${entry} does not match its recorded hash`);
      if (compareLive) {
        const liveStat = statLive(entry);
        if (!liveStat) refuse(`${entry} is in the snapshot but is missing on this host, so the snapshot is not of this host`);
        if (liveStat.isSymbolicLink()) refuse(`${entry} is a file in the snapshot and a symlink on this host`);
        if (sha256(readLive(entry)) !== digest) {
          refuse(`${entry} on this host is not the byte sequence the snapshot holds, so this is not a restore point for it`);
        }
      }
    } else {
      refuse(`${entry} is neither a regular file nor a symlink in the snapshot`);
    }
    if (expected.controlPlane.includes(entry)) controlPlanePresent.push(entry);
  }

  // 3 · Anything managed and absent must really be absent, or the snapshot cannot
  //     restore the host's actual state (it would leave the file it never captured).
  if (compareLive) {
    for (const entry of managedList) {
      if (presentList.includes(entry)) continue;
      if (statLive(entry)) refuse(`${entry} exists on this host but was not captured, so restoring would leave it in place`);
    }
  }

  // 4 · No hash record may name a path outside the captured set.
  for (const key of manifest.keys()) {
    const absolute = `/${key.replace(/^\.\//, "")}`;
    if (!presentList.includes(absolute)) refuse(`manifest.sha256 names ${absolute}, which is not recorded as present`);
  }
  for (const key of symlinks.keys()) {
    if (!presentList.includes(key)) refuse(`symlink.sha256 names ${key}, which is not recorded as present`);
  }

  return {
    snapshot,
    managed: managedList.length,
    present: presentList.length,
    files,
    links,
    controlPlaneManaged: expected.controlPlane.length,
    controlPlanePresent,
    controlPlaneAbsent: expected.controlPlane.filter((entry) => !controlPlanePresent.includes(entry)),
    managedListSha256: sha256(fs.readFileSync(path.join(snapshot, "managed.list"))),
    comparedAgainstLiveHost: compareLive,
  };
}

function main(argv) {
  let snapshot = "";
  let installer = path.join(HERE, "install-systemd-assets.sh");
  let compareLive = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--snapshot") snapshot = argv[++index] ?? "";
    else if (argument === "--installer") installer = argv[++index] ?? "";
    else if (argument === "--skip-live") compareLive = false;
    else {
      process.stderr.write(`usage: verify-asset-snapshot.mjs --snapshot <dir> [--installer <path>] [--skip-live]\n`);
      return 64;
    }
  }
  if (snapshot === "") {
    process.stderr.write("usage: verify-asset-snapshot.mjs --snapshot <dir> [--installer <path>] [--skip-live]\n");
    return 64;
  }
  let installerSource;
  try {
    installerSource = fs.readFileSync(installer, "utf8");
  } catch {
    process.stderr.write(`the installer whose managed set defines completeness is unreadable: ${installer}\n`);
    return 65;
  }
  try {
    const result = verifySnapshot({ snapshot, installerSource, compareLive });
    process.stdout.write(
      `snapshot verified: ${result.snapshot}\n` +
        `  managed=${result.managed} present=${result.present} files=${result.files} symlinks=${result.links}\n` +
        `  control_plane_managed=${result.controlPlaneManaged} control_plane_captured=${result.controlPlanePresent.length}\n` +
        `${result.controlPlanePresent.map((entry) => `    captured  ${entry}\n`).join("")}` +
        `${result.controlPlaneAbsent.map((entry) => `    absent    ${entry} (managed, not present on this host)\n`).join("")}` +
        `  compared_against_live_host=${result.comparedAgainstLiveHost}\n` +
        `  managed_list_sha256=${result.managedListSha256}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      process.stderr.write(`this snapshot is not a restore point for this release: ${error.message}\n`);
      return 65;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
