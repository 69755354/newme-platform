# Postdeploy acceptance v1

This is the only completion path for a protected NewMe release. Deployment
success leaves `deploy-*.json` at `release_status=awaiting_uat`; neither an
operator statement nor a successful deployment changes that state to complete.

## Provision the protected acceptance boundary

Before the protected control-plane install, provision
`/etc/newme/postdeploy-alert-provider-v1.json` from the approved root secret
inbox. It must be a regular, non-symlink, `root:root` file with mode `0400` or
`0600`. The installer validates the configured provider identity through the
provider API and refuses the install if it cannot do so. Provider tokens,
acceptance role credentials, database URLs, and receipt signing material remain
in their fixed root-only files; they are never accepted through command-line
arguments or environment variables and must not be copied into evidence.

The drill uses the same versioned transition chain as the production probes:
`hermes-alert-state-v1.sh` → `hermes-alert-notifier-v1.sh` → provider. Its
release-specific key is held in the separate root-only
`/var/lib/newme/hermes-alert-v1/postdeploy/<release-sha>` directory, is required
to transition `ok → firing → ok`, and is removed after a verified recovery; it
cannot change the health, login, or dependency probe state. The notifier accepts
only its ordinary three-argument contract. Drill mode, release identity, and the
fresh trigger digest are passed through a sanitized state-machine environment
and must exactly match the notifier source and summary, so the former direct
five-argument provider path is rejected.

The installed `newme-alert-provider-v1.mjs` is the canonical final provider for
both ordinary production probes and this drill; the notifier has no fallback to
an external source library. Ordinary alerts use `notify` mode, require the exact
provider delivery acknowledgement, and neither read acceptance credentials nor
write acceptance receipts. Drill context alone enables receipt mode. Each
failure/recovery receipt binds the exact challenge that crossed
the state and notifier stages. Its provider response identifies the exact
delivered message. Delayed verification edits and reads back that same recovery
message after a fresh unpredictable challenge is created; a second unrelated
message, a provider no-op, or a pre-positioned future receipt cannot satisfy the
gate.

## Produce the redacted bundle

The fixture's Lead rows carry `source = other`, exported as `FIXTURE_LEAD_SOURCE`
and bound by contract test to the closed taxonomy `leads_source_check` defines.
Fixture rows are identified by their `marker` in `customer_name` and `notes`, so
`source` carries no identification duty; an invented value such as
`postdeploy_uat` merely made the seed unrunnable against production, where that
constraint has always been in force.

Use `infra/release/postdeploy-evidence-v1.schema.json` and
`infra/release/postdeploy-acceptance-policy-v1.json`. The bundle must bind the
deployed release SHA, build ID, release-candidate GitHub Actions run ID and
deployment timestamp exactly as they appear in the deployment evidence. It must
contain all of the following machine-readable results:

- distinct successful `admin`, `boss`, `operator`, and `sales` actors;
- every policy-listed business flow;
- identical non-empty fixture-created and fixture-cleaned UUID sets, with zero
  residual rows;
- different failure and recovery alert event IDs, with the final state `ok`;
- at least 20 latency samples, exact nearest-rank p75/p95 values, and values no
  greater than the versioned thresholds;
- a delayed verification whose `not_before` is at least 15 minutes after the
  recorded deployment and whose `completed_at` is not earlier than that bound;
- exactly four `role_uat` JSON artifacts and one JSON artifact for each of
  fixture cleanup, the alert drill, performance, and delayed verification;
- exactly eight `browser_uat` JSON artifacts in the closed order
  `admin-en`, `admin-zh`, `boss-en`, `boss-zh`, `operator-en`, `operator-zh`,
  `sales-en`, `sales-zh`, each backed by seven redacted PNG screenshots and a
  closed JSON trace. All eight summaries, signed payloads, and traces bind the
  same exact browser lead UUID, contract UUID, and synthetic-marker SHA-256;
- exactly sixteen top-level JSON artifacts in total, each named by a relative
  path and exact SHA-256. The browser evidence tree contains exactly the eight
  JSON artifacts, eight traces, and 56 screenshots declared by those artifacts.

The `role_uat` artifacts are the canonical UAT result format. Each one binds an
exact runner version and unique runner run ID to the deployed release, one
actor UUID, ordered login/refresh/authorization/logout checks, and that role's
exact required flows. Each flow result must carry one or more request IDs and
fixture UUIDs plus the policy-defined readback assertions. Every assertion must
be `pass`, name a request and fixture from the same flow transcript, carry a
2xx HTTP status, and complete inside the authenticated flow interval. A prose
note, an unbound screenshot, a generic Playwright report, or an arbitrary
`{status:"pass"}` file is not acceptance evidence. In addition to the API flow
artifacts, the canonical browser runner must exercise all four roles in both
supported locales with all fourteen ordered policy steps present. Those steps
prove the localized login and navigation copy, the exact synthetic lead card,
admin/boss bulk controls and operator/sales denial, the exact lead detail and
contract list entries, management Settings access and sales denial, an actual
English/Chinese content switch and restore, logout, and post-logout denial. The
browser subject UUIDs must also appear in both the fixture-created and
fixture-cleaned sets. There may be no
conditional skips, no page or console errors, no failed critical response, and
no overflow, overlap, or untranslated key. The verifier re-hashes the redacted
screenshots and closed traces and binds them to the signed browser artifacts.
Screenshots preserve the specific static English or Chinese copy and synthetic
subject marker needed for review while masking account identity, input values,
images, and non-subject business rows.
The repository's general Playwright suite is not this evidence producer and
cannot satisfy this gate.

Every object is closed by the schema (`additionalProperties: false`). The
verifier also performs the same closed-shape checks directly, checks the policy
and schema byte digests, parses every artifact against the versioned artifact
definitions in the same schema, cross-checks every artifact field against the
bundle, re-hashes every artifact, and rejects symlink or path escape attempts.
Evidence artifacts must contain no credentials or unredacted customer data.

Run the producer only through the canonical coordinator, which shares
`/run/lock/newme-production-release.lock` with deploy, database transitions,
attestation, finalization, and rollback:

```text
sudo newme-deploy accept <release-sha>
```

The protected deployment path prepares the exact digest-pinned Playwright
image before switching the application release. Acceptance later uses that
already verified image with `--pull=never`, a read-only container, the
unprivileged image user plus only the release tree's read group, all Linux
capabilities dropped, and `no-new-privileges`. The exact immutable release tree
is mounted read-only. Role credentials and receipt signing material cross the
container boundary only through standard input; they are not placed in
arguments, environment variables, logs, traces, or screenshots. The browser
runner aborts requests outside `https://app.newme.ae` and the versioned public
Supabase data origin required by the browser client.

The producer writes a durable root-only journal before fixture creation, records
each exact fixture step, uses canonical business reversal for a confirmed UAT
payment, verifies the affected KPI returns to its exact baseline, completes all
eight browser sessions while the exact browser fixtures still exist, proves the
fixture inventory was not changed by the browser journey, then performs exact-ID
cleanup and proves zero residual rows. It publishes
only to the fixed
`/var/lib/newme/postdeploy-intake-v1/<release-sha>/bundle.json` path. A failed or
interrupted run blocks a new acceptance or release operation until one of these
controlled actions succeeds:

```text
sudo newme-deploy accept-recover <release-sha>
sudo newme-deploy accept-abort <release-sha>
```

Recovery re-measures the exact planned fixture inventory, preserves and reports
already-missing objects, refuses unexpected or foreign objects, performs the
business reversal when required, archives any isolated drill state, and proves
zero residual rows. Abort is allowed
only after the same cleanup proof. Neither mode fabricates a ready bundle.

## Verify and seal the bundle

The canonical producer creates the bundle and artifacts in a root-owned `0700`
directory and makes every input file root-owned and `0400` or `0600`. Every
ancestor directory to `/` is required to be root-owned and non-writable by group
or other users. Group *ownership* of an ancestor is not constrained, because the
immutable release tree — which holds the deployment evidence the producer reads —
is `root:<service group>` mode 0550 by contract, and the acceptance container
reads that tree through exactly that group. A directory nobody but root may write
cannot have its entries changed, whoever may read it. The verifier opens input files with `O_NOFOLLOW`, validates the
opened descriptor with `fstat`, and reads from that same descriptor. It accepts
only the fixed intake path and a journal in the exact `ready` state:

```text
sudo newme-deploy attest <release-sha>
```

The mode verifies the versioned policy, schema, release/build/run/time binding,
and every artifact before copying the already-read bytes into the current
release's content-addressed `.audit/postdeploy-acceptance-v1` directory. It then
atomically seals the full directory, changes the deployment evidence to
`acceptance_verified`, and prints `POSTDEPLOY_ACCEPTANCE_DIGEST=<sha256>`. A retry
is idempotent only for the same sealed bytes. If a process interruption leaves a
pending seal transaction, use exactly one of the protected recovery modes:

```text
sudo newme-deploy attest-recover <release-sha>
sudo newme-deploy attest-abort <release-sha>
```

`attest-recover` completes only an exact, fully reverified pending transaction;
`attest-abort` removes only an unverified pending transaction so production can
rerun the producer and ordinary attestation.

## Bind closure and final CI

The subsequent TASKBOARD-only closure commit must append exactly one new marker
(markers left by earlier releases' closures stay in the append-only history):

```text
<!-- postdeploy-acceptance-sha256:<the 64 lowercase hexadecimal digest> -->
```

Dispatch `ci` on the current main SHA with `release_final=true`, the exact
`release_sha`, the exact `closure_sha`, and the same `acceptance_digest`. When
main head is the closure commit itself, leave `final_sha` empty (it defaults to
`closure_sha`). When other commits have landed after the closure record, pass
`final_sha` = the current main SHA; the workflow refuses unless `final_sha` is
the exact SHA it runs on.

`check-release-closure.mjs` applies two rules:

- the closure record (`closure_sha`) must be the release's single direct child
  and sole commit, preserve the complete stable-item inventory and historical
  table rows, change nothing but TASKBOARD.md, and append exactly one marker
  naming the attested digest. No source, workflow, schema, policy, or
  evidence-verifier edit is allowed in the closure commit;
- the final-run commit (`final_sha`) is the closure itself, or a later linear
  descendant of it such that every commit in `closure_sha..final_sha` is a
  non-merge commit changing only non-runtime paths: `TASKBOARD.md`, `*.md` at
  the repository root, `docs/**`, `.claude/**`, and `crm-v3/SPEC.md`
  (`CLOSURE_DRIFT_ALLOWED_PATHS`). `src/`, `supabase/`, `scripts/`, `infra/`,
  `.github/`, `tests/`, `public/`, `package.json`, `package-lock.json`, and every
  path not on the allowlist are refused by name. The closure's marker must still
  appear exactly once in TASKBOARD.md at `final_sha`, and the completion gate
  runs on the `final_sha` taskboard.

A documentation or agent-configuration pull request merged between the closure
record and the final CI run therefore no longer consumes the release's closure
slot. A commit that changes anything the application, the database, the deploy
path, or CI runs still does, because a green run on that tree proves nothing
about the deployed release.

After the required final job succeeds, complete the release through:

```text
sudo newme-deploy finalize <release-sha> <acceptance-sha256> <closure-sha> <successful-final-run-id> [<final-run-sha>]
```

`<final-run-sha>` is required exactly when it differs from `<closure-sha>`; it
must equal canonical main and the SHA the final run was dispatched on.
Finalization re-hashes the sealed bundle and every sealed artifact, requires the
stored `acceptance_verified` digest, re-verifies canonical main immediately
before the evidence write, re-measures both rules above with the deployed
release's own copy of `check-release-closure.mjs`, and binds final CI to
workflow ID `310914082`, path `.github/workflows/ci.yml`, its live active
workflow identity, the exact final-run SHA, ordered timestamps, and the
versioned freshness SLO. It also requires the strict database phase. Only then
may it atomically write `release_status=complete`, recording `closure_sha`,
`final_sha`, and `final_ci_head_sha` (= `final_sha`) under `release_closure`.
The former freeform actor/fixture arguments are not accepted.

Because finalize runs the checker and evidence finalizer shipped inside the
deployed release, a release cut from a tree that predates the tolerant rule can
only be closed under the single-slot rule: the coordinator passes `--final-sha`
and the fifth evidence argument only when the final-run SHA differs from the
closure SHA, so such a release still finalizes when main head is its closure
commit, and the supersession rule below treats any commit after that closure as
consuming its slot (it checks whether the live release's own checker knows
`--final-sha`). Supersede it as described below; do not wait for a closure that
release cannot accept.

## When the closure slot is already gone

The closure record must be the release SHA's single direct child, and main is
append-only, so a release has exactly one chance to record its closure and that
chance is destroyed by any other commit landing first. The slot is also consumed
when, after a valid record, a commit touching a runtime path lands before the
final CI run (non-runtime commits are tolerated, see above). `release_status`
then stops at `acceptance_verified` for good, and because an ordinary deployment
once required the live release to be `complete`, nothing could be deployed
afterwards either -- a frozen control plane, reached on 2026-09-11 when the
runner provenance exceptions expired on 2026-09-01 and the only way to make main
mergeable again was a pull request that consumed 8373de8's closure slot.

`verify_live_release_permits_new_release()` in `infra/systemd/newme-deploy.sh`
separates the two states that rule conflated, and
`tests/release/live-release-supersession.test.mjs` executes both:

- the closure is still reachable -- the first commit after the live release is a
  TASKBOARD.md-only single child adding exactly one acceptance marker, every
  later commit up to the candidate is a non-merge commit changing only
  `closure_drift_path_allowed` paths (the shell twin of
  `CLOSURE_DRIFT_ALLOWED_PATHS`), the live release's own checker understands
  `--final-sha` whenever such later commits exist, and that marker is still
  present exactly once in the candidate's TASKBOARD.md -- so the release was
  merely not finalized yet: refused, finalize it with the candidate as
  `<final-run-sha>`;
- the candidate contains the live release but the slot is provably consumed (a
  non-TASKBOARD first commit, a merge, any runtime path after the record, a
  live release whose checker predates `--final-sha`, or a marker finalize could
  not accept -- the last three are explained on stderr) and the live release is
  `acceptance_verified`: the deployment proceeds and prints
  `superseded_release=<sha> superseded_status=... closure_slot=consumed`, which is
  the release's closing record in place of a TASKBOARD marker it can never carry.

A live release that was never attested (`awaiting_uat`, `uat_failed`) is still
refused: there is no verified production evidence to supersede. Its exit is
`newme-production-rollback execute <reason>`, whose `release_recovery`
transaction undoes it.

The order that avoids all of this: record the closure before merging anything
else, run final CI promptly, and renew `infra/ci/provenance-exceptions.json`
well before its 45-day expiry, so the calendar never forces a runtime commit
between a release and its closure.

## Prepare a later application release

Before deploying a later application release, inspect TASKBOARD.md for the active marker from a previously completed release. In the ordinary reviewed application-preparation commit, archive that marker as plain historical prose while retaining its complete digest and the source commit. Do this before deployment: the closure commit must preserve the candidate history exactly and append its sole fresh marker. Never edit an immutable deployed release, erase the old digest, or relax the closure checker to make a stale marker pass.

If a deployed candidate already inherited a prior active marker, complete and attest its authentic acceptance evidence first. Then use the existing accepted-release supersession path for a reviewed successor whose preparation archives the stale marker; the superseded candidate must not be described as finalized. Validate the successor TASKBOARD against auditTaskboardClosureTransition with a separately labelled synthetic future marker before publishing the preparation change. This validation is not deployment or acceptance evidence.
