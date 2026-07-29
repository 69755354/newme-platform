import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_REF,
  READINESS_TIMEOUT_MS,
  STAGING_REF,
  parseEnvironmentFile,
  runSam68StagingUat,
} from "../../scripts/verify-staging-sam68-observability.mjs";

const releaseSha = "a".repeat(40);
const releaseRoot = `/opt/newme-staging/releases/${releaseSha}`;
const readinessToken = "test-readiness-token";
const marker = "sam68-hostilemarker";

function errorWithCode(code) {
  return Object.assign(new Error(`command exited ${code}`), { code });
}

function createDependencies({
  diskMarkerFound = false,
  journalText = "",
  sentryDsn = "",
  readinessCacheControl = "no-store, max-age=0",
} = {}) {
  const calls = [];
  const environmentFile = [
    `NEWME_STAGING_PROJECT_REF=${STAGING_REF}`,
    `NEXT_PUBLIC_SUPABASE_URL=https://${STAGING_REF}.supabase.co`,
    `NEWME_READINESS_TOKEN=${readinessToken}`,
    `SENTRY_DSN=${sentryDsn}`,
    "NEXT_PUBLIC_SENTRY_DSN=",
  ].join("\n");
  const monotonicValues = [100, 225];

  return {
    calls,
    environment: { SAM68_EXPECTED_RELEASE_SHA: releaseSha },
    markerFactory: () => marker,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    monotonicNow: () => monotonicValues.shift(),
    realpath: async (path) => {
      assert.equal(path, "/opt/newme-staging/current");
      return releaseRoot;
    },
    readFile: async (path) => {
      if (path === `${releaseRoot}/manifest.json`) {
        return JSON.stringify({ git_sha: releaseSha });
      }
      if (path === "/etc/newme-staging/staging.env") return environmentFile;
      assert.fail(`unexpected read: ${path}`);
    },
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args.includes("--property=MainPID")) {
        return { stdout: "4242\n", stderr: "" };
      }
      if (command === "systemctl" && args.includes("--property=PrivateTmp")) {
        return { stdout: "yes\n", stderr: "" };
      }
      if (command === "nsenter") {
        assert.deepEqual(args, [
          "-t",
          "4242",
          "-m",
          "--",
          "grep",
          "-R",
          "-F",
          "-l",
          "--",
          marker,
          "/tmp",
        ]);
        if (!diskMarkerFound) throw errorWithCode(1);
        return { stdout: "/tmp/hostile-body.json\n", stderr: "" };
      }
      if (command === "journalctl") {
        assert.deepEqual(args, [
          "--unit",
          "newme-staging.service",
          "--since",
          "2026-07-30T00:00:00.000Z",
          "--no-pager",
          "--output=cat",
        ]);
        return { stdout: journalText, stderr: "" };
      }
      assert.fail(`unexpected command: ${command} ${args.join(" ")}`);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.signal instanceof AbortSignal, true);
      if (url.endsWith("/api/monitoring/report")) {
        assert.equal(init.method, "POST");
        assert.equal(init.cache, "no-store");
        assert.match(init.body, new RegExp(marker));
        return new Response(
          JSON.stringify({ error: "Monitoring endpoint retired" }),
          {
            status: 410,
            headers: { "cache-control": "no-store, max-age=0" },
          },
        );
      }
      if (url.endsWith("/api/ready")) {
        assert.equal(init.method, "GET");
        assert.equal(init.headers["x-newme-readiness-token"], readinessToken);
        return Response.json(
          { status: "ready" },
          {
            status: 200,
            headers: { "cache-control": readinessCacheControl },
          },
        );
      }
      assert.fail(`unexpected fetch: ${url}`);
    },
  };
}

test("SAM-68 runner emits SHA-bound, secret-free, auditable staging evidence", async () => {
  const dependencies = createDependencies({
    journalText: "staging request completed\n",
  });
  const evidence = await runSam68StagingUat(dependencies);

  assert.equal(READINESS_TIMEOUT_MS, 3_000);
  assert.equal(evidence.releaseSha, releaseSha);
  assert.deepEqual(evidence.monitoring, {
    status: "passed",
    httpStatus: 410,
    cacheControl: "no-store, max-age=0",
    hostileBodyPersisted: false,
  });
  assert.deepEqual(evidence.readiness, {
    status: "passed",
    httpStatus: 200,
    cacheControl: "no-store, max-age=0",
    timeoutMs: 3_000,
    elapsedMs: 125,
  });
  assert.deepEqual(evidence.observability, {
    journald: {
      status: "observed",
      unit: "newme-staging.service",
      entries: 1,
      hostileMarkerMatches: 0,
      errorMatches: 0,
    },
    sentry: {
      status: "not_applicable",
      reason: "staging_sentry_disabled_by_isolation_contract",
    },
  });
  assert.deepEqual(evidence.cleanup, {
    status: "not_applicable",
    reason: "read_only_http_and_journal_observation",
    fixtureIds: [],
  });

  const serialized = JSON.stringify(evidence);
  for (const forbidden of [readinessToken, marker, "hostile-token", PRODUCTION_REF]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("SAM-68 runner fails closed if the hostile marker reaches disk or journald", async () => {
  await assert.rejects(
    runSam68StagingUat(createDependencies({ diskMarkerFound: true })),
    /hostile_body_persisted/,
  );
  await assert.rejects(
    runSam68StagingUat(createDependencies({ journalText: `${marker}\n` })),
    /hostile_body_reached_journald/,
  );
});

test("SAM-68 runner requires exact no-store readiness within the fixed boundary", async () => {
  await assert.rejects(
    runSam68StagingUat(
      createDependencies({ readinessCacheControl: "no-cache" }),
    ),
    /authenticated_readiness_failed/,
  );
});

test("SAM-68 runner accepts Sentry N/A only when staging Sentry is disabled", async () => {
  await assert.rejects(
    runSam68StagingUat(
      createDependencies({ sentryDsn: "https://public@example.invalid/1" }),
    ),
    /staging_sentry_must_be_disabled/,
  );
});

test("SAM-68 environment parser does not expand or execute values", () => {
  assert.deepEqual(
    parseEnvironmentFile("A='literal value'\nB=$(do-not-run)\n# ignored\n"),
    { A: "literal value", B: "$(do-not-run)" },
  );
});
