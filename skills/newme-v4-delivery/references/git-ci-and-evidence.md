# Git, CI and Evidence

## Exact Git contract

Before editing record the canonical branch and exact base commit/tree. Before publishing verify:

- single intended parent unless the package explicitly requires otherwise;
- compare is ahead by the intended commits and behind by zero;
- diff contains only allowed paths/contracts;
- dependency and lockfile changes are intentional;
- worktree is clean after commit;
- rollback commit/base is named.

If native transport fails twice, stop retrying. A connected Git data API may publish the same verified blobs/tree only after the remote tree equals the local intended tree. Never reconstruct or overwrite unrelated paths from stale content.

## CI contract

Only a run on the exact remote head is same-head evidence. Record workflow/run/job IDs and the steps that actually executed. A skipped build is not build evidence.

For a full candidate require toolchain/dependency provenance, secret/artifact gates, migration/database gates, tenant negatives, type/lint/repository tests, production build and release hygiene.

Classify failure from direct logs:

- code or contract failure;
- runner permission/resource failure;
- network/DNS/registry failure;
- canceled/timeout before the relevant gate;
- unknown with insufficient evidence.

Do not infer a code conclusion from a gate that never started. Do not relabel local evidence as same-head CI.

## PR evidence

Use `assets/pr-body.template.md`. Include Linear/V4 IDs, base/head, scope, behavior, non-goals, data/security/migration impact, positive/negative/idempotency/cleanup evidence, deployment order, risk and executable rollback.

Keep a PR Draft until its required evidence is present. Do not merge while the base is stale, the exact-head CI is not accepted, migration compatibility is unresolved or required environment acceptance is missing.

## Linear evidence

Use `assets/linear-evidence-comment.template.md`. Link immutable GitHub references. State what is not claimed. Ensure the issue status agrees with the evidence and acceptance list.
