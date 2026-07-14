# CRM Control Plane

`crm-core-workflow-closeout.json` is the single task-state file for `CRM-CORE-WORKFLOW-PRODUCTION-CLOSEOUT-v1`.

## Hermes Listener

Poll `origin/main` every five minutes, or receive the equivalent GitHub push webhook. Read the state file and its `plan_path`.

When `status` is `READY_FOR_HERMES` and `hermes_status` is `UNCLAIMED`:

1. Create one branch named `hermes/<current_task>-<yyyymmdd>`.
2. Implement only `current_task` following the plan's RED -> minimal fix -> GREEN sequence.
3. Create the required handoff JSON path with all report fields from the plan.
4. Open one Draft PR titled `[HERMES][<current_task>] <short change>`.
5. Do not merge, deploy, run a production migration, or change production data.

The handoff JSON must include `task_id`, `commit`, `changed_files`, `red_evidence`, `green_evidence`, `full_checks`, `ci`, `migration_plan`, `uat`, `risks`, and `requested_decision`.

## Codex Listener

Codex monitors open Hermes PRs and the handoff file. It returns `GO` or `NO-GO` after verifying scope, tests, CI, migration safety and UAT requirements. A `GO` is required before any merge or release action.

## State Values

- `READY_FOR_HERMES`: Hermes may create one implementation PR for `current_task`.
- `AWAITING_CODEX`: Hermes has supplied an eligible handoff and is waiting for review.
- `NO_GO`: Hermes must address the recorded Codex review before continuing.
- `COMPLETE`: the task is merged and evidence is accepted; Codex alone advances `current_task`.

No worker may skip a state or change the current task without a Codex decision committed to `main`.
