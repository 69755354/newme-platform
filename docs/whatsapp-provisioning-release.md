# Provisioning the default-off observer on an already strict database

A later release cannot switch while its deferred observer migration is missing,
and ordinary contract-apply intentionally requires the candidate already live.
Do not resolve that cycle by relaxing migration claims, moving SQL files,
rewriting history, or returning the money mode to compat.

The root coordinator offers two narrowly scoped operations:

    newme-deploy db-transition <main-sha> <successful-run-id> whatsapp-plan
    newme-deploy db-transition <main-sha> <successful-run-id> whatsapp-provision

Both retain the release lock, canonical main, exact-SHA fresh manual CI,
required jobs, taskboard and exact-tree manifest/companion gates. The live
release must permit a successor and be an ancestor of the candidate. The old
release's complete deferred history and runtime posture are verified read-only.
The new read-only gate additionally requires live strict mode, strict-compatible
releases, identical required migrations, and an unchanged deferred prefix with
exactly one suffix: the reviewed hash of 20261019104004. Table presence must
agree with recorded migration history; unrecorded table collisions are refused.
No other SQL hash or future migration is admitted by this operation.

Plan writes nothing. Provision uses the existing transactional deferred-phase
applier, which checks recorded content, version order and the candidate's full
posture. The money contract stays recorded and strict throughout. The two new
tables remain private and channels default to disabled; these operations do not
set runtime secrets, enable capture, connect numbers or send messages.

Install this control-plane capability first from a canonical-main release that
does not yet add the observer suffix. After its exact manual CI passes, use the
normal coordinator bootstrap transaction with contract_verified and the derived
required IDs. This installs the reviewed control plane while retaining the
current application. Then merge the observer release, run its fresh manual CI,
plan/provision the allowlisted suffix and deploy with the unchanged
contract_verified claim. Bootstrap is still gated by actual existing history
and strict posture; an operator-created gate record is not permitted.

The SQL fixture in tests is a byte-exact immutable review artifact, not a second
production migration or an alternative application path. Any future SQL change
needs a new explicit code review and gate policy.
