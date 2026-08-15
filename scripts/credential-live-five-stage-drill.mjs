#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  process.stderr.write("credential_live_five_stage_drill_requires_linux_root\n");
  process.exit(1);
}

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installedLiveHelper = "/usr/local/libexec/newme/newme-credential-live-attestation.mjs";
const installedTransitionHelper = "/usr/local/libexec/newme/newme-credential-transition.mjs";
const installedPolicy = "/usr/local/share/newme/credential-live-attestation-policy-v1.json";
const stateRoot = "/var/lib/newme/deploy-state";
const runtimePath = "/etc/newme/newme-runtime.env";
const protectionPath = `${stateRoot}/credential-remediation.protected.json`;
const invocationPath = "/run/newme-five-stage-invocation";
const candidateSha = "a".repeat(40);
const closureSha = "b".repeat(40);
const remediationRun = "123456";
const closureRun = "654321";
const remediationAttempt = 2;
const closureAttempt = 1;
const preInvocation = "drill-pre-cutover-invocation";
const rebootedPreInvocation = "drill-pre-cutover-after-reboot";
const proofInvocation = "drill-post-cutover-proof";
const completionInvocation = "drill-post-cutover-completion";
const readbackInvocation = "drill-post-cutover-readback";
const requestedDrillMode = process.env.NEWME_CREDENTIAL_LIVE_DRILL_MODE;
const drillMode = requestedDrillMode === undefined ? ["happy"].join("") : requestedDrillMode;
if (!["happy", "expire-prepared"].includes(drillMode)) {
  throw new Error("credential_live_five_stage_drill_mode_invalid");
}

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const ensureDirectory = (directory, mode = 0o755) => {
  mkdirSync(directory, { recursive: true, mode });
  chmodSync(directory, mode);
  chownSync(directory, 0, 0);
};
const writeRootFile = (file, bytes, mode) => {
  if (!existsSync(path.dirname(file))) ensureDirectory(path.dirname(file), 0o755);
  writeFileSync(file, bytes, { mode });
  chmodSync(file, mode);
  chownSync(file, 0, 0);
};
const iso = (milliseconds) => new Date(milliseconds).toISOString().replace(".000Z", "Z");
const secret = (label) => Buffer.from(`drill-${label}-${randomBytes(24).toString("hex")}`, "utf8");

ensureDirectory("/run/lock", 0o755);
ensureDirectory(stateRoot, 0o700);
ensureDirectory("/run/newme-credential-live-input", 0o700);
ensureDirectory("/run/newme-credential-inbox", 0o700);
ensureDirectory("/etc/newme", 0o700);
ensureDirectory("/opt/newme/current", 0o755);
ensureDirectory("/opt/newme/repository.git", 0o700);
ensureDirectory(path.dirname(installedLiveHelper), 0o755);
ensureDirectory(path.dirname(installedPolicy), 0o755);

copyFileSync(path.join(repository, "scripts", "credential-live-attestation.mjs"), installedLiveHelper);
chmodSync(installedLiveHelper, 0o755);
chownSync(installedLiveHelper, 0, 0);
copyFileSync(path.join(repository, "scripts", "credential-transition.mjs"), installedTransitionHelper);
chmodSync(installedTransitionHelper, 0o755);
chownSync(installedTransitionHelper, 0, 0);
if (process.execPath !== "/usr/bin/node") {
  copyFileSync(process.execPath, "/usr/bin/node");
  chmodSync("/usr/bin/node", 0o755);
  chownSync("/usr/bin/node", 0, 0);
}

writeRootFile("/usr/bin/systemctl", `#!/bin/sh
case "$*" in
  "show newme-platform.service -p InvocationID --value") cat ${invocationPath} ;;
  "show newme-platform.service --property=FragmentPath --property=DropInPaths")
    printf 'FragmentPath=/etc/systemd/system/newme-platform.service\nDropInPaths=\n'
    ;;
  "restart newme-platform.service"|"is-active --quiet newme-platform.service") exit 0 ;;
  *) exit 1 ;;
esac
`, 0o755);
writeRootFile("/usr/bin/git", `#!/bin/sh
case "$*" in
  *"rev-parse ${closureSha}^"*) echo ${candidateSha} ;;
  *"rev-list --count ${candidateSha}..${closureSha}"*) echo 1 ;;
  *"diff --name-only"*) echo TASKBOARD.md ;;
  *"diff-tree"*) echo TASKBOARD.md ;;
  *) exit 1 ;;
esac
`, 0o755);
writeRootFile(invocationPath, `${preInvocation}\n`, 0o600);

const live = await import(`${pathToFileURL(installedLiveHelper).href}?five-stage=${process.pid}`);
const transition = await import(`${pathToFileURL(installedTransitionHelper).href}?five-stage=${process.pid}`);
const keys = generateKeyPairSync("ed25519");
const privateKeyBytes = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyBytes = keys.publicKey.export({ type: "spki", format: "pem" });
const fingerprintKey = randomBytes(32);
const credentials = {
  old_pat: secret("old-pat"),
  management_reader: secret("management-reader"),
  old_service: secret("old-service"),
  replacement_service: Buffer.from(`sb_secret_${randomBytes(32).toString("base64url")}`, "utf8"),
};
const githubReader = secret("github-actions-reader");
const githubSecretScanningReader = secret("github-secret-scanning-reader");

const policy = JSON.parse(readFileSync(
  path.join(repository, "infra", "release", "credential-live-attestation-policy-v1.json"),
  "utf8",
));
policy.credential_identities = {
  old_pat: { provider_object_id: "pat-old-drill-1", scope_id: "account-owner", provider_kind: "pat" },
  management_reader: {
    provider_object_id: "pat-reader-drill-2",
    scope_id: `project-${policy.project_ref}`,
    provider_kind: "pat",
  },
  old_service: {
    provider_object_id: "service-old-drill-1",
    scope_id: `project-${policy.project_ref}`,
    provider_kind: "secret",
  },
  replacement_service: {
    provider_object_id: "service-new-drill-2",
    scope_id: `project-${policy.project_ref}`,
    provider_kind: "secret",
  },
};
policy.receipts.public_key_file_sha256 = live.sha256(publicKeyBytes);
policy.receipts.public_key_spki_sha256 = live.sha256(createPublicKey(publicKeyBytes).export({ type: "spki", format: "der" }));
live.validateCredentialLivePolicy(policy);
writeRootFile(installedPolicy, Buffer.from(`${JSON.stringify(policy, null, 2)}\n`), 0o644);
writeRootFile(policy.receipts.private_key_path, privateKeyBytes, 0o600);
writeRootFile(policy.receipts.public_key_path, publicKeyBytes, 0o600);
writeRootFile(policy.fingerprints.key_path, fingerprintKey, 0o600);
writeRootFile(policy.inputs.management_reader_path, Buffer.concat([credentials.management_reader, Buffer.from("\n")]), 0o600);
writeRootFile(policy.inputs.github_reader_path, Buffer.concat([githubReader, Buffer.from("\n")]), 0o600);
writeRootFile(
  policy.inputs.github_secret_scanning_reader_path,
  Buffer.concat([githubSecretScanningReader, Buffer.from("\n")]),
  0o600,
);
writeRootFile(runtimePath, Buffer.from(`SUPABASE_SERVICE_ROLE_KEY=${credentials.old_service.toString("utf8")}\n`), 0o600);
writeRootFile(policy.inputs.old_pat_path, Buffer.concat([credentials.old_pat, Buffer.from("\n")]), 0o600);
writeRootFile("/opt/newme/current/.env.local", Buffer.from("NEXT_PUBLIC_SUPABASE_URL=https://example.invalid\n"), 0o600);

for (const [assetPath, mode] of Object.entries(live.PROTECTED_CONTROL_PLANE_ASSETS)) {
  if ([installedLiveHelper, installedTransitionHelper, installedPolicy].includes(assetPath)) continue;
  if (assetPath === "/etc/systemd/system/newme-platform.service") {
    copyFileSync(path.join(repository, "infra", "systemd", "newme-platform.service"), assetPath);
    chmodSync(assetPath, mode);
    chownSync(assetPath, 0, 0);
  } else if (assetPath.endsWith("newme-readiness.sh") || assetPath.endsWith("dependency-probe.sh")) {
    writeRootFile(assetPath, Buffer.from("#!/bin/sh\nexit 0\n"), mode);
  } else {
    writeRootFile(assetPath, Buffer.from(`five-stage reviewed bytes for ${assetPath}\n`), mode);
  }
}
const assetBytesByPath = Object.fromEntries(
  Object.keys(live.PROTECTED_CONTROL_PLANE_ASSETS).map((assetPath) => [assetPath, readFileSync(assetPath)]),
);
const marker = {
  version: 2,
  candidate_sha: candidateSha,
  activated_at: iso(Date.now() - 1000),
  assets: Object.fromEntries(
    Object.entries(assetBytesByPath).map(([assetPath, bytes]) => [assetPath, live.sha256(bytes)]),
  ),
};
writeRootFile(protectionPath, Buffer.from(`${JSON.stringify(marker)}\n`), 0o600);

let clockMs = Math.floor(Date.now() / 1000) * 1000;
const now = () => {
  clockMs += 1000;
  return clockMs;
};
let transactionId;
let claim;

let providerRevoked = false;
let alertsResolved = false;
let alertsResolvedAt = null;
let requestCounter = 0;
const response = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    date: new Date(clockMs).toUTCString(),
    "x-request-id": `five-stage-request-${++requestCounter}`,
    ...extraHeaders,
  },
});
const fetchImpl = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers ?? {});
  if (url.pathname.includes("/actions/runs/")) {
    const runId = url.pathname.split("/").at(-1);
    const closure = runId === closureRun;
    return response({
      workflow_id: policy.workflow.id,
      event: policy.workflow.event,
      head_branch: policy.workflow.head_branch,
      id: Number(runId),
      run_attempt: closure ? closureAttempt : remediationAttempt,
      head_sha: closure ? closureSha : candidateSha,
      status: "completed",
      conclusion: "success",
      updated_at: iso(clockMs - 1000),
    });
  }
  if (url.pathname.includes("/actions/workflows/")) {
    return response({ id: policy.workflow.id, path: policy.workflow.path, state: "active" });
  }
  if (url.pathname.includes("/secret-scanning/alerts/")) {
    const number = Number(url.pathname.split("/").at(-1));
    const expected = policy.expected_alerts.find((item) => item.number === number);
    const body = {
      number,
      secret_type: expected.secret_type,
      state: alertsResolved ? "resolved" : "open",
      resolution: alertsResolved ? "revoked" : null,
      resolved_at: alertsResolved ? alertsResolvedAt : null,
      publicly_leaked: true,
    };
    return response(body);
  }
  if (url.pathname.endsWith("/secret-scanning/alerts")) {
    return response(alertsResolved ? [] : [{ number: 1 }, { number: 2 }]);
  }
  if (
    url.pathname === `${policy.provider_keys_path}/${policy.credential_identities.replacement_service.provider_object_id}` &&
    url.searchParams.get("reveal") === "true"
  ) {
    return response({
      id: policy.credential_identities.replacement_service.provider_object_id,
      type: policy.credential_identities.replacement_service.provider_kind,
      api_key: credentials.replacement_service.toString("utf8"),
    });
  }
  if (url.pathname === policy.provider_keys_path) {
    const values = [
      ...(providerRevoked ? [] : [{
        id: policy.credential_identities.old_service.provider_object_id,
        type: "secret",
      }]),
      { id: policy.credential_identities.replacement_service.provider_object_id, type: "secret" },
    ];
    return response(values);
  }
  if (url.origin === policy.supabase_management_origin && url.pathname === policy.management_probe_path) {
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const isOld = token === credentials.old_pat.toString("utf8");
    return response({}, isOld && providerRevoked ? 401 : 200);
  }
  if (url.origin === policy.supabase_data_origin && `${url.pathname}${url.search}` === policy.service_probe_path) {
    const token = headers.get("apikey") ?? "";
    const isOld = token === credentials.old_service.toString("utf8");
    return response({}, isOld && providerRevoked ? 401 : 200);
  }
  throw new Error(`unexpected_fetch_path:${url.origin}${url.pathname}`);
};

let interruptedAfterIntent = false;
try {
  await live.materializeInstalledProviderIdentity({
    candidateSha,
    runId: remediationRun,
    runAttempt: remediationAttempt,
    preCutoverInvocationId: preInvocation,
    fetchImpl,
    now,
    checkpoint: (name) => {
      if (name === "after_intent") throw new Error("simulated_materialization_interrupt_after_intent");
    },
  });
} catch (error) {
  interruptedAfterIntent = error?.message === "simulated_materialization_interrupt_after_intent";
}
check(interruptedAfterIntent, "materializer must expose the durable post-intent recovery checkpoint");
check(!existsSync(policy.state.escrow_directory), "post-intent interruption must not publish an escrow");
clockMs += (policy.precheck_ttl_seconds + 5) * 1000;

let interruptedAfterEscrow = false;
try {
  await live.materializeInstalledProviderIdentity({
    candidateSha,
    runId: remediationRun,
    runAttempt: remediationAttempt,
    preCutoverInvocationId: preInvocation,
    fetchImpl,
    now,
    checkpoint: (name) => {
      if (name === "after_escrow") throw new Error("simulated_materialization_interrupt_after_escrow");
    },
  });
} catch (error) {
  interruptedAfterEscrow = error?.message === "simulated_materialization_interrupt_after_escrow";
}
check(interruptedAfterEscrow, "materializer must expose the durable post-escrow recovery checkpoint");
check(existsSync(policy.state.escrow_directory), "interrupted materialization must preserve the sealed bundle");
check(!existsSync(policy.inputs.claim_path), "interrupted materialization must not publish a partial claim");
check(!existsSync(policy.inputs.provider_identity_receipt_path), "interrupted materialization must not publish a partial receipt");
check(!existsSync(policy.inputs.replacement_service_path), "interrupted materialization must not publish a partial replacement");
clockMs += (policy.precheck_ttl_seconds + 5) * 1000;

const materialized = await live.materializeInstalledProviderIdentity({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  preCutoverInvocationId: preInvocation,
  fetchImpl,
  now,
});
transactionId = materialized.transactionId;
claim = JSON.parse(readFileSync(policy.inputs.claim_path, "utf8"));
check(existsSync(policy.inputs.provider_identity_receipt_path), "materializer must persist the provider-bound receipt");
check(existsSync(policy.inputs.replacement_service_path), "materializer must persist the exact replacement input");
check(existsSync(policy.state.escrow_directory), "materializer must publish the sealed credential bundle");
check(!existsSync(`${stateRoot}/credential-provider-materialization.intent.json`), "materializer must consume its intent after full publication");
const materializedAgain = await live.materializeInstalledProviderIdentity({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  preCutoverInvocationId: preInvocation,
  fetchImpl,
  now,
});
check(materializedAgain.transactionId === transactionId, "materializer reentry must preserve transaction identity");
check(
  materializedAgain.providerIdentityReceiptSha256 === materialized.providerIdentityReceiptSha256,
  "materializer reentry must preserve the signed provider binding",
);

const firstPrepare = await live.prepareInstalledCredentialAttestation({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  preCutoverInvocationId: preInvocation,
  fetchImpl,
  now,
});
check(firstPrepare.transactionId === transactionId, "prepare must bind the precreated claim transaction");
check(existsSync(policy.state.precheck_path), "prepare must persist the signed precheck");
const firstPrecheck = readFileSync(policy.state.precheck_path);

if (drillMode === "expire-prepared") {
  for (const inputPath of [
    policy.inputs.claim_path,
    policy.inputs.provider_identity_receipt_path,
    policy.inputs.old_pat_path,
    policy.inputs.replacement_service_path,
  ]) rmSync(inputPath);
  clockMs = Date.parse(claim.expires_at) + 1000;
  writeRootFile(invocationPath, `${rebootedPreInvocation}\n`, 0o600);
  const expired = live.expirePreparedCredentialAttestation({
    candidateSha,
    runId: remediationRun,
    runAttempt: remediationAttempt,
    preCutoverInvocationId: rebootedPreInvocation,
    now,
  });
  check(expired.transactionId === transactionId, "expired PREPARED cleanup must preserve transaction identity");
  const expiredAgain = live.expirePreparedCredentialAttestation({
    candidateSha,
    runId: remediationRun,
    runAttempt: remediationAttempt,
    preCutoverInvocationId: rebootedPreInvocation,
    now,
  });
  check(expiredAgain.transactionId === transactionId, "expired PREPARED cleanup must be idempotent");
  check(
    JSON.parse(readFileSync(policy.state.journal_path, "utf8")).state === "EXPIRED",
    "expired PREPARED cleanup must leave an explicit terminal journal state",
  );
  check(!existsSync(policy.state.precheck_path), "expired PREPARED cleanup must remove the stale precheck");
  check(!existsSync(policy.state.escrow_directory), "expired PREPARED cleanup must remove sealed credentials");
  check(
    [policy.inputs.claim_path, policy.inputs.provider_identity_receipt_path, policy.inputs.old_pat_path, policy.inputs.replacement_service_path]
      .every((file) => !existsSync(file)),
    "expired PREPARED cleanup must leave no one-use input",
  );
  check(
    readFileSync(runtimePath, "utf8").includes(credentials.old_service.toString("utf8")),
    "expired PREPARED cleanup must preserve the pre-cutover runtime credential",
  );
  check(
    !existsSync(`${stateRoot}/credential-transition.pending.json`) &&
      !existsSync(`${stateRoot}/credential-transition.previous.env`),
    "expired PREPARED cleanup must not create transition rollback state",
  );
  process.stdout.write(`credential_live_expiry_drill_checks=${checks} provider_requests=${requestCounter} failures=0\n`);
  process.exit(0);
}

for (const inputPath of [
  policy.inputs.claim_path,
  policy.inputs.provider_identity_receipt_path,
  policy.inputs.old_pat_path,
  policy.inputs.replacement_service_path,
]) rmSync(inputPath);
writeRootFile(invocationPath, `${rebootedPreInvocation}\n`, 0o600);
const recoveredPrepare = await live.prepareInstalledCredentialAttestation({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  preCutoverInvocationId: rebootedPreInvocation,
  fetchImpl,
  now,
});
check(recoveredPrepare.transactionId === transactionId, "PREPARED reboot recovery must preserve transaction identity");
check(!readFileSync(policy.state.precheck_path).equals(firstPrecheck), "PREPARED reboot recovery must rebind the current service invocation");
check(
  [policy.inputs.claim_path, policy.inputs.provider_identity_receipt_path, policy.inputs.old_pat_path, policy.inputs.replacement_service_path]
    .every(existsSync),
  "PREPARED reboot recovery must restore every escrow-bound one-use input",
);

const verified = live.verifyInstalledPrecheck({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  serviceInvocationId: rebootedPreInvocation,
  nowMs: now(),
});
transition.applyCredentialTransition({
  sha: candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  transactionId,
  precheckSha256: verified.precheckSha256,
  transitionBeforeSha256: verified.transitionBeforeSha256,
  transitionAfterSha256: verified.transitionAfterSha256,
  validateCandidate: () => {},
  restartAndVerify: () => {},
  validateServiceConfiguration: () => {},
  now: () => iso(now()),
});
check(readFileSync(runtimePath, "utf8").includes(credentials.replacement_service.toString("utf8")), "transition must install the escrow-bound replacement service key");
check(existsSync(`${stateRoot}/credential-transition.pending.json`), "transition must preserve the awaiting-provider rollback record");

providerRevoked = true;
writeRootFile(invocationPath, `${proofInvocation}\n`, 0o600);
const proof = await live.produceInstalledRevocationProof({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  postCutoverInvocationId: proofInvocation,
  fetchImpl,
  now,
});
check(/^[0-9a-f]{64}$/.test(proof.revocationProofSha256), "revocation proof must be durably signed");

alertsResolved = true;
alertsResolvedAt = iso(now());
writeRootFile(invocationPath, `${completionInvocation}\n`, 0o600);
const completion = await live.produceInstalledCompletion({
  candidateSha,
  runId: remediationRun,
  runAttempt: remediationAttempt,
  postCutoverInvocationId: completionInvocation,
  fetchImpl,
  now,
});
check(/^[0-9a-f]{64}$/.test(completion.completionSha256), "completion must survive a post-proof service restart");

writeRootFile(invocationPath, `${readbackInvocation}\n`, 0o600);
const readback = await live.produceInstalledReadback({
  remediationSha: candidateSha,
  releaseSha: closureSha,
  runId: closureRun,
  runAttempt: closureAttempt,
  postCutoverInvocationId: readbackInvocation,
  fetchImpl,
  now,
});
check(/^[0-9a-f]{64}$/.test(readback.readbackSha256), "fresh readback must survive a post-completion service restart");

const consumed = await live.consumeInstalledCredentialAttestation({
  remediationSha: candidateSha,
  releaseSha: closureSha,
  runId: closureRun,
  runAttempt: closureAttempt,
  postCutoverInvocationId: readbackInvocation,
  fetchImpl,
  now,
});
check(/^[0-9a-f]{64}$/.test(consumed.tombstoneSha256), "consume must write the signed tombstone");
const consumedAgain = await live.consumeInstalledCredentialAttestation({
  remediationSha: candidateSha,
  releaseSha: closureSha,
  runId: closureRun,
  runAttempt: closureAttempt,
  postCutoverInvocationId: readbackInvocation,
  fetchImpl,
  now,
});
check(consumedAgain.tombstoneSha256 === consumed.tombstoneSha256, "consumed reentry must be idempotent");
const journal = JSON.parse(readFileSync(policy.state.journal_path, "utf8"));
check(journal.state === "CONSUMED", "journal must converge to CONSUMED");
check(!existsSync(`${stateRoot}/credential-transition.pending.json`), "signed transition finalization must remove pending rollback state");
check(!existsSync(`${stateRoot}/credential-transition.previous.env`), "signed transition finalization must remove the old runtime backup");
check(!existsSync(policy.state.escrow_directory), "consumption must remove sealed credential escrow");
check(
  [policy.inputs.claim_path, policy.inputs.provider_identity_receipt_path, policy.inputs.old_pat_path, policy.inputs.replacement_service_path]
    .every((file) => !existsSync(file)),
  "consumption must remove every one-use input",
);
const durableText = readdirSync(stateRoot)
  .filter((entry) => statSync(path.join(stateRoot, entry)).isFile())
  .map((entry) => readFileSync(path.join(stateRoot, entry)))
  .join("\n");
for (const value of Object.values(credentials)) {
  check(!durableText.includes(value.toString("utf8")), "durable evidence must not contain raw credential bytes");
}
check(requestCounter > 30, "five-stage drill must execute fresh provider requests across every phase");
process.stdout.write(`credential_live_five_stage_drill_checks=${checks} provider_requests=${requestCounter} failures=0\n`);
