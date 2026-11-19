# Data-import operations behind the release gate (OS fix S20)

Lets the coordinator write the spreadsheet data into the production database **through
`newme-deploy`**, never by hand. Nothing here has been run against production. This change
contains only the gate operations and checks; it contains **no data and no import program**.

New operations (same entry as the S18 switches):

```
newme-deploy db-transition <main-sha> <ci-run> data-import-plan
newme-deploy db-transition <main-sha> <ci-run> data-import-apply <bundle-sha256> <plan-sha256> --min-leads N --max-leads N [--require-archived-batch <batch-id>]
newme-deploy db-transition <main-sha> <ci-run> data-import-rollback <run-id>
```

Like every additive switch, `newme-deploy` is installed by a release, so **the gate version that
contains these operations has to be released on its own first** (the S18 switch procedure:
merge, CI run on main, `contract_verified` release with the live required list). It changes no
tables and no application behaviour.

## Who runs it

The coordinator, one operation at a time, each only after Sam says "approve release" for that
step (apply and rollback change production data). Sam confirms the bundle hash printed by the plan.

## What lives where

| Thing | Location | Rules |
|---|---|---|
| import program, rollback program, data bundle, `MANIFEST` | `/opt/newme-import/current/` | real directory, root, mode 0700, files root 0600, exactly these four files; **never in git** |
| plan files, run records, program logs, rollback manifests | `/var/backups/newme-import/` (`plans/`, `runs/`, `work/`) | root 0700 directories, 0600 files; contain customer data (logs, before-images) |
| database connection | `/etc/newme/migration-db.url` (existing) | no new secret; handed to the program only as `NEWME_IMPORT_DB_URL` in its environment |
| encrypted backup | `/var/backups/newme-db/` (existing backup unit) | taken by the gate before every apply |

Program contract (the programs are produced outside the repository):

- `import_sheets.mjs --input bundle.json --target production --run-dir DIR [--apply --confirm-production]`; without `--apply` it must make the database refuse writes and write `DIR/plan.json` with a `counts` object (`leads_by_action`, `unarchived_on_match`, `skipped`, `held`, `conflicts`, `to_archive`, `os_leads_unarchived_before`, `expected_unarchived_after`, `notifications_to_create`, `meta_crm_stage_events_to_enqueue`, `tasks_to_create`). With `--apply` it writes `DIR/rollback-manifest.json` (`committed`, `inserted_leads`, `updated_leads`, `before` rows) and commits one transaction.
- `rollback_import.mjs --manifest FILE --target production [--apply --confirm-production]`.
- It reads the database URL from `NEWME_IMPORT_DB_URL`, contains no connection string or password, and resolves `pg` from the `node_modules` next to it (the gate stages a copy of the programs in a root-only work directory and links the live release `node_modules` there).
- The gate never passes `--archive-rest`, `--allow-side-effects`, `--hold-sales-only` or the owner/identity options.

## 0. Prepare `/opt/newme-import` (coordinator, as root)

```
install -d -m 0755 -o root -g root /opt/newme-import
install -d -m 0700 -o root -g root /opt/newme-import/current
install -m 0600 -o root -g root import_sheets.mjs rollback_import.mjs bundle.json /opt/newme-import/current/
(cd /opt/newme-import/current && sha256sum import_sheets.mjs rollback_import.mjs bundle.json > MANIFEST && chmod 0600 MANIFEST)
```
Expected: `ls -la /opt/newme-import/current` shows exactly four files, all `-rw------- root root`, the directory `drwx------`. A dated copy (`current` is replaced, not symlinked) is the way to stage a new bundle.

## 1. Plan (read-only)

```
sudo /usr/local/sbin/newme-deploy db-transition <main-sha> <ci-run> data-import-plan
```
Checks before anything runs: canonical main equals `<main-sha>`, CI evidence fresh, database strict with all deferred migrations recorded, candidate contains the live release, directory/MANIFEST/hash/secret checks. Expected output (numbers vary, no names or phone numbers are ever printed):

```
data-import plan (read-only; nothing was written)
bundle_sha256=<64 hex>
manifest_sha256=<64 hex>
insert=178 unarchive=101 update=0 noop=0 skipped=9 held=5 conflicts=0
total_leads=279 unarchived_before=0 expected_unarchived_after=279
side_effects_planned={"notifications":0,"meta_crm_stage_events":0,"tasks":0}
plan_sha256=<64 hex>
database transition complete release=<sha> run=<ci-run> operation=data-import-plan
```
Sam/coordinator confirm `bundle_sha256` and the counts. `plan_sha256` names the file `plans/plan-<hash>.json` (valid 24 hours).

## 2. Apply

```
sudo /usr/local/sbin/newme-deploy db-transition <main-sha> <ci-run> data-import-apply \
  <bundle_sha256-confirmed> <plan_sha256> --min-leads 270 --max-leads 290 --require-archived-batch <batch-id>
```
Refused (nothing written, no program run in apply mode) when: the expected bundle hash differs from the bundle on disk or from the plan; the plan file hash is wrong or the file was edited; the plan is older than 24 hours; a fresh re-plan gives different counts than the approved plan; the lead total is outside `[min, max]`; the program wants to archive or announces notifications/Meta events/tasks; the required archive batch has no archived leads; the database is not strict; canonical main moved; a MANIFEST, mode or program-secret check fails; or **no new, checksum-verified encrypted backup** could be produced (the gate starts `newme-db-backup.service` itself).

Then: the program runs once in its single transaction, writing `runs/<run-id>/program-run/rollback-manifest.json` and `before-snapshot.json`. The gate re-counts: `notifications`, `meta_crm_stage_events`, `whatsapp_capi_events`, `tasks` must be unchanged, leads must equal before plus inserted, unarchived must equal the plan. Any deviation, a program failure or a missing manifest triggers an automatic rollback with `rollback_import.mjs` and a check that every count is back at the baseline. Expected success output:

```
backup=newme-prod-<stamp>.dump.enc sha256=<hex> bytes=<n>
data-import apply committed
run_id=<uuid>
inserted=178 updated=0 unarchived=101
side_effect_tables_unchanged=notifications,meta_crm_stage_events,whatsapp_capi_events,tasks
rollback with: newme-deploy db-transition <main-sha> <ci-run> data-import-rollback <run-id>
```
Failure output is one line (`apply failed and was rolled back (...); the database matches the baseline; run <id>`). If it says "AND the database is not back at the baseline", stop and restore from the named backup.

## 3. Check

Run `verify_counts.py` (list, cockpit, funnel, analytics must agree with `expected_unarchived_after`), and look at one unarchived old lead and one new lead as Sam/Tanya. Run `data-import-plan` again: expected `insert=0` and `update=0` (idempotent).

## 4. Rollback (needs Sam's explicit approval; this reverts production data)

```
sudo /usr/local/sbin/newme-deploy db-transition <main-sha> <ci-run> data-import-rollback <run-id>
```
Only runs recorded by the gate, newest first (a later run still in place blocks it), with the same rollback program that was hashed at apply time. It previews, applies, then compares all counts with the baseline recorded at apply. Expected: `data-import rollback complete`, `counts_match_baseline=true`. Whole-database restore is a separate, manual step from the backup named in `run.json`.

## Notes and limits

- The gate cannot hold the program's transaction open, so the four-table check happens right after the commit and is repaired by the rollback program, not by withholding the commit. The program also checks the same tables inside its own transaction.
- Only one data-import operation can run at a time (`/var/backups/newme-import/.lock`); a crashed run leaves the lock and a `run.json` in state `started` that `data-import-rollback` can still process.
- Checks without a server: `node scripts/check-s20-import-gate.mjs --import-dir DIR --repo-root .` (the repo test also asserts that no program, bundle or run artifact is tracked).
- The migration database role is used for writing. Plan runs read-only; if that role cannot write `leads`, apply fails before changing anything (and rolls back).
