#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'G0-Lite evidence: %s\n' "$1" >&2
  exit 1
}

[[ "$#" -eq 1 ]] || fail "exactly one evidence file path is required"
EVIDENCE_FILE="$1"
[[ -f "$EVIDENCE_FILE" ]] || fail "evidence file not found"
[[ -n "${UAT_STATUS:-}" ]] || fail "UAT_STATUS is required"
[[ -n "${UAT_ACTOR+x}" ]] || fail "UAT_ACTOR must be present"
[[ -n "${UAT_FIXTURE_IDS+x}" ]] || fail "UAT_FIXTURE_IDS must be present"
[[ -n "${FIXTURE_CLEANUP_STATUS:-}" ]] || fail "FIXTURE_CLEANUP_STATUS is required"

python3 - "$EVIDENCE_FILE" "$UAT_STATUS" "$UAT_ACTOR" "$UAT_FIXTURE_IDS" "$FIXTURE_CLEANUP_STATUS" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, uat_status, actor, fixture_text, cleanup = sys.argv[1:]

def fail(message):
    print(f"G0-Lite evidence: {message}", file=sys.stderr)
    raise SystemExit(1)

try:
    with open(path, encoding="utf-8") as handle:
        evidence = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    fail(f"invalid evidence file: {exc}")

git_sha = evidence.get("git_sha")
build_id = evidence.get("build_id")
if not git_sha or not build_id:
    fail("git_sha and build_id are required")

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

if uat_status not in {"pass", "fail"}:
    fail("UAT_STATUS must be pass or fail")

fixtures = [value.strip() for value in fixture_text.split(",") if value.strip()]
if len(fixtures) != len(set(fixtures)):
    fail("fixture IDs must be unique")
if not actor.strip():
    fail("authenticated UAT actor is required")
if cleanup not in {"not_required", "archived_verified", "removed_verified"}:
    fail("fixture cleanup status is invalid")
if fixtures and cleanup not in {"archived_verified", "removed_verified"}:
    fail("fixture IDs require verified cleanup")

directory = os.path.dirname(os.path.abspath(path))

def fsync_directory(directory_path):
    if os.name != "posix":
        return
    directory_fd = os.open(directory_path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)

if evidence.get("release_status") in {"complete", "uat_failed"}:
    expected_status = "pass" if evidence.get("release_status") == "complete" else "fail"
    existing_uat = evidence.get("uat", {})
    if (
        uat_status != expected_status
        or existing_uat.get("status") != expected_status
        or existing_uat.get("actor") != actor.strip()
        or existing_uat.get("fixture_ids") != fixtures
        or existing_uat.get("cleanup_status") != cleanup
    ):
        fail("completed UAT evidence does not match the requested finalization")
    evidence_fd = os.open(path, os.O_RDWR)
    try:
        os.fsync(evidence_fd)
    finally:
        os.close(evidence_fd)
    fsync_directory(directory)
    raise SystemExit(0)
if evidence.get("release_status") != "awaiting_uat":
    fail("release_status must be awaiting_uat or matching complete evidence")

completed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

if uat_status == "fail":
    evidence["uat"] = {
        "status": "fail",
        "actor": actor.strip(),
        "completed_at": completed_at,
        "fixture_ids": fixtures,
        "cleanup_status": cleanup,
    }
    evidence["release_status"] = "uat_failed"
else:
    evidence["uat"] = {
        "status": "pass",
        "actor": actor.strip(),
        "completed_at": completed_at,
        "fixture_ids": fixtures,
        "cleanup_status": cleanup,
    }
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
