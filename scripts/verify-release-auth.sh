#!/usr/bin/env bash
# ─── VERIFY-RELEASE-AUTH ─────────────────────────────────────
# Validates a Codex release authorization before deploy (deploy.sh Step 0.9).
#
# WHY THIS EXISTS
#   A bare control-plane `codex_decision: "GO"` is a global flag that is NOT
#   bound to a specific PR or commit. That lets a stale Codex GO silently
#   auto-approve a different release. This script binds the GO to:
#     - a concrete merged SHA (merged_main_sha == current HEAD)
#     - a green CI run (ci_conclusion == "success")
#     - a live, non-expired window (expires_at)
#   so the authorization cannot be replayed against another release.
#
# USAGE
#   verify-release-auth.sh [path/to/authorization.json]
#     default: .hermes/release-authorization/task_g0_autonomous_release_chain.json
#
# EXIT
#   0 — release authorized (prints "✅ Release authorized: <RELEASE_ID>")
#   1 — not authorized (prints "🚫 Release NOT authorized: <reason>")
# ─────────────────────────────────────────────────────────────
set -uo pipefail

# Resolve repo root from this script's location (scripts/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

AUTH_FILE="${1:-.hermes/release-authorization/task_g0_autonomous_release_chain.json}"

fail() {
  echo "🚫 Release NOT authorized: $1"
  exit 1
}

# 1. File exists
if [ ! -f "$AUTH_FILE" ]; then
  fail "authorization file not found ($AUTH_FILE)"
fi

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
NOW_EPOCH="$(date -u +%s)"

# Checks 2–6 run in Python so JSON parsing, nested scope access and ISO-8601
# expiry math are exact and locale-independent.
python3 - "$AUTH_FILE" "$HEAD_SHA" "$NOW_EPOCH" <<'PYEOF'
import json
import sys
import datetime

auth_path, head_sha, now_epoch = sys.argv[1], sys.argv[2], int(sys.argv[3])


def fail(msg):
    print(f"🚫 Release NOT authorized: {msg}")
    sys.exit(1)


# 1b. Readable + valid JSON
try:
    with open(auth_path) as fh:
        d = json.load(fh)
except FileNotFoundError:
    fail(f"authorization file not found ({auth_path})")
except json.JSONDecodeError as exc:
    fail(f"authorization file is not valid JSON ({auth_path}): {exc}")

release_id = d.get("release_id", "__MISSING__")

# 2. codex_go == true (strict boolean, rejects "true" strings)
if d.get("codex_go") is not True:
    fail(f"codex_go is not true (got {d.get('codex_go')!r}) for {release_id}")

# 3. expires_at present, parseable, and not in the past
expires_at = d.get("expires_at")
if not expires_at:
    fail(f"expires_at missing for {release_id}")
try:
    exp_dt = datetime.datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
except ValueError:
    fail(f"expires_at is not a valid ISO-8601 timestamp ({expires_at!r})")
if exp_dt.timestamp() < now_epoch:
    fail(f"authorization EXPIRED at {expires_at} for {release_id}")

# 4. merged_main_sha must exactly match the current git HEAD
merged_sha = d.get("merged_main_sha")
if not isinstance(merged_sha, str) or not merged_sha:
    fail(f"merged_main_sha missing or not a string for {release_id}")
if not head_sha:
    fail("cannot resolve current git HEAD (not a git repository?)")
if merged_sha != head_sha:
    fail(
        f"merged_main_sha mismatch for {release_id}: "
        f"auth={merged_sha} HEAD={head_sha}"
    )

# 5. ci_conclusion == "success"
if d.get("ci_conclusion") != "success":
    fail(
        f"ci_conclusion is not 'success' "
        f"(got {d.get('ci_conclusion')!r}) for {release_id}"
    )

# 6. scope.deploy_required must be present (truthy/falsy is the caller's call;
#    its existence proves the scope was explicitly considered)
scope = d.get("scope")
if not isinstance(scope, dict) or "deploy_required" not in scope:
    fail(f"scope.deploy_required missing for {release_id}")

print(f"✅ Release authorized: {release_id}")
sys.exit(0)
PYEOF
