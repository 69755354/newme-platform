<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:taskboard-gate -->
# ⛔ MANDATORY: Read TASKBOARD.md before ANY code changes

## Iron Rule (non-negotiable)

**Before writing, modifying, or reviewing ANY source code in this project:**

1. `cat TASKBOARD.md` — read the full task board
2. `npm run check:taskboard` — run the cross-platform verification (the shell checker remains the Linux deploy gate)
3. If any ❌ items exist → those are your priority. Do NOT write new features until all ❌ are resolved.
4. After completing a task → update TASKBOARD.md status from ❌ to ✅ with date
5. Before commit → run `npm run check:taskboard` again to confirm progress

## Why this exists

MoA Tier 1 had 8 tasks. Only 2 were completed because the audit results were
"saved in a file" that nobody re-read. **If it's not in TASKBOARD.md, it doesn't exist.**

## Deploy is physically blocked

`scripts/deploy.sh` Step 0 runs `check-taskboard.sh`. Any ❌ = deploy aborts.
`git push` is blocked by pre-push hook. `--no-verify` bypass is logged.
<!-- END:taskboard-gate -->
