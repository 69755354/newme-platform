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

Round-4 reopened it. The closure conditions, verbatim:

> **C4** — require a valid capture, use canonical length-delimited/JSON encoding,
> parse local migration content by the CLI's real semantics and compare it with
> measurable remote statements. Rows with no measurable statements must remain
> explicit exceptions, not byte-equivalence claims.
>
> **C5** — either strictly allow the exact claimed/applicable migration delta or
> recapture, commit, re-review and rerun exact-SHA CI after expand.

Artifacts:

| what | where |
| --- | --- |
| the gate | `scripts/verify-remote-migration-history.mjs` |
| the read-only capture | `scripts/capture-remote-migration-history.mjs` |
| the baseline and the mapping | `supabase/migration-history-reconciliation.json` |
| the local half of the content proof | `scripts/split-sql-statements.mjs` |
| splitter ↔ CLI parity drill | `scripts/verify-cli-statement-parity.mjs` (CI job `local-database`) |
| fingerprint SQL ↔ JS parity drill | `scripts/statements-fingerprint-parity.mjs` (CI job `migration-replay`) |
| the behaviour tests | `tests/release/remote-migration-history-reconciliation.test.mjs`, `tests/release/remote-migration-history.test.mjs`, `tests/release/split-sql-statements.test.mjs` |
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

## 1a · What round 4 found on top of that

Reading `statements` was necessary and was not sufficient. Four defects, all of
them in the direction of a gate that passes without measuring:

**Half a comparison.** The recorded fingerprints were compared only with an
earlier capture of the same database. That proves production has not changed since
the capture; it says nothing about whether production ever ran *this release*. The
missing half is the release's own files, parsed into the statement array the CLI
would have recorded, fingerprinted the same way.

**A fingerprint that collided.** The digest was the element count followed by the
elements joined with a space. `["a", "b c"]` and `["a b", "c"]` have the same count
and the same joined text, so a statement boundary could move without changing the
fingerprint — and a boundary moving is precisely the drift this gate exists to
catch. The encoding is now length-delimited (§2) and a capture declares which
encoding produced it, so a baseline taken under the old one is refused rather than
compared.

**A refusal that belonged to production, not to the gate.** The committed
reconciliation is uncaptured, so the gate refused — but it refused because
production happened to differ from the release, not because the file records no
capture. An uncaptured baseline and an agreeing one reached the same outcome.
Supplying a reconciliation with no capture is now a reported problem by itself.

**A deadlock on the canonical path.** Any row production applied after the capture
was reported as a stale baseline, including the migration the deploy was in the
middle of applying. The deploy could not apply a migration without invalidating
the baseline that permitted the deploy. §3a is the bounded allowance that resolves
it.

## 2 · What the gate does now

It reads four things per row, inside a `begin read only` transaction:

- `version`
- `name`
- `coalesce(array_length(statements, 1), 0)` — the statement count
- `encode(sha256(…), 'hex')` over the count and the statements — a fingerprint
  **computed by the server**

The statement text is never transferred, printed, logged or written by either
script. The one query both of them run is exported as `HISTORY_QUERY`, so the
capture and the comparison cannot drift apart, and `statementsFingerprint()`
recomputes the identical value in JavaScript for callers and tests.

**The encoding** is `statements-v2-length-delimited`, and it is
length-delimited precisely so that no element's bytes can be read as part of its
neighbour's:

```
<count> LF ( <octet length> LF <utf-8 bytes> )*
```

Lengths are octets of the UTF-8 encoding, so the digest does not change with the
server's encoding; a null element hashes as the empty string on both sides. A
capture records `fingerprint_format`, and a capture that declares anything else is
refused outright rather than compared — digests from two encodings are not
comparable, and reporting the difference per row would accuse production of a
change it never made.

**The local half.** Every migration file the CLI would apply is read and parsed by
`scripts/split-sql-statements.mjs` into the array the CLI records for it, then
fingerprinted with the same function. Every recorded row this release also contains
must reproduce from that file, or be an explicit exception with a reason and
evidence. `content reproduced : N of M recorded row(s)` in the output is that
count, and it is the only line in this gate that is a statement about *this
release* rather than about production's stability.

Two things about the local half that are easy to get wrong, and both are load
bearing:

- The splitter's target is **the CLI's lexer, not PostgreSQL's**. The CLI drops the
  terminating `;` from each recorded statement, and it treats a backslash as an
  ordinary character even inside `E'…'`, where the server would not. A
  server-faithful splitter reports content drift for files production applied
  exactly. Neither behaviour is discoverable by reading this repository — the CLI's
  source is not vendored here — so both were measured, and both are held by
  `scripts/verify-cli-statement-parity.mjs`, which applies an adversarial corpus
  with the pinned CLI and requires byte-identical reproduction. Parity is
  established per CLI version and for no other: raising the pin in
  `.github/workflows/ci.yml` without a green run of that drill invalidates this
  proof.
- The fingerprint is over **bytes**, so it is line-ending sensitive. Every
  migration blob in this repository is LF; a checkout with `core.autocrlf=true`
  (any default Windows clone) hands the gate CRLF files that production never
  applied. Normalising them would claim equality with bytes that were never
  executed, so the gate instead refuses once, names the cause, and performs no
  per-row content comparison at all — a hundred checkout-manufactured content
  differences would read as production tampering.

Everything below is a refusal, not a warning:

| observation | why it fails closed |
| --- | --- |
| no readable `statements` column | content equivalence cannot be measured, which is not the same as being fine |
| a row with 0 statements | what ran under that version is not recorded anywhere |
| the release's files were not parsed at all | there is nothing in this release to compare production with |
| any migration file in the checkout is CRLF | the comparison would be measuring a rewritten file, not the release |
| a file that cannot be read, or parses into no statements | it cannot be the source of what was recorded |
| a recorded row this release contains but cannot reproduce | what ran under that version is not what this release carries |
| a reconciliation that records no capture | production's history has never been read, so nothing is being compared |
| a capture taken under a different fingerprint format | the digests are not comparable; recapture |
| a capture that records `statements_measured: false` | the baseline carries no content |
| a row absent from the captured baseline | the baseline is older than production — unless §3a admits it |
| a baseline row absent from production | applied history was removed from production |
| a different statement count or fingerprint | the recorded content of an applied migration changed |
| a baseline whose rows do not match the digest taken at capture time | the baseline was edited after it was captured |
| a baseline with rows but no capture block | a baseline with no provenance is not evidence |

And the two gaps that made the old gate weak in the other direction: a difference
nobody wrote down is still reported, and an acceptance that no longer matches
production is reported too.

**Both halves of the digest are measured, not asserted.** The server computes it in
SQL and this repository computes it in JavaScript, and the whole point of the design
is that the statement text never crosses the wire — which is also why the two
implementations could drift apart unseen, in either direction: a false accusation of
content drift, or a match where the bytes differ.
`scripts/statements-fingerprint-parity.mjs` records adversarial arrays (moved
boundaries, framing attacks, an empty array, a null column, null and empty
elements, embedded quotes, newlines, CR, tabs, multi-byte text, dollar-quoted
bodies) plus every migration file in this release into a real PostgreSQL of
production's major version and requires the two digests to agree on every one. Its
`--self-test` pass recomputes the JS side through the superseded space-joined
encoding and requires **every** row to be reported as a difference: a harness that
cannot see a whole encoding change cannot see a one-byte one, and this repository
has already booked that pattern as F-05.

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

Only six kinds may be accepted: `non_cli_version`, `remote_only`, `name_mismatch`,
`local_absent_remote_before_newest`, `no_statements`, and
`content_not_locally_reproducible`. The rules are enforced by the gate, not by
convention:

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
6. `content_not_locally_reproducible` is a statement that content equivalence was
   **not** demonstrated for that version — never that it was. It exists because
   production applied most of its history over months through CLI versions this
   release does not pin, so an old row whose boundaries this release cannot
   reproduce is history rather than tampering. It must restate both counts, and it
   is **refused outright for any version this deploy claims to have applied**: the
   same difference on a just-applied migration is the deploy having applied
   something other than what it shipped, which is a claim failure by rule 5.
7. Every reconciled difference is still **printed** in the deploy log with its
   reason and its evidence. Nothing becomes invisible.

Fixing a difference is always preferable to accepting it. Accepting is for
differences that are true of production and cannot be undone by editing this
repository — and note that renaming or deleting an applied migration to make a
difference go away is exactly the defect that rejected the earlier revision of
this branch. Do not do it.

## 3a · The post-capture delta (round-4 C5)

A deploy that applies a migration makes the baseline that permitted it stale. Read
literally, the previous rules made the canonical expand path impossible: the
migration production had just applied was reported as a row missing from the
capture. The alternative offered — recapture, commit, re-review and rerun exact-SHA
CI after the expand phase, before the app is allowed to start — is a correct
procedure but not one a deploy can perform on itself.

So exactly one row shape is admitted without being in the capture, and it is
admitted on **all five** of these at once:

1. it sorts **after** every version the capture saw, so it cannot rewrite any
   history the baseline covers;
2. this release **contains** the migration file;
3. `infra/release/release-manifest.json` **declares** it, in either phase;
4. the deploy **claimed** it applied, by version, via `--require-applied`;
5. its recorded content was **reproduced from this release's own file** in this same
   run.

Condition 5 is what makes bypassing the baseline safe: the row is admitted because
something stronger than the baseline is available for it. Remove any one condition
and the row is refused as `fixture_row_unrecorded` —
`tests/release/remote-migration-history-reconciliation.test.mjs` drives all six
removals, including a version that sorts *inside* the captured range, which is never
admitted no matter what else holds. Without a readable manifest, no delta is allowed
at all.

Every admitted row is printed as `post-capture delta : <version> <file> — claimed,
manifested, content reproduced from this release`. An operator reading the deploy log
can see which rows were accepted on their content rather than on the capture. The
baseline should still be recaptured and committed after the release settles; the
allowance is what lets the deploy finish, not a substitute for the capture.

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
     --release-manifest infra/release/release-manifest.json \
     --history-fixture supabase/migration-history-reconciliation.json
   ```

   It will refuse. The refusal list is the work: every line is a difference to fix
   in the repository or to write down in `accepted[]` with a reason.

   Run it from a checkout whose line endings are LF — the deploy host qualifies, a
   default Windows clone does not. If the run prints `local line endings : CRLF in
   N file(s)` then no content was compared at all, and the counts above it are not
   the proof they look like. `git -c core.autocrlf=false clone` (or a `.gitattributes`
   in the checkout) fixes it; `git status` must be empty afterwards.

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

Fingerprints only, if a single row needs to be compared by hand. This is
`HISTORY_QUERY` from the gate; copy it, do not retype it, because the digest is
only meaningful if the bytes hashed are exactly these:

```sql
select m.version,
       coalesce(array_length(m.statements, 1), 0) as statement_count,
       encode(sha256(
         convert_to(coalesce(array_length(m.statements, 1), 0)::text || E'\n', 'UTF8') ||
         coalesce((select string_agg(
                            convert_to(octet_length(convert_to(coalesce(s.statement, ''), 'UTF8'))::text || E'\n', 'UTF8')
                              || convert_to(coalesce(s.statement, ''), 'UTF8'),
                            ''::bytea order by s.ord)
                     from unnest(m.statements) with ordinality as s(statement, ord)),
                  ''::bytea)
       ), 'hex') as statements_sha256
  from supabase_migrations.schema_migrations m
 order by m.version;
```

The earlier form of this query — the count, a space, and the statements joined with
spaces — is **superseded**, collides across moved statement boundaries, and will not
match any digest this release computes.

And the local side of the same row, to see whether a
`content_not_locally_reproducible` refusal is the file or the history. It touches no
database:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { splitSqlStatements } from "./scripts/split-sql-statements.mjs";
import { statementsFingerprint } from "./scripts/verify-remote-migration-history.mjs";
for (const file of process.argv.slice(1)) {
  const statements = splitSqlStatements(readFileSync(file, "utf8"));
  console.log(statements.length, statementsFingerprint(statements), file);
}
' supabase/migrations/<version>_<name>.sql
```

If the counts differ the boundaries moved; if the counts match and the digests do
not, the text differs. Either way, report the numbers.

Do **not** select `statements` itself, and do not paste migration SQL into an
issue, a report or a chat. Record the version, the count and the fingerprint.
No row contents.

## 6 · What is still open

- The production capture has not been taken. `capture` is `null` and `rows` is
  empty in the committed file, and the gate now refuses on that alone.
- Therefore the 18 structural differences and the seven unrecorded-content rows are
  **not** reconciled. They are reproduced synthetically and proven to be reported;
  they are not resolved.
- How much of production's recorded content this release can actually reproduce is
  **unmeasured**, and it is the number that decides how much work step 4 is. Most of
  that history was applied by CLI versions this release does not pin, so some
  `content_not_locally_reproducible` acceptances are expected — but "some" is a
  prediction, not a measurement, and the first real run is what turns it into one.
- The splitter is at parity with **CLI 2.113.0** and with no other version. The
  CLI that applied production's older rows is unknown, which is the same statement
  as the point above.
- The post-capture delta of §3a has never run against production; it is proven by
  synthetic tests, in both directions, and nothing more.
- No migration has been applied, no deployment has been performed, and the deploy
  gate is expected to refuse until the reconciliation is done.

None of these may be marked ✅ from a code round. What the code round closes is
that the gate now measures content against this release, reports every difference,
refuses when it cannot measure, and cannot be talked out of one — not that
production has been reconciled.
