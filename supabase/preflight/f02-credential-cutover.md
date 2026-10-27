# F-02 credential cutover — fail-closed preflight and postcondition contract

Status: **NOT PERFORMED.** Nothing in this document has been run against
production by the branch that ships it. It is the contract the action has to
satisfy, written before the action, so that whoever performs it can be checked
against something other than their own summary.

The branch containing this file is code-only. It does not ban an Auth identity,
does not revoke a session, does not apply a migration and does not restart a
service. Every step below marked **[AUTHORISED ACTION]** requires explicit,
separate authorisation from the account owner and is out of scope until then.
Until every postcondition in §5 has recorded evidence, **F-02 stays open on
TASKBOARD.md** and no release note may describe the published credential as
dead.

---

## 1 · What is actually true today

`dev@newme.ae` exists in production as one of two admins. Its password is
readable in the public git history of this repository
(`src/app/api/dev/setup/route.ts`, `DEV_EMAIL` / `DEV_PASSWORD`).

It is not the only one. Closing round-4 A0 in the source tree found plaintext
credentials for **seven identities** and for the **production database itself**,
across seven files. §7 is the full inventory and the closure condition for each;
this section stays about `dev@newme.ae` because it is the one with an application
boundary in front of it. The others have none: a database password is not
affected by `is_active`, by RLS, or by a ban.

Three layers apply to it, and it matters which is which:

| Layer | State after this branch | What it stops |
| --- | --- | --- |
| Next.js request path (`src/proxy.ts:214`, `src/app/api/auth/login/route.ts:198`, `src/app/api/auth/me/route.ts:97`) | closed by `20260811100300` setting `is_active = false` | sessions established through, or carried into, the application |
| PostgreSQL data path (PostgREST, direct) | closed by `20260813000000_session_revocation_boundary.sql` — `is_active` and `auth.users.banned_until` are conditions of every policy on every table an authenticated session can reach | reading or writing business data with a validly-signed token for a deactivated identity |
| GoTrue identity itself | **OPEN** | nothing. The identity still authenticates, still receives a signed access token, can still refresh, and can still reach any Auth endpoint that does not consult `public.profiles` |

The first revision of `20260811100300` claimed the credential was "dead at both
authentication boundaries" and cited only application code. That claim was
false and has been corrected in the migration itself. The correction is the
reason this document exists: the remaining gap is small, real, and cannot be
closed by SQL in a pull request.

### What the open layer still permits

With `NEXT_PUBLIC_SUPABASE_URL` and the publishable anon key — both shipped to
every browser by design — a holder of the published password can still:

* mint an access token (`POST /auth/v1/token?grant_type=password`);
* call `/auth/v1/user` and change that account's own password;
* reach anything that is *not* behind the row-level boundary: a table with RLS
  disabled, a policy granted to `anon`, Storage objects, Realtime channels, and
  any RPC granted to `authenticated` that does not consult
  `public.session_identity_enabled()`;
* mint a **fresh** access token from a refresh token issued earlier, which by
  construction defeats the `iat` comparison in
  `public.session_token_is_current()`.

Only GoTrue can close those. That is §4.

---

## 2 · Read-only preflight

Run all of these **before** anything in §4. Every one is read-only: catalogue,
policy and aggregate-count queries. None selects a business row, an email
address, a name, or an auth identity's attributes beyond the two booleans the
cutover is about.

Abort the cutover if any check fails. Fail closed: an unanswered check is a
failed check.

### 2.1 · Is there another usable admin?

Deactivating or banning the last privileged account locks the platform out.
`20260811100300` already refuses to run without one; verify it independently
before banning, because the ban in §4 has no such interlock.

```sql
-- expect: >= 1
select count(*) as other_usable_privileged_accounts
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.role in ('admin','boss','operator')
   and p.is_active
   and p.id <> (select id from auth.users where email = 'dev@newme.ae')
   and u.last_sign_in_at is not null
   and (u.banned_until is null or u.banned_until <= now());
```

### 2.2 · Is the data boundary actually installed?

If `20260813000000` has not been applied, the ban is the *only* control and the
cutover has a much larger blast radius. Do not proceed on the assumption that it
is there.

```sql
-- expect: both true
select to_regprocedure('public.session_token_is_current()') is not null as predicate_installed,
       (select count(*) > 0 from pg_policy where polname like 'restrict%active_session%') as overlay_installed;

-- expect: zero rows. Any row is a table an authenticated session can reach that
-- the boundary does not cover.
select c.relname
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  join pg_policy p on p.polrelid = c.oid
 where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
   and p.polpermissive
   and (p.polroles = '{0}'::oid[] or 'authenticated'::regrole::oid = any(p.polroles))
   and not exists (select 1 from pg_policy q
                    where q.polrelid = c.oid and not q.polpermissive
                      and q.polname like 'restrict%active_session%')
 group by c.relname
 order by c.relname;
```

### 2.3 · What is NOT covered by the boundary?

Two known classes, both worth measuring before the cutover rather than
discovering after it. Report counts and names of objects — not contents.

```sql
-- Tables reachable by a logged-in session with RLS switched off entirely.
select c.relname
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
   and has_table_privilege('authenticated', c.oid, 'select')
 order by 1;

-- Policies granted to anon. The session boundary is scoped to `authenticated`
-- and does not restrict these.
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public' and ('anon' = any(roles) or roles = '{public}')
 order by 1, 2;
```

### 2.4 · Would the pending migrations abort?

Both new fail-closed pre-checks refuse rather than guess. Answer them before the
deploy window, not inside it.

```sql
-- 20260811100500_kpi_targets_atomic_replace.sql aborts if this returns > 0.
-- It will not choose which of two conflicting KPI targets is real; an operator
-- must resolve them first. Returns period/type/count only — no amounts, no
-- assignees.
select period, target_type, count(*) as unassigned_rows
  from public.kpi_targets
 where assigned_to is null
 group by period, target_type
having count(*) > 1
 order by 1, 2;

-- 20260812000000 seeds the contract counter from the highest issued number.
-- Expect exactly one row per prefix and no gap you cannot explain.
select substring(contract_no from '^NEW-[0-9]{8}') as prefix,
       count(*) as issued,
       max(substring(contract_no from '^NEW-[0-9]{8}-0*([0-9]+)$')::int) as highest
  from public.contracts
 where contract_no ~ '^NEW-[0-9]{8}-[0-9]+$'
 group by 1 order by 1;
```

### 2.5 · Does the remote migration history match this branch?

```
node scripts/verify-remote-migration-history.mjs --url-file /etc/newme/migration-db.url
```

Expect `OK`. It fails closed on a missing URL file, an unreachable database, a
missing `supabase_migrations.schema_migrations`, a remote version this branch
does not contain, an applied version whose recorded name differs, and any
locally-modified applied migration. See §6.

---

## 3 · Order of operations

The order is not interchangeable. Each step narrows the surface the next one
has to cover.

0. §7.2 **[AUTHORISED ACTION]** rotate the production database password. It is
   first because it is the only published credential that grants direct access to
   the data, and because nothing else in this list reduces its blast radius.
1. §2 preflight, all checks green.
2. Apply the pending migrations (`20260811100000` … `20260813000000`).
   The data boundary must exist **before** the identity is banned, so that a
   session which survives the ban window still reads nothing.
3. Re-run §2.2. The boundary must now report installed and complete.
4. §4 **[AUTHORISED ACTION]** revoke the identity's sessions, then ban it, then
   re-measure — in that order, for the reasons in §4.
5. §5 postconditions, recorded.
6. §7.1 **[AUTHORISED ACTION]** rotate the six other published account
   passwords, whose holders are live employees.
7. Remove the credentials from the source tree
   (`PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL`). **Done on this branch** — see §7.3.
   A published secret stays published in git history; taking it out of the
   working tree is hygiene, not remediation, and it does not close this item.

If step 2 aborts on a fail-closed pre-check, **stop**. Resolve the data
condition it reported and start again at §2. Do not edit the migration to make
it proceed: both pre-checks exist because the alternative is a migration
silently deleting business rows.

---

## 4 · [AUTHORISED ACTION] the ban and the session revocation

Not performed by this branch. Requires explicit authorisation. Performed with a
service-role credential that is never echoed, never passed as a command-line
argument, and never written to a log.

`supabaseAdmin.auth.admin.signOut()` cannot revoke another user's sessions — it
needs that user's own JWT.

An earlier revision of this section then concluded "the ban is what makes the
refresh token useless, which is why it is the operative step and not an extra."
**That conclusion was wrong and is withdrawn.** Round-4 A3 measured it: a
service-role `delete from auth.refresh_tokens` / `auth.sessions` does revoke
another user's sessions, from the database, without that user's JWT.
`public.revoke_user_sessions(uuid, text)`
(`20260817120000_admin_reset_session_revocation.sql`) is that operation, and it
verifies the absence afterwards rather than trusting the delete —
`scripts/gotrue-revocation-drill.sh` is the measurement, and
`tests/security/admin-reset-session-revocation.test.mjs` is the regression.

Both steps are still required, for different reasons, and neither substitutes
for the other:

| Step | Closes | Does not close |
| --- | --- | --- |
| `revoke_user_sessions()` | every refresh token and session that exists *now*; the holder of one cannot mint a new access token from it | a fresh `grant_type=password` request — the published password still authenticates, and mints a new session immediately |
| the ban | authentication itself, so no new session can be minted | sessions minted before it; GoTrue's behaviour here varies by version, which is why the counts below are measured and not assumed |

So: revoke, ban, then re-measure. The ban is operative against the credential;
the revocation is operative against everything the credential already produced.

```
# Ban the identity. 876000h ≈ 100 years, matching the soft-delete path in
# src/app/actions/team.ts. The identity, its profile and its 1514 audit
# attributions all survive; only its ability to authenticate does not.
PUT /auth/v1/admin/users/<dev-user-id>   { "ban_duration": "876000h" }
```

After the ban, confirm that no refresh token can still mint a token for it.
GoTrue's behaviour on password update varies by version, so verify rather than
assume:

```sql
-- expect: 0 for both. Requires a role with access to the auth schema.
select count(*) as live_sessions       from auth.sessions       where user_id = '<dev-user-id>';
select count(*) as live_refresh_tokens from auth.refresh_tokens where user_id = '<dev-user-id>' and revoked = false;
```

If either is non-zero after the ban, revoke them explicitly —

```sql
-- service_role only; audits, and raises if the rows are still there afterwards.
select public.revoke_user_sessions('<dev-user-id>'::uuid, 'f02_credential_cutover');
```

— and record that the ban alone was insufficient. That is a finding about the
platform, not a detail.

**Do not verify the cutover by attempting to log in as `dev@newme.ae`.** A login
attempt with a published password against production is an authentication event
on a live system, it writes to `auth.audit_log_entries`, and it proves less than
the queries in §5. The account owner has explicitly withheld authorisation for
a login test.

---

## 5 · Postconditions — the evidence that closes F-02

F-02 may be marked complete only when all six are recorded, from production,
after §4. Evidence is booleans, counts, timestamps and object names. No email
addresses beyond the one identifier this item is about, no password material, no
business rows, no raw payloads.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `select banned_until > now() from auth.users where email = 'dev@newme.ae'` | `true` |
| 2 | `select is_active, force_password_change from public.profiles where email = 'dev@newme.ae'` | `false, true` |
| 3 | `select count(*) from auth.sessions where user_id = '<dev-user-id>'` | `0` |
| 4 | `select count(*) from auth.refresh_tokens where user_id = '<dev-user-id>' and revoked = false` | `0` |
| 5 | `select count(*) from public.audit_logs where actor_id = '<dev-user-id>'` | unchanged from the pre-cutover count (the attributions must survive) |
| 6 | §2.2 both `true`, and the completeness query returns zero rows | boundary installed and complete |

Record them in the deployment evidence file, not in a chat message.

## 5.1 · Rollback of the cutover

`rollback_l0_20260811.sql` deliberately does **not** re-enable this account, and
`20260813000000` is declared `NO_ROLLBACK`. If the ban has to be lifted because
no replacement admin exists, that is a separate authorised change with its own
approval and its own audit entry — it is deliberately not available in this
repository as SQL to paste, because a hole reopened by someone following a
runbook at 3am is the exact failure mode both of those decisions exist to
prevent.

---

## 6 · Why the remote-history check is part of this

`scripts/verify-remote-migration-history.mjs` is listed in §2.5 because the two
failures this release is cleaning up after were the same failure twice: a claim
recorded as verified without being measured. The reviewed revision of this
branch had renamed one applied migration and rewritten another, so the
directory and production disagreed about what had run — and nothing in the
deploy path would have noticed. `scripts/check-migration-history.mjs` closes that
in the repository; the remote check closes it against the database that actually
has the history.

It reads only `supabase_migrations.schema_migrations`, which is metadata. It
selects no business row and no auth identity.

---

## 7 · Every published credential, and what closes it

Round-4 A0 named one hard-coded password. Looking for the rest of that shape
found fifteen publication sites, seven identities and one database password in
seven files. Making the gate read *every* tracked artifact instead of the text
and source extensions it had been given then found **five more sites and one
more identity, in five more files** — so the total is **twenty sites, eight
identities and one database password, in twelve files**.

That second number is the important one. The first pass was done by reading, with
a gate whose scope was chosen by the same judgement that had already missed
these. The sites it could not see were:

| Site | Why the gate reported OK |
| --- | --- |
| `.next.backup/**/*.js.map` ×2 | the whole directory was exempt by path prefix, *and* the value is JSON-escaped inside `sourcesContent`, where no source pattern matches. Two independent reasons, either sufficient. |
| `OC-MIGRATION-BRIEF.md:53–54` | the file is stored with its line-number gutter baked in (`53|| a@b | value |`), so no row started with a pipe, so it had no table rows, no header row and no credential column. |
| `test-matrix-runner.mjs:10–12` | `password: 'value'` is a property, and the rule only saw declarations. |
| `test_matrix.py:29,49–52` | a dict entry and three positional tuples — `("a@b", "value", "role")` — which carry no credential word at all. |
| `test-matrix.md:4–6` | `- admin (a@b / value)`: the same, in prose. |

None of those five files is generated by a build except the sourcemaps, and the
sourcemaps are the reason the exemption was wrong: the source they were built
from had been redacted, so the only surviving copies in the tree were inside the
directory the gate had been told to skip. Generated output is not a derivative of
the current source. It is a snapshot of an older one.

Nothing in this section contains a credential value. The sites are named by path
so the redaction can be audited; the values are in the git history of those
paths, which is precisely why redaction does not close anything here.

**The single fact that matters:** every value below must be assumed known to
anyone who has ever cloned this repository, including after the working tree was
cleaned. The repository's visibility, and whether the history is purged, are
separate decisions for the account owner — but rotation is not conditional on
either of them, because a private repository does not un-publish what was public.

### 7.1 · Account passwords — seven live employee identities plus `dev@newme.ae`

| Identity | Role as published | Sites |
| --- | --- | --- |
| `dev@newme.ae` | admin | `src/app/api/dev/setup/route.ts`, `src/app/api/auth/dev-login/route.ts`, **`.next.backup/server/chunks/[root-of-the-server]__0mmexnt._.js.map`**, **`.next.backup/server/chunks/ssr/src_app_(dashboard)_layout_tsx_0xhtysi._.js.map`** |
| `admin@newme.ae` | admin | **`test-matrix-runner.mjs`**, **`test-matrix.md`**, **`test_matrix.py`** |
| `tanya@newme.ae` | boss | `docs/employee-readiness-20260624.md`, `migration-output/company-profile.md`, `docs/onboarding-guide.md`, `docs/onboarding-guide-en.md`, **`OC-MIGRATION-BRIEF.md`**, **`test-matrix-runner.mjs`**, **`test-matrix.md`**, **`test_matrix.py`** |
| `ayana@newme.ae` | operator | `docs/employee-readiness-20260624.md`, `migration-output/company-profile.md`, `docs/onboarding-guide.md`, `docs/onboarding-guide-en.md`, **`OC-MIGRATION-BRIEF.md`** |
| `mohamed@newme.ae` | sales | `docs/employee-readiness-20260624.md`, **`test_matrix.py`** |
| `faheem@newme.ae` | sales | `docs/employee-readiness-20260624.md`, **`test-matrix-runner.mjs`**, **`test-matrix.md`**, **`test_matrix.py`** |
| `assem@newme.ae` | sales | `docs/employee-readiness-20260624.md`, `docs/context-pack/flight-recorder-phase0.md` |
| `sam@newme.ae` | admin | `docs/context-pack/11-tanya-feedback-raw.md` |

Bold entries are the sites found in the second pass, by scanning every tracked
artifact rather than a chosen set of extensions.

Five of the eight shared one value, so a single disclosure is a disclosure of
five accounts. `docs/employee-readiness-20260624.md` additionally published a
shared temporary password in prose, in Chinese, on a line no ASCII-boundary rule
matched.

Three of these identities have **more than one published value**: the value in
`OC-MIGRATION-BRIEF.md` for `tanya@newme.ae` differs from the one in
`test-matrix*`, and `faheem@newme.ae` and `mohamed@newme.ae` each have a
separately published value from the sales-password reset in `test_matrix.py`.
Rotation must therefore be per identity and not per value: rotating "the
published password" for one of these closes only one of them.

`test_matrix.py` is worse than a published value. It reads `.env.local` on the
production host, exchanges `SUPABASE_PAT` for a live `service_role` key through
`https://api.supabase.com/v1/projects/<ref>/api-keys`, and then `PUT`s a new
password onto two named user ids. Redacting its literals — done — leaves a
working, published recipe for privilege escalation that depends only on the PAT.
**[AUTHORISED ACTION]** rotate the Supabase personal access token as well; it is
not in §7.2 because it is not the database password, and it is not closable from
a pull request either.

**[AUTHORISED ACTION]** for each: rotate, and require a password change on next
sign-in. `src/app/api/users/[id]/password/route.ts` already routes every
administrator reset through `public.revoke_user_sessions()`, so a rotation
performed through the application revokes that identity's existing sessions and
fails closed if it cannot verify the revocation — which is the property that
makes rotation here sufficient without a separate revocation step per account.

Postcondition per identity, recorded as booleans and counts only:

```sql
-- expect: force_password_change = true, and 0 live sessions/refresh tokens.
select p.force_password_change,
       (select count(*) from auth.sessions where user_id = p.id) as live_sessions,
       (select count(*) from auth.refresh_tokens
         where user_id = p.id and revoked = false)               as live_refresh_tokens
  from public.profiles p where p.email = '<identity>';
```

### 7.2 · The production database password — highest priority

`crm-v3/ops/HANDOFF-20260701.md` and `crm-v3/v3.1/v3.1 P1P1计划0629.txt` (twice)
published the production Supabase database password, pasted inside a working
command line:

```
supabase migration list --linked --password <value>
```

This is the worst of the fifteen, and it is the one with no compensating control
anywhere in this repository:

* it is not an application identity, so `is_active`, `force_password_change`,
  the RLS session boundary and an Auth ban are all irrelevant to it;
* it grants direct SQL access, so every policy in §2.2 is bypassed;
* it was published in three places, in two file formats, in a directory
  (`crm-v3/`) that no security review in this release had looked at.

**[AUTHORISED ACTION], first in the order of operations (§3 step 0):** rotate it
in the Supabase dashboard, then update every consumer that holds it —
`/etc/newme/migration-db.url` on the deploy host, any CI secret, and any local
`.env` — without reading, printing or echoing either the old or the new value.
Verify by running §2.5 (`node scripts/verify-remote-migration-history.mjs
--url-file /etc/newme/migration-db.url`) and requiring `OK`: it connects with the
rotated credential and reads only migration metadata, so a green result is proof
of both the rotation and the consumer update, with no secret in any log.

Note for whoever performs it: this credential leaked *because* it was passed as
`--password <value>` on a command line. Nothing in this repository interpolates a
secret into argv, and `scripts/check-published-credentials.mjs` now fails the
build on a line that does.

### 7.3 · What this branch did, and what it deliberately did not

Done, code-only, no production contact:

| # | Change |
| --- | --- |
| 1 | Both bootstrap routes resolve their identity through `src/lib/dev-identity.mjs`, which has no default: production, no explicit non-`NEXT_PUBLIC_` opt-in, an unconfigured environment, a malformed address or a password under 16 characters each return a refusal *code* and a 403/503. Verified by `tests/security/dev-identity-bootstrap.test.mjs` (13 tests), including that neither route reaches Supabase when unconfigured. |
| 2 | `/api/dev/setup` no longer re-applies a password to an identity that already exists — that made a bootstrap endpoint a password reset with no authorisation check. |
| 3 | All twenty sites redacted in the working tree, each carrying a note that redaction is not remediation and pointing here. The two harnesses now read their credentials from the environment and refuse to run unconfigured rather than defaulting — a default is how the published value got there. |
| 4 | `scripts/check-published-credentials.mjs` — a required gate over `git ls-files` with **nothing exempted**: nine rules, every tracked non-binary file including `.map` and `.json` (decoded through their JSON escapes), reporting locations and rule names but never values. `tests/security/published-credentials.test.mjs` (18 tests) reconstructs the *shape* of each site that really existed and requires rejection, requires the shapes that flooded its first draft to stay clean, and carries a mutation control for each of the two scope defects: the old separator predicate and raw-source matching must both **miss** the fixtures the new ones catch. |
| 5 | `docs/onboarding-guide.md` / `-en.md` also claimed Tanya and Ayana can *view* other users' passwords on the Team page. That was false — `src/app/(dashboard)/team/page.tsx` offers only `type="password"` inputs and a reset action, and nothing stores or displays a plaintext password. Corrected to "reset". |
| 6 | The 1634 tracked files under `.next.backup/` are no longer tracked, and `.gitignore` now ignores the directory. It listed `.next.backup.*`, which never matched `.next.backup/` — one missing slash is the whole reason a build backup was committed. The gate now reports *any* tracked build output as a finding in its own right, before reading a byte, so the exemption cannot return silently. |

Not done, and not closable from a pull request: every rotation in §7.1 and §7.2,
the Supabase personal access token in §7.1, the ban in §4, the repository's
visibility, and the history purge.

The `.next.backup/` files are untracked, not erased: they remain in git history,
like every other site here. Untracking removes them from what a fresh clone
publishes. It does not remove them from what an existing clone already has.

Until §7.1 and §7.2 are recorded as performed, **`PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL`
stays open on TASKBOARD.md** with the source side marked done and the production
side marked open. Removing a credential from a file is not the same event as
making it stop working, and this release does not get to describe it as one.
