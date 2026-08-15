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
or other users. The verifier opens input files with `O_NOFOLLOW`, validates the
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

The subsequent TASKBOARD-only closure commit must include exactly one marker:

```text
<!-- postdeploy-acceptance-sha256:<the 64 lowercase hexadecimal digest> -->
```

Dispatch `ci` on that exact main SHA with `release_final=true`, the exact
`release_sha`, exact `closure_sha`, and the same `acceptance_digest`.
`check-release-closure.mjs` requires the closure to be the release's single
direct child and sole commit, preserves the complete stable-item inventory and
historical table rows, verifies the TASKBOARD-only commit, and verifies the
marker before the completion gate runs. No source, workflow, schema, policy, or
evidence-verifier edit is allowed in the closure commit.

After the required final job succeeds, complete the release through:

```text
sudo newme-deploy finalize <release-sha> <acceptance-sha256> <closure-sha> <successful-final-run-id>
```

Finalization re-hashes the sealed bundle and every sealed artifact, requires the
stored `acceptance_verified` digest, re-verifies canonical main immediately
before the evidence write, and binds final CI to workflow ID `310914082`, path
`.github/workflows/ci.yml`, its live active workflow identity, exact closure SHA,
ordered timestamps, and the versioned freshness SLO. It also requires the strict
database phase. Only then may it atomically write `release_status=complete`. The
former freeform actor/fixture arguments are not accepted.
