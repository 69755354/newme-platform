# Hosted runner provenance re-review — 2026-10-25

The two existing hosted-runner exceptions expired on 2026-10-24. Repository
validation in [run 40200006109](https://github.com/69755354/newme-platform/actions/runs/40200006109)
correctly stopped at the unchanged provenance gate. This is a seven-day renewal
after checking the actual images, not a bypass or a new exception class.

| Existing label | Image observed in CI | Official immutable inventory |
|---|---|---|
| ubuntu-24.04 | 20261012.334.1 | [7e7dc1b](https://github.com/actions/runner-images/blob/7e7dc1bcc0ef464e5e315a2b4c33609590c6cffe/images/ubuntu/Ubuntu2404-Readme.md) |
| windows-2025 | 20261021.278.1 | [ca1c922](https://github.com/actions/runner-images/blob/ca1c9228ba0cdb8ac41a6f2b2ef44dfd6fe56b2b/images/windows/Windows2025-VS2026-Readme.md) |

The Ubuntu inventory reports OS 24.04.5 LTS, kernel 6.17.0-1022-azure and
PostgreSQL client 16.15, which is already accepted by the replay job's exact
version gate. The Windows inventory reports OS 10.0.26100 Build 33650.
Both image versions match the current CI logs. The official image-tag commits
and their inventories were read directly from actions/runner-images.

Node remains exactly 24.18.0 through the commit-pinned setup action. Existing
action commits, OCI digests, denied install scripts, fixed OS labels and the
45-day policy maximum are unchanged. No `*-latest` label, credential, workflow
permission or additional accepted tool version is introduced. The checker and
its expired/overlong/missing-exception refusal tests are unchanged. The renewed
exceptions expire on 2026-11-01 and must be reviewed again then.

Hosted runner labels remain mutable: an inventory readback does not make the
runner digest-addressable. Existing compensating controls and their residual
risk remain explicit; the new candidate still requires current-head CI success.
