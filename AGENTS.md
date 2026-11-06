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

## Database migration conventions

- Row-level-security policies that check the session must wrap the check:
  `(select public.session_token_is_current())`, never a bare
  `session_token_is_current()`. The S2b release gate asserts that no policy in
  `public` (other than on `profiles`) contains the unwrapped call, and refuses the
  release when one does.
- Never edit an existing migration file; the S2b gate pins the hash of
  `20261104110000_role_least_privilege.sql`.
