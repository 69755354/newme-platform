# P0 — Full Remote Branch Inventory Before CRM Takeover

## Authority and scope

This task is a **strictly read-only repository audit**. It overrides stale workflow wording that says Hermes must be used or that unrelated TASKBOARD items must be completed first. Do not modify TASKBOARD.md, source code, configuration, branches, GitHub settings, production, databases, services, or deployment state.

Repository: `69755354/newme-platform`
Audit baseline: `origin/main`

Known branch names observed externally:
- `main`
- `feat/crm-v2`
- `feat/crm-v3`
- `codex/crm-takeover-bootstrap-20260710`

Do not assume this list is complete.

## First: prove what repository snapshot you received

Run and report raw output:

```bash
pwd
git status --short --branch
git branch --show-current
git rev-parse HEAD
git remote -v || true
git show -s --format='%H|%cI|%an|%s' HEAD
```

Codex Cloud may name the temporary local branch `work`. That is acceptable. The important facts are the checked-out commit SHA and its relation to `origin/main`.

## Discover every available branch

Run:

```bash
git fetch --all --prune || true

echo '=== LOCAL BRANCHES ==='
git for-each-ref \
  --sort=-committerdate \
  --format='%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(authorname)|%(subject)' \
  refs/heads/

echo '=== REMOTE BRANCHES ==='
git for-each-ref \
  --sort=-committerdate \
  --format='%(refname:short)|%(objectname)|%(committerdate:iso8601)|%(authorname)|%(subject)' \
  refs/remotes/

echo '=== ALL REFS ==='
git show-ref --heads --remotes 2>/dev/null || git show-ref

echo '=== REMOTE HEAD ==='
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true
```

If `git fetch` is blocked, do not stop. Inventory all refs already present in the clone and explicitly mark `FETCH_STATUS=BLOCKED` and `REMOTE_INVENTORY_MAY_BE_INCOMPLETE=YES`.

## Compare every discovered branch to main

Resolve the main ref in this order:

1. `refs/remotes/origin/main`
2. `refs/heads/main`
3. otherwise mark the audit blocked and report all available refs without guessing.

For every discovered non-main branch, run the equivalent of:

```bash
git rev-list --left-right --count MAIN_REF...BRANCH_REF
git merge-base MAIN_REF BRANCH_REF
git log --oneline --decorate MAIN_REF..BRANCH_REF
git diff --name-status MAIN_REF...BRANCH_REF
git merge-base --is-ancestor BRANCH_REF MAIN_REF
```

Interpret `git rev-list --left-right --count MAIN_REF...BRANCH_REF` as:
- first number = commits only in main (`branch behind main`)
- second number = commits only in branch (`branch ahead of main`)

For branches with unique commits, inspect every unique commit sufficiently to classify whether it contains:
- security fixes
- database migrations
- production hotfixes
- deployment/control-plane changes
- tests
- documentation only
- generated files, logs, or build artifacts
- changes already recreated differently in main

Do not merge, cherry-pick, rebase, reset, create branches, delete branches, commit, or push.

## Required final report

```text
REPOSITORY:
CWD:
LOCAL_CHECKOUT_BRANCH:
LOCAL_HEAD:
ORIGIN_MAIN_HEAD:
LOCAL_HEAD_MATCHES_ORIGIN_MAIN: YES/NO/UNKNOWN
FETCH_STATUS: PASS/BLOCKED/FAILED
REMOTE_HEAD_TARGET:
TOTAL_LOCAL_BRANCHES:
TOTAL_REMOTE_BRANCHES_VISIBLE:
REMOTE_INVENTORY_MAY_BE_INCOMPLETE: YES/NO

BRANCH_MATRIX:
- BRANCH:
  REF:
  HEAD:
  LAST_COMMIT_DATE:
  LAST_AUTHOR:
  LAST_SUBJECT:
  AHEAD_OF_MAIN:
  BEHIND_MAIN:
  MERGE_BASE:
  UNIQUE_COMMITS_COUNT:
  UNIQUE_COMMITS:
  UNIQUE_FILES:
  IS_ANCESTOR_OF_MAIN: YES/NO
  FULLY_CONTAINED_IN_MAIN: YES/NO
  CHANGE_CLASSIFICATION:
  RISK:
  RECOMMENDATION: KEEP / MERGE_REVIEW / CHERRY_PICK_REVIEW / ARCHIVE / DELETE_CANDIDATE

UNMERGED_HIGH_VALUE_CHANGES:
DIVERGED_BRANCHES:
FULLY_MERGED_OLD_BRANCHES:
DELETE_CANDIDATES:
UNKNOWN_ITEMS:
GO_NO_GO_FOR_BRANCH_AUDIT_COMPLETENESS:
GO_NO_GO_FOR_CRM_TAKEOVER:
```

## Judgment rules

- A branch name containing `v2`, `v3`, `prod`, or `main` is not evidence of freshness.
- Do not claim a full branch audit if fetch is blocked and remote refs may be missing.
- Do not treat `work` as a real repository branch unless it exists under refs/heads or refs/remotes in the source repository.
- Do not use CRM-V2-ISSUES.md as a substitute for this task.
- Do not modify any file, including this task file.
- No build or tests are required; this is Git history analysis only.
