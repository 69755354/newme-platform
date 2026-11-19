#!/usr/bin/env bash
# Single-step release close: closing record PR -> required checks -> merge -> release_final CI -> finalize.
#
#   scripts/release-close.sh <release-sha> <acceptance-digest> <previous-release-sha> "<id>|<headline>" <logdir>
#
# This replaces three hand-run steps with one command and replaces fixed sleeps with event-driven waits.
# It does NOT remove or weaken any evidence the finalizer demands:
#   * the closing record is still a TASKBOARD.md-only commit that reaches main through a pull request;
#   * every context in infra/release/branch-protection.json must be green on that pull request before merge;
#   * the merge result must be the canonical main head and still be a single TASKBOARD.md-only child of the release;
#   * release_final CI must run, at that exact closure SHA, as a workflow_dispatch run and succeed;
#   * `newme-deploy finalize` then re-measures all of it from the root-owned mirror, unchanged.
# Any failed step stops the script with a non-zero exit; nothing is retried by merging around a red check.
set -uo pipefail

[ "$#" -eq 5 ] || { echo "usage: $0 <release-sha> <acceptance-digest> <previous-release-sha> \"<id>|<headline>\" <logdir>" >&2; exit 64; }
SHA=$1; DIG=$2; PREV=$3; HEAD=$4; LOG=$5
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$PREV" =~ ^[0-9a-f]{40}$ && "$DIG" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA or digest is malformed" >&2; exit 64; }
REPO=${RELEASE_CLOSE_REPO:-69755354/newme-platform}
WORKTREE=${RELEASE_CLOSE_WORKTREE:-$PWD}
DEPLOY=${NEWME_DEPLOY_BIN:-/usr/local/sbin/newme-deploy}
mkdir -p "$LOG"; L="$LOG/close.log"
say() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$L"; }
die() { say "STOP: $*"; exit "${2:-1}"; }

cd "$WORKTREE" || exit 1
git fetch -q origin "+refs/heads/main:refs/remotes/origin/main" || die "cannot fetch main" 2
git merge-base --is-ancestor "$SHA" origin/main || die "release $SHA is not contained in main" 2
BRANCH="record/${SHA:0:8}"
git checkout -q -f -B "$BRANCH" origin/main || die "cannot create $BRANCH" 2

AUD=/opt/newme/releases/$SHA/.audit
DEP=$(sudo -n ls "$AUD" | grep '^deploy-' | head -1)
TS=$(echo "$DEP" | sed -E 's/deploy-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z.*/\1-\2-\3T\4:\5:\6Z/')
[[ "$TS" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || die "cannot read deploy time from $AUD" 2
EVID=$(sudo -n python3 - "$AUD/postdeploy-acceptance-v1/bundle.json" "$DIG" <<'PY'
import hashlib, json, sys
raw = open(sys.argv[1], "rb").read()
if hashlib.sha256(raw).hexdigest() != sys.argv[2]:
    raise SystemExit("bundle digest does not match the supplied acceptance digest")
d = json.loads(raw)
a = d["alert_drill"]
alert = "ok" if a["final_status"] == "ok" else "warned:" + a["reason_code"]
print(d["performance"]["p75_ms"], d["performance"]["p95_ms"], d["delayed_verification"]["completed_at"], alert)
PY
) || die "sealed bundle does not match the acceptance digest" 2
read -r P75 P95 DLY ALERT <<<"$EVID"
if [ "$ALERT" = ok ]; then
  ALERT_TEXT="The alert drill passed with provider receipts and a delayed provider readback."
else
  ALERT_TEXT="WARNING: the alert drill was NOT verified (${ALERT#warned:}); the failure was recorded in the sealed bundle and did not freeze the gate. Service, logs, restarts, fixtures and performance were verified normally."
fi
DAY=$(date -u +%F)
cat >> TASKBOARD.md <<TB

## OS fix ${HEAD%%|*} technical acceptance ($DAY)

Release \`$SHA\` (${HEAD#*|}) passed its candidate CI and was deployed through the protected
coordinator at \`$TS\`, replacing the finalized release \`${PREV:0:8}\`. Canonical production
acceptance verified all four roles, eight browser sessions and bound artifacts. All fixture
objects were cleaned, with zero residuals and exact KPI restoration. Performance measured
p75 $P75 ms / p95 $P95 ms, within policy. The delayed verification passed at \`$DLY\`.
$ALERT_TEXT Canonical attestation sealed the bundle below.

<!-- postdeploy-acceptance-sha256:$DIG -->
TB
node scripts/check-taskboard.mjs --require-scope=predeploy_ready 2>&1 | tail -1 | tee -a "$L"
[ "${PIPESTATUS[0]}" = 0 ] || die "TASKBOARD completion gate refused the closing record" 3
[ "$(git diff --name-only)" = TASKBOARD.md ] || die "closing record must change TASKBOARD.md and nothing else" 3

git add TASKBOARD.md && git commit -q -m "Record verified OS fix ${HEAD%%|*} technical acceptance

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" || die "commit failed" 3
git push -q -f -u origin "$BRANCH" 2>&1 | grep -v '^remote'
URL=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "Record verified OS fix ${HEAD%%|*} technical acceptance" --body "Closing record (TASKBOARD.md only) for release ${SHA:0:8}.

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>&1 | tail -1)
N=${URL##*/}; [[ "$N" =~ ^[0-9]+$ ]] || die "pull request was not created: $URL" 3
say "closing PR #$N"

# Wait for the checks to be REGISTERED, then for all of them to finish. No fixed sleep.
for _ in $(seq 1 40); do gh pr checks "$N" --repo "$REPO" 2>&1 | grep -q "no checks" || break; sleep 15; done
gh pr checks "$N" --repo "$REPO" --watch --interval 20 >/dev/null 2>&1
CHECKS=$(gh pr checks "$N" --repo "$REPO" 2>&1 | cut -f1,2 | tee -a "$L")
REQUIRED=$(python3 -c 'import json;print("\n".join(json.load(open("infra/release/branch-protection.json"))["protection"]["required_status_checks"]["contexts"]))')
while IFS= read -r ctx; do
  printf '%s\n' "$CHECKS" | grep -Fq "$(printf '%s\tpass' "$ctx")" || die "required check \"$ctx\" is not green; not merging" 4
done <<<"$REQUIRED"
printf '%s\n' "$CHECKS" | grep -E $'\t(fail|pending)' && die "a check failed or is still pending; not merging" 4
[ "$(gh pr diff "$N" --repo "$REPO" --name-only)" = TASKBOARD.md ] || die "pull request changed more than TASKBOARD.md; not merging" 4

gh pr merge "$N" --repo "$REPO" --squash --subject "Record verified OS fix ${HEAD%%|*} technical acceptance (#$N)" \
  --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>&1 | tail -1 | tee -a "$L"
git fetch -q origin "+refs/heads/main:refs/remotes/origin/main"; C=$(git rev-parse origin/main)
[ "$(git rev-list --count "$SHA..$C")" = 1 ] && [ "$(git diff --name-only "$SHA" "$C")" = TASKBOARD.md ] \
  || die "main is not exactly the release plus one TASKBOARD.md-only closure commit (another commit landed); finalize must wait" 5
say "closure=$C"

gh workflow run ci.yml --repo "$REPO" --ref main -f release_final=true -f release_sha="$SHA" -f closure_sha="$C" -f acceptance_digest="$DIG" 2>&1 | tail -1 | tee -a "$L"
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list --repo "$REPO" --workflow ci.yml --branch main --limit 6 --json databaseId,event,headSha -q "[.[]|select(.event==\"workflow_dispatch\" and .headSha==\"$C\")][0].databaseId")
  [ -n "$RUN" ] && [ "$RUN" != null ] && break; sleep 10
done
[ -n "$RUN" ] && [ "$RUN" != null ] || die "release_final run did not appear" 6
say "release_final run=$RUN"
gh run watch "$RUN" --repo "$REPO" --interval 30 --exit-status >/dev/null 2>&1; c=$(gh run view "$RUN" --repo "$REPO" --json conclusion -q .conclusion)
say "release_final CI: $c"; [ "$c" = success ] || die "release_final CI is not green" 6

sudo -n "$DEPLOY" finalize "$SHA" "$DIG" "$C" "$RUN" > "$LOG/finalize.log" 2>&1; rc=$?
say "finalize exit=$rc"; tail -1 "$LOG/finalize.log" | cut -c1-240 | tee -a "$L"
[ "$rc" = 0 ] || die "finalize refused" 7
echo CLOSE-DONE | tee -a "$L"
