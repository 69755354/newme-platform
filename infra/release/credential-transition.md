# Production credential transition

Status: **control-plane procedure only; not executed.** This document never
contains a credential value. Do not paste credentials into a terminal command,
environment variable, standard input, chat, issue, CI log, or deployment record.

## Protected storage and consumers

- The server-side Supabase credential is stored only in
  `/etc/newme/newme-runtime.env`, a regular `root:root` file with mode `0600`.
- `newme-platform.service` reads that fixed file through systemd's
  `EnvironmentFile=` directive. Immutable release `.env.local` files must not
  contain `SUPABASE_SERVICE_ROLE_KEY`.
- The root-owned dependency monitor reads the same fixed runtime file. Its curl
  configuration is a temporary mode-`0600` file and is removed on exit.
- The canonical immutable deploy validates the fixed runtime file, sources it
  only for the candidate runtime and protected verification phases, and passes
  the inherited value to `crm-regression.py`. It does not copy the server key
  into a new release.
- The one-use delivery inbox is
  `/run/newme-credential-inbox/supabase-service-key.env`. Its directory is
  recreated by `systemd-tmpfiles` as `root:root` mode `0700`; the file must be a
  regular, non-symlink `root:root` file with mode `0400` or `0600` and exactly one
  assignment named `SUPABASE_SERVICE_ROLE_KEY`.
- `/etc/newme/migration-db.url` remains the only database URL/password boundary.
  The service-key transition does not read, write, copy, or validate that file.

The versioned asset rollback deliberately preserves the live runtime file, even
when restoring an older backup that listed it. Code rollback therefore retains
the current server credential. The credential controller alone owns rollback of
an interrupted credential cutover.

The repository also contains historical one-off utilities named
`apply_notifications_migration.cjs`, `apply_migrations_0604.cjs`,
`crm-daily-report.js`, and `fix-null-names.py` that read a service key from their
process environment or a legacy `.env.local` path. They are not invoked by the
canonical deploy wrapper, installed systemd/cron control plane, or GitHub
workflows. They are not authorized production consumers and must not be used as
a substitute for the protected database transition or application paths.

## Preconditions

1. Select an exact 40-character commit on canonical `main` and a successful
   `workflow_dispatch` run with `credential_remediation=true` for that exact
   commit. Every success/skipped job in
   `credential-remediation-required-jobs.json` must match exactly. The dedicated
   taskboard job permits exactly one unfinished `predeploy_ready` row:
   `PROD-SECRET-SCANNING-ALERTS-OPEN (BLOCKED)`. Dependabot and CodeQL must already
   be closed. A pull-request, push, ordinary dispatch, or release-final run is not
   enough.
2. Start this exact commit's candidate coordinator from the root-owned canonical
   mirror using the procedure below. The coordinator installs only its reviewed
   credential subset under a durable rollback record, verifies exact bytes and
   service health, and closes that subset transaction before it changes the
   runtime credential. Do not copy an installed file by hand.
3. Confirm that these transaction records are absent:
   `/var/lib/newme/deploy-state/credential-transition.pending.json`,
   `systemd-assets.pending`, and `production-rollback.pending`. If the credential
   record exists, run recovery; do not delete it.
4. In the Supabase project UI, an authorized owner creates the replacement
   server-side key. Do not delete the old key yet. Provider-side key creation and
   deletion require an authorized human or vendor control-plane account; this
   repository cannot perform them.
5. Use an approved root-only local secret-delivery facility to write the
   replacement into the fixed inbox atomically. The facility must write the file
   directly and must not expose the value through command arguments, environment,
   stdin, clipboard history, shell history, or logs. If no such facility is
   available, stop here and establish one; do not improvise a shell command.

Metadata may be checked without reading the value:

```bash
sudo stat -c '%U:%G %a %F' /run/newme-credential-inbox
sudo stat -c '%U:%G %a %F' /run/newme-credential-inbox/supabase-service-key.env
```

Expected results are `root:root 700 directory` and either
`root:root 400 regular file` or `root:root 600 regular file`.

## Protected trust bootstrap

The checked-in policy is deliberately fail-closed until the installed receipt
public key and the four non-secret provider identities have been enrolled by a
reviewed successor commit. `credential-transition` must not be the first command
run on an older production control plane: it requires the installed live helper,
policy, protection marker, and signed precheck machinery that do not exist there.

For the first invocation, fetch only the candidate coordinator from the
root-owned canonical mirror into a root-owned temporary file. The temporary file
starts the candidate's reviewed credential-only asset transaction; it is not
itself installed by hand. This phase does not change the application pointer,
database, or runtime credential.

```bash
set -Eeuo pipefail

sha='<40-lowercase-hex canonical main SHA>'
run='<positive successful credential-remediation workflow run id>'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ "$run" =~ ^[1-9][0-9]*$ ]] || exit 64

coordinator=''
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  [ -z "$coordinator" ] || sudo rm -f -- "$coordinator"
  exit "$rc"
}
trap cleanup EXIT

coordinator="$(sudo mktemp /run/newme-credential-coordinator.XXXXXX)"
sudo chmod 0700 "$coordinator"
sudo git --git-dir=/opt/newme/repository.git show \
  "${sha}:infra/systemd/newme-deploy.sh" | sudo tee "$coordinator" >/dev/null
sudo test -s "$coordinator"
sudo bash "$coordinator" credential-trust-bootstrap "$sha" "$run"
sudo cmp -s "$coordinator" /usr/local/sbin/newme-deploy
```

The expected success record is
`credential_trust_bootstrap=complete ... credential_asset_transaction=none`.
After installation, use the exact no-argument protected status command to obtain
the receipt public key's raw-file and SPKI digests without reading private key
material:

```bash
sudo /usr/local/sbin/newme-production-rollback receipt-key-inspect
```

Create the replacement `secret` API key through the official Supabase Management
API with `reveal=false`; discard its response body after extracting only the
non-secret object ID and type. Enroll that exact ID/type, the other three reviewed
non-secret provider object/scope identities, and the two public-key digests in
`credential-live-attestation-policy-v1.json` in a successor commit.
The successor must reach canonical `main`, pass a fresh exact-SHA
`credential_remediation=true` workflow dispatch, and make `check-policy` pass.
Never edit the installed policy or protection marker by hand, and never use an
all-zero, `UNSTAMPED`, or locally guessed identity.

The stamped successor is a different SHA from the initial bootstrap. Install and
activate that exact successor's helper, policy, and protection marker before any
claim or credential cutover:

```bash
sudo /usr/local/sbin/newme-deploy credential-trust-bootstrap <stamped-successor-main-sha> <successful-successor-run-id>
```

Re-run `receipt-key-inspect` and require both digests to remain equal to the
reviewed pins. The subsequent remediation SHA and CI run are this stamped
successor, not the earlier UNSTAMPED bootstrap SHA.

## Signed cutover to the awaiting boundary

Before invoking the coordinator, provision only the exact old PAT proof input at
its fixed root-owned mode-`0600` policy path. Only after the stamped successor and
its dedicated CI run exist does the installed coordinator fetch the stamped
replacement object from the exact Management API object endpoint with
`reveal=true`. The helper binds the returned object ID/type and raw key bytes in
one provider response, signs the resulting HMAC-only identity receipt, atomically
publishes the sealed credential bundle, and materializes the fixed claim, receipt,
and replacement inbox before `prepare`. No credential value may pass through argv,
environment, stdin, clipboard, shell history, chat, CI output, or a release file.

Run the installed coordinator with only non-secret release evidence:

```bash
sudo /usr/local/sbin/newme-deploy credential-transition <main-sha> <successful-run-id>
```

The coordinator holds `/run/lock/newme-production-release.lock`, re-verifies the
canonical main SHA and the dedicated CI evidence immediately before the subset
transaction and again immediately before cutover. The subset includes the
wrapper, installer/rollback helpers, credential helper, validator, tmpfiles rule,
readiness helper, production-rollback interlock, dependency probe, and root cron.
It excludes the application unit, Nginx, release pointer, migrations, and every
database operation. The helper then:

1. validates fixed-path ownership, modes, file types, and inbox grammar;
2. builds a mode-`0600` candidate runtime file and runs the production validator,
   including both publishable and service REST probes, with all child output
   suppressed;
3. durably saves the prior runtime and a non-secret pending record;
4. atomically renames the candidate over the fixed runtime file;
5. restarts `newme-platform.service`, verifies it is active, and runs local
   readiness;
6. records `awaiting_provider_revocation` in both pending and last records and
   deliberately retains the bound inbox, prior-runtime backup, signed precheck,
   and sealed proof material.

The required success output is
`credential_transition=awaiting_provider_revocation`. It is not a completed
credential remediation and must not be reported as one. Pending and signed
records contain only release identities, timestamps, phases, non-secret provider
identities, and domain-separated digests; protected raw proof inputs remain only
in the root-owned one-use boundaries.

## Provider revocation, alert closure, and signed consumption

While the transition is awaiting and GitHub alerts #1 and #2 remain open, the
authorized Supabase owner must revoke the exact old PAT and delete or disable the
exact old service credential recorded by the stamped policy. The replacement
credential must remain active. Do not close either GitHub alert yet, and do not
restore the prior runtime after provider revocation.

After provider revocation, produce the signed revocation proof. It rechecks the
exact dedicated CI run, protected assets, current service invocation, provider
inventory, privileged consumer reads, and the new-old-new credential probes; an
old credential that still succeeds makes this command fail closed:

```bash
sudo /usr/local/sbin/newme-deploy credential-prove-revocation <remediation-main-sha> <successful-remediation-run-id>
```

Only after that proof succeeds may the authorized operator close GitHub alerts
#1 and #2 as `revoked` in the GitHub UI. The live helper uses the dedicated
read-only Secret Scanning token to verify the two direct alert records and the
fully paginated open-alert set; it never reads the alert secret value and never
uses the Actions-read token for this purpose.

Create the signed completion only after the provider revocation proof and the
truthful GitHub closure both exist:

```bash
sudo /usr/local/sbin/newme-deploy credential-complete <remediation-main-sha> <successful-remediation-run-id>
```

Then create a canonical-main evidence commit that is the direct child of the
remediation SHA and whose only changed path is `TASKBOARD.md`. At this stage the
`PROD-SECRET-SCANNING-ALERTS-OPEN` row must remain `BLOCKED`; record the proof and
alert metadata without falsely closing the row. Run `ci.yml` for this exact
closure SHA with `credential_remediation=true`: the dedicated credential
readiness job must succeed and the ordinary Predeploy job must remain skipped.
An ordinary push/PR run is not sufficient.

The readback is a preview; consumption repeats the fresh live checks while
holding the same canonical release lock before its first cleanup side effect:

```bash
sudo /usr/local/sbin/newme-deploy credential-live-readback <remediation-main-sha> <closure-main-sha> <successful-closure-run-id>
sudo /usr/local/sbin/newme-deploy credential-live-consume <remediation-main-sha> <closure-main-sha> <successful-closure-run-id>
```

Only `credential-live-consume` may call the signed transition finalizer. A
successful consume writes the durable tombstone and `credential-transition.last`
status `complete`, then removes the exact bound pending record, prior-runtime
backup, one-use inputs, and sealed escrow through the crash-recoverable cleanup
path. Re-running the same consume identity is idempotent; a different SHA, run,
attempt, transaction, nonce, or bound input is refused.

Only after successful consumption and live API readback of both alerts as
`resolved/revoked` with open count zero may a later TASKBOARD commit change the
Secret Scanning row to `DONE`. That later commit is not the evidence closure SHA
used by readback/consume.

## Failure and interruption recovery

A validator refusal occurs before live mutation and leaves the inbox available
for a corrected retry. A restart/readiness failure automatically restores the
prior runtime, restarts and rechecks the service, preserves the inbox, and records
`rolled_back`.

After an interruption in the protected asset or runtime transition, run only:

```bash
sudo /usr/local/sbin/newme-deploy credential-recover
```

If power was lost during the subset transaction before the candidate wrapper was
renamed into place, re-extract the same pending SHA's candidate coordinator from
the root-owned mirror using the temporary-file pattern above and invoke that
temporary coordinator with `credential-recover`. The durable pending record is
the scope; never delete it or choose a different SHA by hand.

Recovery uses the same production-release lock. Before the runtime switch it may
restore and verify the prior runtime. After the healthy switch it must preserve
the new runtime and return `awaiting_provider_revocation`; it must not restore a
revoked credential or invent an unsigned `complete` record. The prove,
completion, readback, and consume commands are individually crash-recoverable and
must be re-entered with the same exact arguments. If a command retains an invalid
or recovery-required state, stop release work and investigate; do not delete,
edit, or copy its records. An expired PREPARED transaction that never switched
the runtime may be closed only through the protected
`credential-expire-prepared` command for the same SHA, run, and attempt.

Non-secret awaiting postconditions, required before provider-side revocation, are:

- the service is active and readiness passes;
- the inbox, pending record, and protected backup are present with root-only
  metadata and exact transaction bindings;
- `credential-transition.last.json` has status
  `awaiting_provider_revocation`;
- the production validator passes against the fixed runtime store with
  `--require-runtime-service-key`, including its server-side REST probe; and
- every non-application consumer identified in the pre-rotation inventory has
  either switched to the fixed runtime store and passed its non-secret health
  probe, or has been retired.

The first successful credential trust bootstrap creates the root-only non-secret marker
`credential-remediation.protected.json`. Ordinary application and versioned-asset
rollback must then preserve and revalidate the fixed runtime, service-unit
`EnvironmentFile`, wrapper, transition/rollback helpers, validator, tmpfiles
rule/inbox, dependency probe, and root cron rather than restoring a pre-remediation
copy. Only `credential-recover` may use the exact subset backup to undo an
interrupted subset installation, and that happens before a runtime cutover.

Only after those awaiting postconditions pass may the authorized Supabase owner
delete the old server key in the provider UI. Deletion is irreversible; after it
succeeds, never restore a pre-transition runtime backup. The signed proof and
completion phases re-run service, readiness, dependency, inventory, consumer,
and negative/positive credential checks. The GitHub alerts may be closed as
`revoked` only after the signed provider revocation proof succeeds.

An older immutable release can still contain the now-revoked historical
assignment during the first transition. The fixed systemd runtime value takes
precedence when that release runs, but the old file is not mutated by hand. Once
the alert closure unblocks the release gate, the next protected immutable deploy
must build a current release whose `.env.local` has no service-key assignment;
the production validator must then pass with both
`--require-runtime-service-key` and `--require-no-release-service-key`. A
protected code rollback must also pass readiness without changing the runtime
file. Legacy releases are removed only by the canonical retention/cleanup path.

There is no authorized bypass for the ordinary predeploy alert gate. The dedicated
credential-remediation dispatch and coordinator are the reviewed, narrow path for
closing that circular dependency: they permit only the secret-scanning blocker,
cannot deploy an application or touch a database, and cannot satisfy ordinary
deploy/finalize manifests. Do not reclassify or close the alert merely to unblock
CI.

## Other historically exposed credentials

This controller rotates only the server-side Supabase key.

- Supabase personal access token: no GitHub workflow consumes one. The two legacy
  notification utilities are fail-closed retired stubs; versioned SQL migrations
  are the authorized path. Re-audit for any external/local consumer before an
  authorized account owner revokes the old PAT in the Supabase account UI. Create
  a replacement only if a reviewed management automation still requires one.
- Database password/URL: keep `/etc/newme/migration-db.url` as the fixed root-only
  boundary. Rotation requires an authorized Supabase project owner to reset the
  password in the provider UI and an authorized root operator to atomically update
  that same file through a protected local facility. Coordinate connection drain,
  migration checks, rollback feasibility, and application readiness as a separate
  release-lock transaction; do not combine it with service-key cutover.
- Historically exposed user passwords: each affected identity must receive a new
  independently generated password through an identity-verified channel, then
  have prior sessions revoked and login/role behavior revalidated. This requires
  the account owner or an authorized Auth administrator. Production leaked-password
  protection was enabled on 2026-08-15 and is not evidence that those passwords
  were changed.

GitHub secret-scanning alerts may be closed only after provider-side revocation is
verified. Closing an alert is an evidence-recording step, not revocation. Use the
GitHub UI with the truthful resolution and a non-secret evidence reference; never
copy the detected value into the resolution comment.
