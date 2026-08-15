#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CredentialLiveError,
  deleteCredentialEscrow,
  readCredentialEscrow,
  removeTrustedRootFileMatching,
  restorePreparedInput,
  sha256,
  writeCredentialEscrow,
} from "./credential-live-attestation.mjs";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  process.stderr.write("credential_live_attestation_drill_requires_linux_root\n");
  process.exit(1);
}

const root = `/var/lib/newme-credential-live-drill-${process.pid}`;
if (!root.startsWith("/var/lib/newme-credential-live-drill-")) process.exit(1);
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const expectCode = (fn, code) => {
  assert.throws(fn, (error) => error instanceof CredentialLiveError && error.code === code);
  checks += 1;
};

try {
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const inputs = path.join(root, "inputs");
  mkdirSync(inputs, { mode: 0o700 });
  chmodSync(inputs, 0o700);
  const claimPath = path.join(inputs, "claim.json");
  const expectedClaim = Buffer.from(JSON.stringify({ version: 1, identity: randomUUID() }));
  const replacementClaim = Buffer.from(JSON.stringify({ version: 1, identity: randomUUID() }));

  writeFileSync(claimPath, expectedClaim, { mode: 0o600 });
  chmodSync(claimPath, 0o600);
  check(removeTrustedRootFileMatching(claimPath, {
    maximum: 65_536,
    modes: [0o600],
    label: "drill_claim",
    matches: (bytes) => bytes.equals(expectedClaim),
  }) === true, "exact claim must be consumed");
  check(!existsSync(claimPath) && !existsSync(`${claimPath}.credential-consume`), "exact claim must leave no file");

  writeFileSync(claimPath, replacementClaim, { mode: 0o600 });
  chmodSync(claimPath, 0o600);
  expectCode(() => removeTrustedRootFileMatching(claimPath, {
    maximum: 65_536,
    modes: [0o600],
    label: "drill_claim",
    matches: (bytes) => bytes.equals(expectedClaim),
  }), "drill_claim_mismatch");
  check(readFileSync(claimPath).equals(replacementClaim), "mismatched replacement must be restored and preserved");
  check(!existsSync(`${claimPath}.credential-consume`), "mismatch recovery must not leave quarantine");

  rmSync(claimPath);
  writeFileSync(claimPath, expectedClaim, { mode: 0o600 });
  chmodSync(claimPath, 0o600);
  renameSync(claimPath, `${claimPath}.credential-consume`);
  check(removeTrustedRootFileMatching(claimPath, {
    maximum: 65_536,
    modes: [0o600],
    label: "drill_claim",
    matches: (bytes) => bytes.equals(expectedClaim),
  }) === true, "post-rename hard-kill state must resume");
  check(!existsSync(claimPath) && !existsSync(`${claimPath}.credential-consume`), "hard-kill resume must converge");

  writeFileSync(claimPath, expectedClaim, { mode: 0o600 });
  writeFileSync(`${claimPath}.credential-consume`, expectedClaim, { mode: 0o600 });
  chmodSync(claimPath, 0o600);
  chmodSync(`${claimPath}.credential-consume`, 0o600);
  expectCode(() => removeTrustedRootFileMatching(claimPath, {
    maximum: 65_536,
    modes: [0o600],
    label: "drill_claim",
    matches: (bytes) => bytes.equals(expectedClaim),
  }), "drill_claim_consume_conflict");
  check(existsSync(claimPath) && existsSync(`${claimPath}.credential-consume`), "conflict must preserve both files");
  rmSync(claimPath);
  rmSync(`${claimPath}.credential-consume`);

  const restoredInputPath = path.join(inputs, "restored-input.env");
  const restoredInput = Buffer.from("SUPABASE_SERVICE_ROLE_KEY=drill-restored-service-key-1234567890\n");
  restorePreparedInput(restoredInputPath, restoredInput, {
    maximum: 4096,
    label: "drill_prepared_input",
  });
  check(readFileSync(restoredInputPath).equals(restoredInput), "missing PREPARED input must restore exact escrow-bound bytes");
  restorePreparedInput(restoredInputPath, restoredInput, {
    maximum: 4096,
    label: "drill_prepared_input",
  });
  checks += 1;
  writeFileSync(restoredInputPath, Buffer.from("SUPABASE_SERVICE_ROLE_KEY=drill-substituted-service-key-123456\n"), { mode: 0o600 });
  expectCode(() => restorePreparedInput(restoredInputPath, restoredInput, {
    maximum: 4096,
    label: "drill_prepared_input",
  }), "prepared_input_identity_mismatch");
  check(
    readFileSync(restoredInputPath).includes(Buffer.from("drill-substituted-service-key")),
    "PREPARED recovery must preserve a substituted input and fail closed",
  );
  rmSync(restoredInputPath);

  const state = path.join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const policy = {
    escrow_ttl_seconds: 60,
    state: { escrow_directory: path.join(state, "escrow") },
  };
  const nowMs = Date.parse("2026-08-15T00:00:00Z");
  const fingerprintKey = randomBytes(32);
  const transactionId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const claimBytes = Buffer.from(JSON.stringify({ transaction_id: transactionId, nonce }));
  const providerIdentityReceiptBytes = Buffer.from(JSON.stringify({ version: "drill-provider-identity-receipt" }));
  const oldPat = Buffer.from(`drill-old-pat-${randomBytes(16).toString("hex")}`);
  const oldService = Buffer.from(`drill-old-service-${randomBytes(16).toString("hex")}`);
  const replacementService = Buffer.from(`drill-new-service-${randomBytes(16).toString("hex")}`);
  writeCredentialEscrow({
    policy,
    fingerprintKey,
    transactionId,
    nonce,
    claimBytes,
    providerIdentityReceiptBytes,
    oldPat,
    oldService,
    replacementService,
    nowMs,
  });
  const identity = {
    policy,
    fingerprintKey,
    transactionId,
    nonce,
    claimSha256: sha256(claimBytes),
  };
  const liveEscrow = readCredentialEscrow({ ...identity, nowMs: nowMs + 30_000 });
  check(liveEscrow.oldPat.equals(oldPat), "escrow must authenticate the exact old PAT");
  check(
    liveEscrow.providerIdentityReceiptBytes.equals(providerIdentityReceiptBytes),
    "escrow must authenticate the exact provider identity receipt",
  );
  check(liveEscrow.replacementService.equals(replacementService), "escrow must authenticate the exact replacement service key");
  expectCode(() => readCredentialEscrow({ ...identity, nowMs: nowMs + 61_000 }), "escrow_expired");
  const historicalEscrow = readCredentialEscrow({ ...identity, nowMs: nowMs + 30_000 });
  check(historicalEscrow.claimBytes.equals(claimBytes), "signed historical consumption time must still authenticate escrow identity");
  deleteCredentialEscrow(policy);
  check(!existsSync(policy.state.escrow_directory), "escrow deletion must leave no directory");
  deleteCredentialEscrow(policy);
  checks += 1;

  process.stdout.write(`credential_live_attestation_drill_checks=${checks} failures=0\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
