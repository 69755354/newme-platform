# Hosted runner provenance re-review — 2026-11-03

The two hosted-runner exceptions renewed on 2026-10-25 expired on 2026-11-01.
`node scripts/check-ci-provenance.mjs` reports
`provenance exception[0/1] is expired or invalid` and
`tests/security/ci-provenance-gate.test.mjs` fails, so the next release would
stop at the gate (review finding F14). This is a renewal after re-checking the
actual images, not a bypass, a longer policy, or a new exception class.

The underlying condition is unchanged: GitHub-hosted runner labels are mutable
and are not exposed as digest-addressable artifacts, so the exception cannot be
closed by anything this repository controls. It is renewed for 42 days, inside
the checker's 45-day maximum, and must be reviewed again before 2026-12-15.

| Existing label | Image observed in CI | Official immutable inventory |
|---|---|---|
| ubuntu-24.04 | 20261012.334.1 | [799bcd0](https://github.com/actions/runner-images/blob/799bcd0daf03c14c460e2662bcc9ca94a4a8aaa8/images/ubuntu/Ubuntu2404-Readme.md) (20261026.354.1) |
| windows-2025 | 20261021.278.1 | [1c4d727](https://github.com/actions/runner-images/blob/1c4d727f58d448da7f0e975c5fdb16e0459e1d3c/images/windows/Windows2025-VS2026-Readme.md) (20261021.278.1) |

"Image observed in CI" is the last green CI run on `main`
([run 40453614341](https://github.com/69755354/newme-platform/actions/runs/40453614341),
2026-10-27, head 66b58a0). The Ubuntu inventory commit is the newest readme
update for the label (image 20261026.354.1): OS 24.04.5 LTS, kernel
7.0.0-1017-azure, PostgreSQL 16.15, which the replay job's exact `psql` version
gate already accepts. The Windows inventory reports OS 10.0.26100 Build 33650,
the same image version CI ran. Both inventories were read directly from the
`actions/runner-images` commits named in `audit_ref`.

Node remains exactly 24.18.0 through the commit-pinned setup action. Existing
action commits, OCI digests, denied install scripts, fixed OS labels and the
45-day policy maximum are unchanged. No `*-latest` label, credential, workflow
permission or additional accepted tool version is introduced. The checker and
its expired/overlong/missing-exception refusal tests are unchanged.

Hosted runner labels remain mutable: an inventory readback does not make the
runner digest-addressable. The compensating controls (fixed OS family, every
external action and OCI image digest-bound, exact Node, release jobs failing
closed on their required tool versions) and their residual risk remain explicit.
