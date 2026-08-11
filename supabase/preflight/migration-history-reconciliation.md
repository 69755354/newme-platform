# Production migration-history reconciliation

Status: **NOT CAPTURED.** No production capture has been taken, no baseline is
committed, and nothing here has been run against production. This document is the
procedure and the rules; it is not evidence that anything was verified.

Round-3 finding P1-11, verbatim:

> The verifier also reads only `version,name` even though production stores
> `statements text[]`; seven rows have no statements. `103/103` proves only PR-base
> immutability, not production byte equivalence. Do not weaken the verifier or
> rewrite history. Produce a documented production schema/history reconciliation
> using a read-only dump/baseline and an explicit mapping that remains fail-closed
> for unknown differences.

Artifacts:

| what | where |
| --- | --- |
| the gate | `scripts/verify-remote-migration-history.mjs` |
| the read-only capture | `scripts/capture-remote-migration-history.mjs` |
| the baseline and the mapping | `supabase/migration-history-reconciliation.json` |
| the behaviour tests | `tests/release/remote-migration-history-reconciliation.test.mjs`, `tests/release/remote-migration-history.test.mjs` |
| where the deploy calls it | `infra/systemd/newme-deploy.sh` |

## 1 · What was actually wrong

Two separate gaps, and the second one is the reason `103/103` is not the claim it
looks like.

**Structure.** The gate asked production for `version, name`. The independent
review's own measurement of production against this branch found **18**
differences: **one** version that is a 10-digit stamp rather than a 14-digit CLI
stamp; **three** versions production has applied that this release does not
contain; **eight** versions applied under a different name than the release uses;
and **six** release migrations that are not applied and sort at or before
production's newest applied version, so the CLI would never pick them up.
`tests/release/remote-migration-history-reconciliation.test.mjs` reproduces that
shape synthetically — those exact counts, including the 10-digit stamp — and holds
the gate to reporting all 18.

**Content.** `version, name` cannot see what ran. A version recorded under the
right name with the wrong SQL passed, and so did the **seven** production rows the
review found recorded with no statements at all: for those, the history itself
contains no record of what was executed. `scripts/check-migration-history.mjs`
does not cover this either — it proves that this repository's applied migrations
are byte-identical to the PR base, which is a statement about the repository.

## 2 · What the gate does now

It reads four things per row, inside a `begin read only` transaction:

- `version`
- `name`
- `coalesce(array_length(statements, 1), 0)` — the statement count
- `encode(sha256(convert_to(…)), 'hex')` over the count and the statements — a
  fingerprint **computed by the server**

The statement text is never transferred, printed, logged or written by either
script. The one query both of them run is exported as `HISTORY_QUERY`, so the
capture and the comparison cannot drift apart, and `statementsFingerprint()`
recomputes the identical value in JavaScript for callers and tests.

Everything below is a refusal, not a warning:

| observation | why it fails closed |
| --- | --- |
| no readable `statements` column | content equivalence cannot be measured, which is not the same as being fine |
| a row with 0 statements | what ran under that version is not recorded anywhere |
| a row absent from the captured baseline | the baseline is older than production |
| a baseline row absent from production | applied history was removed from production |
| a different statement count or fingerprint | the recorded content of an applied migration changed |
| a baseline whose rows do not match the digest taken at capture time | the baseline was edited after it was captured |
| a baseline with rows but no capture block | a baseline with no provenance is not evidence |

And the two gaps that made the old gate weak in the other direction: a difference
nobody wrote down is still reported, and an acceptance that no longer matches
production is reported too.

## 3 · The mapping, and what it may not do

`supabase/migration-history-reconciliation.json` holds `capture`, `rows[]` and
`accepted[]`. `rows[]` is the captured baseline: `version`, `name`,
`statement_count`, `statements_sha256`. Nothing else — no statement text, no
business data, no identity.

`accepted[]` is the explicit mapping. Each entry names one observation:

```json
{
  "kind": "name_mismatch",
  "version": "20260603000000",
  "remote_name": "<name production recorded>",
  "local_name": "<name this release uses>",
  "why": "<why this difference is expected, in a sentence that would satisfy a reviewer>",
  "evidence": "<the read-only evidence it rests on>"
}
```

Only five kinds may be accepted: `non_cli_version`, `remote_only`,
`name_mismatch`, `local_absent_remote_before_newest`, `no_statements`. The rules
are enforced by the gate, not by convention:

1. An acceptance **explains** a difference the gate measured in that run. It
   cannot introduce one, and it cannot silence a class — it must restate the
   observed fields, so it matches one row and one row only.
2. An acceptance that matches nothing observed is **its own refusal**. A mapping
   cannot outlive the difference it explains.
3. An acceptance requires a capture and a non-empty baseline. An acceptance with
   no read-only evidence behind it is not a reconciliation.
4. `why` must be a real sentence and `evidence` must be present.
5. Claim failures are **not reconcilable**. `applied_verified` and "this release
   needs no migrations" are claims the deploy made about itself; a false one is not
   a historical difference and no entry can touch it. Neither can a duplicate
   version, a tampered baseline, or content drift against the baseline.
6. Every reconciled difference is still **printed** in the deploy log with its
   reason and its evidence. Nothing becomes invisible.

Fixing a difference is always preferable to accepting it. Accepting is for
differences that are true of production and cannot be undone by editing this
repository — and note that renaming or deleting an applied migration to make a
difference go away is exactly the defect that rejected the earlier revision of
this branch. Do not do it.

## 4 · The procedure

Steps 2 and 3 touch production. They are read-only, and they are still authorised
actions: no code round performs them.

1. Confirm the release contains this document, the gate, the capture script and an
   uncaptured `supabase/migration-history-reconciliation.json`.

2. **[AUTHORISED ACTION] Capture the baseline.** From the release, on the deploy
   host, as the user that can read the root-owned URL file:

   ```bash
   node scripts/capture-remote-migration-history.mjs \
     --url-file /etc/newme/migration-db.url \
     --out supabase/migration-history-reconciliation.json
   ```

   The connection string is read from the file and never appears in an argument.
   The capture is one `select` in a `begin read only` transaction. An existing
   `accepted[]` list is carried over unchanged — the gate re-matches every entry
   against the new baseline, so a re-capture cannot quietly keep endorsing a
   difference that has changed.

3. **[AUTHORISED ACTION] Read the differences.** Run the gate against production
   with the freshly captured baseline and no acceptances:

   ```bash
   node scripts/verify-remote-migration-history.mjs \
     --url-file /etc/newme/migration-db.url \
     --migrations-dir supabase/migrations \
     --history-fixture supabase/migration-history-reconciliation.json
   ```

   It will refuse. The refusal list is the work: every line is a difference to fix
   in the repository or to write down in `accepted[]` with a reason.

4. Resolve each line. Prefer the repository fix. Where the difference is a fact
   about production, add an `accepted[]` entry that restates the observation.

5. Re-run step 3 until it exits 0. Record the exit code, the counts it printed and
   the reconciled lines. Do not record statement text; there is none to record.

6. Commit the baseline and the mapping. Review the diff as security-relevant
   change: each new `accepted[]` entry is a documented exception to a fail-closed
   gate.

The deploy wrapper runs the same gate with the same fixture at
`infra/systemd/newme-deploy.sh`, and a non-zero exit blocks the deployment with
`production migration history does not match the release being deployed`. Until
step 5 has been completed for real, that gate blocks the deploy. That is the
correct state: production content equivalence has not been demonstrated.

## 5 · Read-only queries an operator may run directly

Use these to understand a refusal. They return migration metadata only.

The shape of the recorded history:

```sql
select count(*) as applied,
       count(*) filter (where coalesce(array_length(statements, 1), 0) = 0) as rows_with_no_statements,
       count(*) filter (where version !~ '^[0-9]{14}$') as non_cli_versions,
       min(version) as oldest,
       max(version) as newest
  from supabase_migrations.schema_migrations;
```

Which versions have no recorded statements — the seven the review found:

```sql
select version, name
  from supabase_migrations.schema_migrations
 where coalesce(array_length(statements, 1), 0) = 0
 order by version;
```

Which versions are not 14-digit CLI stamps:

```sql
select version, name
  from supabase_migrations.schema_migrations
 where version !~ '^[0-9]{14}$'
 order by version;
```

Fingerprints only, if a single row needs to be compared by hand:

```sql
select version,
       coalesce(array_length(statements, 1), 0) as statement_count,
       encode(sha256(convert_to(
         coalesce(array_length(statements, 1), 0)::text ||
         case when coalesce(array_length(statements, 1), 0) > 0
              then ' ' || array_to_string(statements, ' ')
              else '' end, 'UTF8')), 'hex') as statements_sha256
  from supabase_migrations.schema_migrations
 order by version;
```

Do **not** select `statements` itself, and do not paste migration SQL into an
issue, a report or a chat. Record the version, the count and the fingerprint.
No row contents.

## 6 · What is still open

- The production capture has not been taken. `capture` is `null` and `rows` is
  empty in the committed file.
- Therefore the 18 structural differences and the seven unrecorded-content rows are
  **not** reconciled. They are reproduced synthetically and proven to be reported;
  they are not resolved.
- No migration has been applied, no deployment has been performed, and the deploy
  gate is expected to refuse until the reconciliation is done.

None of these may be marked ✅ from a code round. What the code round closes is
that the gate now measures content, reports every difference, and cannot be
talked out of one — not that production has been reconciled.
