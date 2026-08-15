#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'G0-Lite evidence: %s\n' "$1" >&2
  exit 1
}

[[ "$#" -eq 4 ]] || fail "evidence path, acceptance digest, closure SHA, and final run ID are required"
EVIDENCE_FILE="$1"
ACCEPTANCE_DIGEST="$2"
RELEASE_CLOSURE_SHA="$3"
RELEASE_FINAL_RUN_ID="$4"
[[ -f "$EVIDENCE_FILE" && ! -L "$EVIDENCE_FILE" ]] || fail "evidence file not found or is a symlink"
[[ "$ACCEPTANCE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "acceptance digest must be an exact SHA-256"
[[ "$RELEASE_CLOSURE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "release closure SHA must be exact"
[[ "$RELEASE_FINAL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "release final run ID must be numeric"

python3 - "$EVIDENCE_FILE" "$ACCEPTANCE_DIGEST" "$RELEASE_CLOSURE_SHA" "$RELEASE_FINAL_RUN_ID" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from datetime import datetime, timezone

path, acceptance_digest, closure_sha, final_run_id = sys.argv[1:]

def fail(message):
    print(f"G0-Lite evidence: {message}", file=sys.stderr)
    raise SystemExit(1)

def read_regular(file_path, label, maximum_bytes=64 * 1024 * 1024):
    descriptor = None
    try:
        descriptor = os.open(
            file_path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0),
        )
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            fail(f"{label} must be a regular non-symlink file")
        if before.st_size <= 0 or before.st_size > maximum_bytes:
            fail(f"{label} size is outside the accepted range")
        chunks = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(descriptor)
        if (
            (os.name == "posix" and (after.st_dev != before.st_dev or after.st_ino != before.st_ino))
            or after.st_size != before.st_size
            or len(raw) != before.st_size
        ):
            fail(f"{label} changed while it was being read")
        return raw
    except OSError as exc:
        fail(f"invalid {label}: {exc}")
    finally:
        if descriptor is not None:
            os.close(descriptor)

def read_regular_json(file_path, label):
    try:
        raw = read_regular(file_path, label)
        return raw, json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        fail(f"invalid {label}: {exc}")

_, evidence = read_regular_json(path, "evidence file")
git_sha = evidence.get("git_sha")
build_id = evidence.get("build_id")
if not re.fullmatch(r"[0-9a-f]{40}", git_sha or "") or not build_id:
    fail("git_sha and build_id are required")
if closure_sha == git_sha:
    fail("release closure SHA must differ from the deployed release SHA")

for section in ("build", "systemd", "smoke", "logs", "regression", "health"):
    if evidence.get(section, {}).get("status") != "pass":
        fail(f"{section}.status must be pass")

ci = evidence.get("ci", {})
if ci.get("conclusion") != "success" or ci.get("head_sha") != git_sha:
    fail("CI evidence is not bound to release SHA")

migration = evidence.get("migration", {})
if migration.get("status") not in {"not_required", "applied_verified"}:
    fail("migration status is not verified")
if migration.get("status") == "applied_verified" and not migration.get("ids"):
    fail("applied migration IDs are required")
if migration.get("status") == "not_required" and migration.get("ids"):
    fail("migration IDs must be empty when not required")

rollback = evidence.get("rollback", {})
for field in ("git_sha", "build_id", "backup_dir", "asset_backup"):
    if not rollback.get(field):
        fail(f"rollback.{field} is required")

acceptance = evidence.get("acceptance", {})
expected_acceptance = {
    "status": "verified",
    "attestation_version": "newme-postdeploy-attestation/v1",
    "schema_version": "newme-postdeploy-evidence/v1",
    "bundle_sha256": acceptance_digest,
    "policy_sha256": acceptance.get("policy_sha256"),
    "schema_sha256": acceptance.get("schema_sha256"),
    "receipt_key_sha256": acceptance.get("receipt_key_sha256"),
    "deploy_run_id": str(ci.get("run_id", "")),
    "sealed_directory": "postdeploy-acceptance-v1",
    "verified_at": acceptance.get("verified_at"),
}
if evidence.get("release_status") not in {"acceptance_verified", "complete"}:
    fail("release_status must be acceptance_verified before completion")
if acceptance != expected_acceptance:
    fail("acceptance_verified state does not match the requested digest and deploy run")
for digest_field in ("policy_sha256", "schema_sha256", "receipt_key_sha256"):
    if not re.fullmatch(r"[0-9a-f]{64}", acceptance.get(digest_field) or ""):
        fail(f"acceptance.{digest_field} is invalid")

sealed_dir = os.path.join(os.path.dirname(os.path.abspath(path)), acceptance["sealed_directory"])
if os.path.islink(sealed_dir) or not os.path.isdir(sealed_dir):
    fail("sealed acceptance directory is missing or is a symlink")
_, attestation = read_regular_json(os.path.join(sealed_dir, "attestation.json"), "postdeploy attestation")
bundle_raw, bundle = read_regular_json(os.path.join(sealed_dir, "bundle.json"), "sealed postdeploy bundle")
if hashlib.sha256(bundle_raw).hexdigest() != acceptance_digest:
    fail("sealed bundle digest no longer matches acceptance digest")
if set(attestation) != {
    "attestation_version", "schema_version", "release_sha", "build_id",
    "deploy_run_id", "bundle_sha256", "policy_sha256", "schema_sha256",
    "receipt_key_sha256",
    "sealed_artifacts", "verified_at",
}:
    fail("postdeploy attestation shape is invalid")
if (
    attestation.get("attestation_version") != acceptance["attestation_version"]
    or attestation.get("schema_version") != acceptance["schema_version"]
    or attestation.get("release_sha") != git_sha
    or attestation.get("build_id") != build_id
    or attestation.get("deploy_run_id") != acceptance["deploy_run_id"]
    or attestation.get("bundle_sha256") != acceptance_digest
    or attestation.get("policy_sha256") != acceptance["policy_sha256"]
    or attestation.get("schema_sha256") != acceptance["schema_sha256"]
    or attestation.get("receipt_key_sha256") != acceptance["receipt_key_sha256"]
    or attestation.get("verified_at") != acceptance["verified_at"]
):
    fail("postdeploy attestation does not match deployment acceptance state")
if (
    bundle.get("release", {}).get("git_sha") != git_sha
    or bundle.get("release", {}).get("build_id") != build_id
    or bundle.get("release", {}).get("deploy_run_id") != acceptance["deploy_run_id"]
    or bundle.get("policy", {}).get("sha256") != acceptance["policy_sha256"]
    or bundle.get("schema", {}).get("sha256") != acceptance["schema_sha256"]
    or bundle.get("receipt_key_sha256") != acceptance["receipt_key_sha256"]
):
    fail("sealed bundle is not bound to deployed release and build")

sealed_artifacts = attestation.get("sealed_artifacts")
if not isinstance(sealed_artifacts, list) or not sealed_artifacts:
    fail("postdeploy attestation has no sealed artifacts")
bundle_artifacts = bundle.get("artifacts")
if not isinstance(bundle_artifacts, list) or not bundle_artifacts:
    fail("sealed bundle has no artifact manifest")
bundle_artifacts_by_id = {}
for index, artifact in enumerate(bundle_artifacts):
    if not isinstance(artifact, dict) or set(artifact) != {"id", "kind", "path", "sha256", "media_type"}:
        fail(f"sealed bundle artifact {index} shape is invalid")
    artifact_id = artifact.get("id")
    artifact_digest = artifact.get("sha256")
    if (
        not isinstance(artifact_id, str)
        or artifact_id in bundle_artifacts_by_id
        or not re.fullmatch(r"[0-9a-f]{64}", artifact_digest or "")
        or artifact.get("media_type") != "application/json"
    ):
        fail(f"sealed bundle artifact {index} identity is invalid")
    bundle_artifacts_by_id[artifact_id] = artifact
if len(sealed_artifacts) != len(bundle_artifacts_by_id):
    fail("sealed artifact inventory does not match the bundle")
seen_ids = set()
for index, artifact in enumerate(sealed_artifacts):
    if not isinstance(artifact, dict) or set(artifact) != {"id", "sha256", "file"}:
        fail(f"sealed artifact {index} shape is invalid")
    artifact_id = artifact.get("id")
    artifact_digest = artifact.get("sha256")
    artifact_file = artifact.get("file")
    if artifact_id in seen_ids or not re.fullmatch(r"[0-9a-f]{64}", artifact_digest or ""):
        fail(f"sealed artifact {index} identity is invalid")
    expected_file = f"artifacts/{artifact_digest}"
    if artifact_file != expected_file:
        fail(f"sealed artifact {index} path is not content-addressed")
    if artifact_id not in bundle_artifacts_by_id or bundle_artifacts_by_id[artifact_id].get("sha256") != artifact_digest:
        fail(f"sealed artifact {index} does not match the bundle artifact manifest")
    artifact_path = os.path.join(sealed_dir, *artifact_file.split("/"))
    raw = read_regular(artifact_path, f"sealed artifact {index}")
    if hashlib.sha256(raw).hexdigest() != artifact_digest:
        fail(f"sealed artifact {index} digest no longer matches")
    seen_ids.add(artifact_id)
if seen_ids != set(bundle_artifacts_by_id):
    fail("sealed artifact IDs do not exactly match the bundle")

expected_closure = {
    "release_sha": git_sha,
    "acceptance_digest": acceptance_digest,
    "closure_sha": closure_sha,
    "final_ci_run_id": final_run_id,
    "final_ci_run_url": f"https://github.com/69755354/newme-platform/actions/runs/{final_run_id}",
    "final_ci_head_sha": closure_sha,
    "final_ci_conclusion": "success",
    "required_jobs_manifest": "infra/release/final-required-jobs.json",
}

directory = os.path.dirname(os.path.abspath(path))

def fsync_directory(directory_path):
    if os.name != "posix":
        return
    directory_fd = os.open(directory_path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)

if evidence.get("release_status") == "complete":
    existing_closure = evidence.get("release_closure", {})
    if not isinstance(existing_closure, dict) or any(
        existing_closure.get(key) != value for key, value in expected_closure.items()
    ):
        fail("completed release-closure evidence does not match requested finalization")
    evidence_fd = os.open(path, os.O_RDWR)
    try:
        os.fsync(evidence_fd)
    finally:
        os.close(evidence_fd)
    fsync_directory(directory)
    raise SystemExit(0)

completed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
evidence["release_closure"] = {**expected_closure, "verified_at": completed_at}
evidence["release_status"] = "complete"

fd, temporary = tempfile.mkstemp(prefix=".deploy-evidence-", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fsync_directory(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
