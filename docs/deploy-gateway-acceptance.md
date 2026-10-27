# HTTPS access to canonical postdeploy acceptance

The production operator provides the bridge at `https://app.newme.ae/bridge`.
It executes the existing root coordinator; it does not replace the acceptance
policy or provide an arbitrary shell. The operator owns the gateway installation
and public-key registry. Cloud tasks keep their own Ed25519 private key in an
owned `0600` file outside Git. A personal Bitwarden session is unnecessary.

## Requests

`POST /acceptance` accepts exactly one of these closed request shapes:

```json
{"action":"accept","release_sha":"<40 lowercase hex>"}
{"action":"attest","release_sha":"<40 lowercase hex>"}
{"action":"finalize","release_sha":"<40 lowercase hex>","acceptance_sha256":"<64 lowercase hex>","closure_sha":"<40 lowercase hex>","final_run_id":"<positive integer string>"}
```

The controlled recovery actions `accept-recover`, `accept-abort`,
`attest-recover`, and `attest-abort` use only `action` and `release_sha`.
Choose recovery from the actual pending state; never repeat a mutation merely
because its connection was lost. The bridge invokes fixed argument arrays for
`sudo /usr/local/sbin/newme-deploy`, validates arguments, and refuses concurrent
mutations with HTTP 409. It must not accept commands, paths or credentials.

Send `X-Newme-Timestamp` as the current Unix time in seconds and
`X-Newme-Signature` as base64 of the Ed25519 signature over the exact bytes
`timestamp + "." + raw_body`. Sign the same JSON bytes that are transmitted.
The timestamp window is 300 seconds. The signed action in the closed body binds
the operation. Signed status uses the distinct message
`timestamp + ".GET /status"`.

## Long operations and continuation

The response is NDJSON. Save the `X-Newme-Run-Token` response header immediately
in an owned `0600` receipt. Output events contain `line`; idle heartbeats arrive
every 15 seconds. The final event contains the process `exit_code` and duration.
A disconnected client does not terminate the server process.

Continue reading with `GET /acceptance-log?run_token=<token>&offset=N`.
Sign the exact original query order and encoding using
`timestamp + ".GET /acceptance-log?" + raw_query`. The response contains
`lines`, `next_offset`, `eof`, and `exit_code`. Resume from `next_offset`.
`eof: true` can mean only that the current buffer is exhausted while the
operation is still running; a null `exit_code` is not completion. Read-only log
continuation never submits another acceptance operation.

Never record private keys, signature headers, role credentials, database URLs,
provider tokens or unredacted business data in the receipts. A run token alone
does not authorize a request; log reads require the registered signing key.

## Release state and closure

Follow [the canonical acceptance runbook](../infra/release/postdeploy-acceptance.md):
deploy leaves `awaiting_uat`; `accept` produces the real ready evidence bundle;
`attest` verifies and seals it as `acceptance_verified`; the TASKBOARD-only
direct-child closure, successful exact-closure final CI and `finalize` are all
required for `complete`. A successful gateway response does not replace those
checks. The canonical coordinator retains its production lock and recovery rules.

Before an ordinary successor deployment, archive any prior active TASKBOARD
acceptance marker as historical prose, retaining its full digest and source
commit. Check the prepared TASKBOARD with `auditTaskboardClosureTransition`
using a separately labelled synthetic future marker kept outside committed
evidence. This proves closure shape only, not production acceptance. Never edit
an immutable deployed release or weaken the verifier to replace an inherited
marker. If the deployed release already inherited a prior marker, first attest
its real evidence, then use the existing reviewed accepted-release supersession
path; that release must not be described as finalized.
