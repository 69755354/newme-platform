import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bashPath = (value) => {
  const path = value instanceof URL ? fileURLToPath(value) : String(value);
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
};

const settleScript = bashPath(new URL("../../scripts/wait-for-host-load.sh", import.meta.url));

function runSettle(sequence, { nproc = "2", timeout = "120", interval = "10", required = "2" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "newme-host-load-settle-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const sequenceFile = join(root, "sequence");
  const stateFile = join(root, "state");
  const sleepLog = join(root, "sleep.log");
  writeFileSync(sequenceFile, `${sequence.join("\n")}\n`, "utf8");
  writeFileSync(stateFile, "0\n", "utf8");
  writeFileSync(sleepLog, "", "utf8");

  const reader = join(bin, "read-load");
  writeFileSync(reader, `#!/usr/bin/env bash
index="$(tr -d '\\r\\n' < "$HOST_LOAD_STATE_FILE")"
index=$((index + 1))
value="$(sed -n "\${index}p" "$HOST_LOAD_SEQUENCE_FILE")"
printf '%s\\n' "$index" > "$HOST_LOAD_STATE_FILE"
[ -n "$value" ] || exit 1
printf '%s\\n' "$value"
`, "utf8");
  chmodSync(reader, 0o755);

  const nprocBin = join(bin, "nproc");
  writeFileSync(nprocBin, "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_NPROC\"\n", "utf8");
  chmodSync(nprocBin, 0o755);

  const sleepBin = join(bin, "sleep");
  writeFileSync(sleepBin, "#!/usr/bin/env bash\nprintf '%s\\n' \"$1\" >> \"$HOST_LOAD_SLEEP_LOG\"\n", "utf8");
  chmodSync(sleepBin, 0o755);

  const result = spawnSync("bash", [settleScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOST_LOAD_READER: bashPath(reader),
      HOST_LOAD_NPROC_BIN: bashPath(nprocBin),
      HOST_LOAD_AWK_BIN: "/usr/bin/awk",
      HOST_LOAD_SLEEP_BIN: bashPath(sleepBin),
      HOST_LOAD_SETTLE_INTERVAL_SECONDS: interval,
      HOST_LOAD_SETTLE_TIMEOUT_SECONDS: timeout,
      HOST_LOAD_SETTLE_REQUIRED_SAMPLES: required,
      HOST_LOAD_SETTLE_THRESHOLD_PCT: "90",
      HOST_LOAD_SEQUENCE_FILE: bashPath(sequenceFile),
      HOST_LOAD_STATE_FILE: bashPath(stateFile),
      HOST_LOAD_SLEEP_LOG: bashPath(sleepLog),
      FAKE_NPROC: nproc,
    },
  });

  return {
    result,
    samples: Number(readFileSync(stateFile, "utf8").trim()),
    sleeps: readFileSync(sleepLog, "utf8").trim().split(/\r?\n/).filter(Boolean),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("host load settle waits for two consecutive samples at or below 90 percent", () => {
  const run = runSettle(["2.13", "1.95", "1.70", "1.60"]);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.samples, 4);
    assert.deepEqual(run.sleeps, ["10", "10", "10"]);
    assert.match(run.result.stdout, /load=2\.13 normalized=106%/);
    assert.match(run.result.stdout, /host load settled before release switch/);
  } finally {
    run.cleanup();
  }
});

test("host load settle accepts exactly 90 percent but resets after a high sample", () => {
  const run = runSettle(["1.80", "2.00", "1.80", "1.70"]);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.samples, 4);
    assert.match(run.result.stdout, /load=1\.80 normalized=90% consecutive=1\/2/);
    assert.match(run.result.stdout, /load=2\.00 normalized=100% consecutive=0\/2/);
  } finally {
    run.cleanup();
  }
});

test("host load settle fails closed after its bounded sample budget", () => {
  const run = runSettle(["2.13", "2.13", "2.13"], { timeout: "30" });
  try {
    assert.equal(run.result.status, 1);
    assert.equal(run.samples, 3);
    assert.deepEqual(run.sleeps, ["10", "10"]);
    assert.match(run.result.stderr, /remained above 90% within 30s/);
  } finally {
    run.cleanup();
  }
});

test("host load settle rejects malformed load and invalid core count", () => {
  const malformed = runSettle(["not-a-number"]);
  try {
    assert.equal(malformed.result.status, 1);
    assert.equal(malformed.samples, 1);
    assert.match(malformed.result.stderr, /loadavg result is invalid/);
  } finally {
    malformed.cleanup();
  }

  const noCores = runSettle(["0.10"], { nproc: "0" });
  try {
    assert.equal(noCores.result.status, 1);
    assert.equal(noCores.samples, 0);
    assert.match(noCores.result.stderr, /nproc result is invalid/);
  } finally {
    noCores.cleanup();
  }
});
