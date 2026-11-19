# Gate slimming: exact install steps

Status: proposal for review. Nothing in this document has been installed. Production, `/usr/local` and
`newme-deploy` are untouched by the pull request that carries it.

## What changed in the repository

| Change | Where | Takes effect |
| --- | --- | --- |
| The acceptance alert drill (and only it) can end as a recorded warning instead of freezing the gate | `scripts/run-postdeploy-acceptance.mjs`, `scripts/verify-postdeploy-acceptance.mjs`, `infra/release/postdeploy-acceptance-policy-v1.json`, `infra/release/postdeploy-evidence-v1.schema.json` | With the next release that contains this change. These files are release-bound: `accept` runs the runner shipped inside the release and `attest` runs the verifier, policy and schema shipped inside it. No host install is needed. |
| 2 s clock-skew tolerance in the alert provider time check (PR #544) | `infra/observability/newme-alert-provider-v1.mjs` | Only after the installed copy is replaced (step 1 below). |
| One-command close | `scripts/release-close.sh` | Immediately, as a command run from a checkout. |
| Visible warning line from `newme-deploy accept` | the diff in step 3 | Only after step 3 is installed. Optional. |

## What stays exactly as strict as before

* Smoke, health, role UAT, browser UAT, fixture cleanup with zero residuals and exact KPI restoration, performance
  thresholds, delayed service/log/restart checks: any failure still freezes the gate
  (`uat_failed` then `accept-recover`, unchanged).
* An interruption, any unexpected non-refusal exception, and any refusal whose code is not in the `alert_*` or
  `delayed_alert_*` namespace freeze the gate.
* Rollback controller, rollback-needed states, `contract_verified`, migration provisioning checks, CI-fresh evidence,
  branch protection, the TASKBOARD-only closure commit, `release_final` CI and `newme-deploy finalize` are not modified.
* A warning cannot be forged into a pass: the signed bundle carries `alert_drill.final_status = "warned"` plus a reason code, the
  delayed `alerts` check is `warned` (never `pass`), and the verifier rejects a warned drill that also carries provider
  receipts, a `warned` check on any other delayed check, or a `warned` check without a warned drill. The policy
  file must contain `allow_recorded_warning: true` and `warning_final_status: "warned"` exactly, or verification fails.
* `scripts/release-close.sh` still opens a pull request, requires every context in `infra/release/branch-protection.json`
  to be green, requires a TASKBOARD.md-only diff, requires the merged commit to be the single closure child of the
  release, requires `release_final` CI at that exact SHA, and ends in the unchanged `newme-deploy finalize`.
  The pull request round trip itself cannot be removed without weakening branch protection, so it is kept; only the fixed
  sleeps and the three manual steps are gone.

## Install steps

Run as an operator with sudo. Back up first (`/root/claude-ops-backups`).

### 1. Alert provider time tolerance (PR #544 content, included in this branch)

The acceptance runner refuses to use `/opt/hermes-scripts/observability/newme-alert-provider-v1.mjs` unless it is
byte-identical to the copy inside the release (`alert_provider_asset_release_mismatch`). With this change that refusal is a
recorded warning, not a freeze, so a stale installed provider would silently turn every drill into a warning. Install it
after the release is built:

```sh
R=/opt/newme/releases/<release-sha>
sudo mkdir -p /root/claude-ops-backups/gate-slim
sudo cp -a /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs /root/claude-ops-backups/gate-slim/
sudo install -o root -g root -m "$(stat -c %a /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs)" \
  "$R/infra/observability/newme-alert-provider-v1.mjs" /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs
sha256sum "$R/infra/observability/newme-alert-provider-v1.mjs" /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs   # must match
```

### 2. Nothing else on the host for the drill change

The producer, verifier, policy and schema arrive with the release. Do not edit `/etc/newme` policy or receipt keys.

### 3. Optional: `newme-deploy accept` prints the warning

`/usr/local/sbin/newme-deploy` is byte-identical to `infra/systemd/newme-deploy.sh` at the time of writing. The diff
below only adds an informational line after a successful `accept`; it changes no gate decision. Review it, then:

```sh
sudo lsattr /usr/local/sbin/newme-deploy            # if an immutable flag is set, stop: that needs Sam's explicit request
sudo cp -a /usr/local/sbin/newme-deploy /root/claude-ops-backups/gate-slim/newme-deploy.orig
sudo cp /usr/local/sbin/newme-deploy /tmp/newme-deploy.new
sudo patch /tmp/newme-deploy.new < newme-deploy-gate-slim.diff     # the diff block below, saved to a file
sudo bash -n /tmp/newme-deploy.new
sudo install -o root -g root -m "$(stat -c %a /usr/local/sbin/newme-deploy)" /tmp/newme-deploy.new /usr/local/sbin/newme-deploy
```

Because the repository's `infra/systemd/newme-deploy.sh` is the source of the installed file, land the same change there in a
follow-up pull request right after installing, so the two do not drift (`infra/release/control-plane-bootstrap.md` installs the coordinator from that file and `cmp`s it against
`/usr/local/sbin/newme-deploy`). Rollback: `sudo install -o root -g root -m <mode> /root/claude-ops-backups/gate-slim/newme-deploy.orig /usr/local/sbin/newme-deploy`.

```diff
--- /usr/local/sbin/newme-deploy	2026-11-19 23:27:35.498079164 +0400
+++ /usr/local/sbin/newme-deploy.new	2026-11-19 23:27:41.511073840 +0400
@@ -1347,6 +1347,21 @@
       ;;
   esac
   sync -f /var/lib/newme
+  # A recorded alert warning (scripts/run-postdeploy-acceptance.mjs, policy alert_drill.allow_recorded_warning)
+  # does not freeze the gate, but it must never pass unnoticed: read it back from the produced bundle and say so.
+  if [ "$ACCEPT_ACTION" = accept ]; then
+    python3 - "/var/lib/newme/postdeploy-intake-v1/$ACCEPT_RELEASE_SHA/bundle.json" <<'PY' || true
+import json
+import sys
+try:
+    with open(sys.argv[1], encoding="utf-8") as handle:
+        alert = json.load(handle)["alert_drill"]
+except (OSError, ValueError, KeyError):
+    raise SystemExit(0)
+if alert.get("final_status") == "warned":
+    print("postdeploy acceptance WARNING: alert drill not verified code=%s (recorded in the bundle; gate not frozen)" % alert.get("reason_code"))
+PY
+  fi
   echo "postdeploy acceptance action=$ACCEPT_ACTION release=$ACCEPT_RELEASE_SHA completed"
   exit 0
   ;;
```

### 4. Using the one-command close

After `attest` prints `POSTDEPLOY_ACCEPTANCE_DIGEST=<digest>`:

```sh
scripts/release-close.sh <release-sha> <digest> <previous-release-sha> "<id>|<headline>" <logdir>
```

Run it from a clean checkout (or set `RELEASE_CLOSE_WORKTREE`). It prints `CLOSE-DONE` after `finalize` succeeds. Exit codes:
2 evidence/bundle mismatch, 3 record or PR problem, 4 a required check is not green, 5 main moved (another commit landed
after the release, so the closure is no longer a single child), 6 `release_final` CI problem, 7 `finalize` refused.
`tools/release_chain.sh` and `tools/release_pr.sh` keep working unchanged; point `release_pr.sh` at this script instead of
`tools/release_close.sh` when convenient.

### 5. How to confirm a warning happened

`newme-deploy accept` prints `postdeploy acceptance WARNING: alert drill not verified code=...` (step 3), the runner writes
`postdeploy producer: WARNING ...` to stderr either way, the sealed bundle shows `alert_drill.final_status: "warned"`, and
`release-close.sh` copies the warning into the TASKBOARD closing record. The journal keeps `alert_drill_warned` and the archived alert
inbox/state under `/var/lib/newme/postdeploy-acceptance-state-v1/<release-sha>/`.
