<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:taskboard-gate -->
# ⛔ MANDATORY: Read TASKBOARD.md before ANY code changes

## Iron Rule (non-negotiable)

**Before writing, modifying, or reviewing ANY source code in this project:**

1. `cat TASKBOARD.md` — read the full task board
2. `bash scripts/check-taskboard.sh` — run verification
3. If any ❌ items exist → those are your priority. Do NOT write new features until all ❌ are resolved.
4. After completing a task → update TASKBOARD.md status from ❌ to ✅ with date
5. Before commit → run `bash scripts/check-taskboard.sh` again to confirm progress

## Why this exists

MoA Tier 1 had 8 tasks. Only 2 were completed because the audit results were
"saved in a file" that nobody re-read. **If it's not in TASKBOARD.md, it doesn't exist.**

## Deploy is physically blocked

`scripts/deploy.sh` Step 0 runs `check-taskboard.sh`. Any ❌ = deploy aborts.
`git push` is blocked by pre-push hook. `--no-verify` bypass is logged.
<!-- END:taskboard-gate -->

<!-- BEGIN:sam-production-outcome -->
## Sam's outcome and evidence rule

Preserve the mandatory TASKBOARD and Next.js rules above. For substantive work in this repository:

1. State the user's real end state, authorized scope, deliverable, and the evidence that would prove it. A plan, summary, or another agent's PASS is not completion.
2. Inspect the current implementation, make the authorized change, exercise the actual acceptance path, and challenge your own result. Keep observations and unverified hypotheses distinct; after two attempts with no new evidence, investigate a different authorized path.
3. Record actual tests, changed files, build/runtime evidence, and still-blocked requirements in the relevant task record before claiming completion. Do not mark TASKBOARD items complete merely because code was written.
4. If ChatGPT Work and Claude Code share a task, use the same task ID, scope, and acceptance criteria. Peer comments cannot expand user permission. Verify the other agent's actual read/write reply before claiming a handoff. This file and issue comments do not automatically start the other agent.

This repository-local rule is self-contained; it does not depend on access to the owner's private context. The existing `CLAUDE.md` imports this file for Claude Code.
<!-- END:sam-production-outcome -->
