# Testing Audit — 2026-07-11

## Confirmed gaps addressed
| ID | P | Status | Evidence | Impact | Remediation | Verification |
|---|---:|---|---|---|---|---|
| TEST-001 | P0 | Fixed | `package.json` had no `test` script before Phase 0. | No repository-owned regression command. | Added `npm test` using Node's built-in test runner. | `npm test`. |
| TEST-002 | P1 | Fixed | External `/home/ubuntu/.hermes/scripts/crm-regression.py` is not readable in this environment. | Historical regression source unavailable. | Recorded `BLOCKED_EXTERNAL_SOURCE`; added offline tests under `tests/`. | `test -r ...`; `npm test`. |

## Coverage added
- Unit: stage transition legal/illegal, terminal won/lost protection.
- Security: static IDOR evidence for lead quality, contract detail, payment confirm, task update, pipeline action, settings reassignment.
- Integration/static: period/range and quality input validation evidence.
- Regression DB/static: migration ordering and DB gate evidence.
