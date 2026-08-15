#!/usr/bin/env bash
# ============================================================================
# Regenerate supabase/migration-history-baseline.sha256 from a base commit.
# ============================================================================
# The manifest pins the already-applied migration set by content hash so that
# scripts/check-migration-history.mjs can refuse any modification, deletion or
# rename of an applied file, and so scripts/replay-migrations.sh can derive the
# branch's new-migration set without needing git.
#
# This script exists so the manifest is reproducible rather than asserted: a
# reviewer runs it against the same base commit and diffs the result. It writes
# to stdout and never touches the committed file — the caller decides, after
# reading the diff.
#
#   bash scripts/regenerate-history-baseline.sh 81956f2 > /tmp/baseline.new
#   diff supabase/migration-history-baseline.sha256 /tmp/baseline.new
#
# The hash is sha256 over the file content with CRLF normalised to LF; see the
# header the script emits for why.
# ============================================================================
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: bash scripts/regenerate-history-baseline.sh <base-commit>" >&2
  exit 2
fi

BASE="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1 \
  || { echo "not a commit: $BASE" >&2; exit 1; }
BASE_FULL="$(git rev-parse "$BASE^{commit}")"

cat <<HDR
# Migration history baseline — the applied set at the PR base, by content hash.
#
# BASE_COMMIT $BASE_FULL
#
# Every line is "<sha256>  <filename>" for a file in supabase/migrations/ that
# the history claims has already been applied. Two gates read this file:
#
#   scripts/check-migration-history.mjs   (host / CI; also cross-checks this
#                                          manifest against the base commit)
#   scripts/replay-migrations.sh          (derives the branch's new-migration
#                                          set as "present but not listed here")
#
# The hash is taken over the content with CRLF normalised to LF. git stores LF
# and a Windows checkout with core.autocrlf=true materialises CRLF, so hashing
# the raw working file would make this gate pass or fail depending on the
# developer's platform. Normalising matches what git itself tracks.
#
# rollback_*.sql is deliberately absent: the Supabase CLI never applies it
# (its name does not match ^[0-9]{14}_), so it is an inert companion that stays
# editable. Only applied artifacts are immutable.
#
# 1780601210_workflow_stages.sql is listed with a 10-digit epoch prefix. That is
# the recorded defect, not a typo: the CLI never saw the file, yet the table it
# creates is in production because it was applied by hand. It is pinned here so
# it cannot be renamed away again, while any NEW file with a non-conforming name
# is still a hard failure.
#
# Regenerate (and diff, never blind-write):
#   bash scripts/regenerate-history-baseline.sh <base-commit>
HDR

git ls-tree -r --name-only "$BASE_FULL" -- supabase/migrations \
  | grep '\.sql$' \
  | grep -v '/rollback_' \
  | LC_ALL=C sort \
  | while IFS= read -r path; do
      hash="$(git show "$BASE_FULL:$path" | sed 's/\r$//' | sha256sum | cut -d' ' -f1)"
      printf '%s  %s\n' "$hash" "${path#supabase/migrations/}"
    done
