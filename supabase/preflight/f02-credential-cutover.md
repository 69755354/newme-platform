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

1. §2 preflight, all checks green.
2. Apply the pending migrations (`20260811100000` … `20260813000000`).
   The data boundary must exist **before** the identity is banned, so that a
   session which survives the ban window still reads nothing.
3. Re-run §2.2. The boundary must now report installed and complete.
4. §4 **[AUTHORISED ACTION]** ban the identity and revoke its sessions.
5. §5 postconditions, recorded.
6. Remove the credential from the source tree
   (`PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL`). A published secret stays published
   in git history; rotating it out of the working tree is hygiene, not
   remediation, and it does not close this item.

If step 2 aborts on a fail-closed pre-check, **stop**. Resolve the data
condition it reported and start again at §2. Do not edit the migration to make
it proceed: both pre-checks exist because the alternative is a migration
silently deleting business rows.

---

## 4 · [AUTHORISED ACTION] the ban and the session revocation

Not performed by this branch. Requires explicit authorisation. Performed with a
service-role credential that is never echoed, never passed as a command-line
argument, and never written to a log.

`supabaseAdmin.auth.admin.signOut()` cannot revoke another user's sessions —
it needs that user's own JWT. The ban is what makes the refresh token useless,
which is why it is the operative step and not an extra.

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

If either is non-zero after the ban, revoke them explicitly, and record that the
ban alone was insufficient — that is a finding about the platform, not a detail.

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
