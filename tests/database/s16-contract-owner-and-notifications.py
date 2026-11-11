#!/usr/bin/env python3
"""S16 database batch on a local PostgreSQL only, never production.

  PGDATABASE=newme_role_permissions_test PGHOST=127.0.0.1 python3 tests/database/s16-contract-owner-and-notifications.py

Run against a database created from the replayed `history` template, like
role-permissions.py (whose fixture and helpers it reuses). Every scenario is one
transaction that is rolled back.

Covers (fixes/NEXT-DB-BATCH.md items 1, 2 and D-2):
  * notifications accept contract_created / reminder as type and task / digest as
    related_type, still refuse unknown values, and keep every older value;
  * convert_quotation_to_contract() makes the LEAD's owner the contract owner, so a
    salesperson can submit the contract for approval after an admin or operator
    built the quotation; a lead without an owner falls back to the quotation's
    creator and then to the acting user;
  * the routine is SECURITY DEFINER with a pinned search_path.
"""
import json, os

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "role-permissions.py")).read()
exec(compile(SRC.split("# 1. Operator")[0], "rp", "exec"))

QUOTE = "d2300000-0000-4000-8000-000000000016"
SCHEDULE = json.dumps({"installments": [{"seq": 1, "amount": 600, "due_date": "2099-01-01", "description": "a"},
                                         {"seq": 2, "amount": 400, "due_date": "2099-02-01", "description": "b"}]})

def setup(owner, creator):
    """LEAD_OTHER owned by `owner` (or nobody), an accepted quotation created by `creator`."""
    owner_sql = f"'{owner}'" if owner else "null"
    creator_sql = f"'{creator}'" if creator else "null"
    return f"""
reset role;
set local session_replication_role = replica;
update public.leads set stage = 'quotation_submitted', quality = 'normal', assigned_to = {owner_sql} where id = '{LEAD_OTHER}';
set local session_replication_role = origin;
delete from public.contracts where lead_id = '{LEAD_OTHER}';
insert into public.quotations (id, lead_id, quote_no, subtotal, total_amount, status, created_by)
values ('{QUOTE}', '{LEAD_OTHER}', 'NM-S16-TEST-1', 1000, 1000, 'accepted', {creator_sql});
"""

def run_as(uid, owner, creator, body):
    return scenario(uid, setup(owner, creator) + act_as(uid) + "\n" + body)

CONVERT = f"create temp table t_c as select (public.convert_quotation_to_contract('{QUOTE}', '{SCHEDULE}'::jsonb) ->> 'contract_id')::uuid as cid;"
OWNER_OF = "select 'owner:' || coalesce(c.sales_id::text, '-') from public.contracts c join t_c on c.id = t_c.cid;"

# ---------------------------------------------------------------------------
# 1. notification constraints
# ---------------------------------------------------------------------------
def notif(type_, related):
    rel = f"'{related}'" if related else "null"
    return f"reset role; insert into public.notifications (user_id, type, title, related_type) values ('{SALES}', '{type_}', 'x', {rel});"

for type_, related in (("contract_created", "contract"), ("reminder", "task"), ("followup_reminder", "digest"),
                       ("warning", "lead"), ("team_member_added", None), ("payment_due", "payment"), ("lead_created", "lead")):
    rc, out, err = scenario(ADMIN, notif(type_, related))
    assert rc == 0, (type_, related, err)
passed("notifications accept contract_created, reminder, warning, task and digest, and still accept the older values")

rc, out, err = scenario(ADMIN, notif("not_a_type", None))
assert rc != 0 and "notifications_type_check" in err, err
rc, out, err = scenario(ADMIN, notif("reminder", "not_a_related_type"))
assert rc != 0 and "notifications_related_type_check" in err, err
passed("notifications still refuse an unknown type and an unknown related_type")

assert query("""select count(*) from pg_constraint where conrelid = 'public.notifications'::regclass
                and conname in ('notifications_type_check', 'notifications_related_type_check') and convalidated""") == "2"
passed("both constraints are present and validated")

# ---------------------------------------------------------------------------
# 2. D-2: the lead's owner owns the contract
# ---------------------------------------------------------------------------
for builder in (ADMIN, OPERATOR, BOSS):
    rc, out, err = run_as(builder, SALES, builder, CONVERT + OWNER_OF)
    assert rc == 0, err
    assert out.splitlines()[-1] == f"owner:{SALES}", (builder, out)
passed("admin, boss and operator converting their own quotation on a salesperson's lead: the contract belongs to the lead's owner")

rc, out, err = scenario(ADMIN, setup(SALES, ADMIN) + act_as(ADMIN) + CONVERT + f"""
select cid from t_c \\gset
reset role;
{act_as(SALES)}
select public.set_contract_status(:'cid', 'pending_admin', 'go') ->> 'status';
""")
assert rc == 0, err
assert out.splitlines()[-1] == "pending_admin", out
passed("the salesperson who owns the lead submits the contract an admin converted for approval")

rc, out, err = scenario(ADMIN, setup(SALES, ADMIN) + act_as(ADMIN) + CONVERT + f"""
select cid from t_c \\gset
reset role;
{act_as(SALES)}
select count(*) from public.contracts where id = :'cid';
""")
assert rc == 0 and out.splitlines()[-1] == "1", (out, err)
passed("the salesperson can see that contract")

rc, out, err = scenario(ADMIN, setup(SALES, ADMIN) + act_as(ADMIN) + CONVERT + f"""
select cid from t_c \\gset
reset role;
{act_as(OPERATOR)}
select public.set_contract_status(:'cid', 'pending_admin', 'go') ->> 'status';
""")
assert rc == 0 and out.splitlines()[-1] == "pending_admin", (out, err)
passed("admin and operator can still submit it as managers")

rc, out, err = run_as(SALES, SALES, SALES, CONVERT + OWNER_OF)
assert rc == 0 and out.splitlines()[-1] == f"owner:{SALES}", (out, err)
passed("a salesperson converting on their own lead stays the owner")

rc, out, err = run_as(ADMIN, None, SALES, CONVERT + OWNER_OF)
assert rc == 0 and out.splitlines()[-1] == f"owner:{SALES}", (out, err)
passed("a lead without an owner falls back to the quotation's creator")

rc, out, err = run_as(ADMIN, None, None, CONVERT + OWNER_OF)
assert rc == 0 and out.splitlines()[-1] == f"owner:{ADMIN}", (out, err)
passed("a lead and a quotation without owners fall back to the acting user")

# a different salesperson cannot take or submit it
OTHER_SALES = "d2000000-0000-4000-8000-000000000016"
rc, out, err = scenario(ADMIN, setup(SALES, ADMIN) + f"""
insert into auth.users (id, email, email_confirmed_at, created_at) values ('{OTHER_SALES}', '{OTHER_SALES}@s2.invalid', now() - interval '30 days', now() - interval '30 days');
insert into public.profiles (id, email, role, is_active, full_name) values ('{OTHER_SALES}', '{OTHER_SALES}@s2.invalid', 'sales', true, 'S16 other sales');
""" + act_as(ADMIN) + CONVERT + f"""
select cid from t_c \\gset
reset role;
{act_as(OTHER_SALES)}
select public.set_contract_status(:'cid', 'pending_admin', 'go');
""")
assert rc != 0 and "only the contract owner or a manager" in err, err
passed("another salesperson cannot submit it")

# ---------------------------------------------------------------------------
# 3. routine attributes
# ---------------------------------------------------------------------------
attrs = query("""select p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') ||
                        '|' || has_function_privilege('anon', p.oid, 'execute')::text ||
                        '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
                   from pg_proc p where p.oid = to_regprocedure('public.convert_quotation_to_contract(uuid,jsonb)')""")
assert attrs == "true|search_path=pg_catalog, public, pg_temp|false|true", attrs
passed("convert_quotation_to_contract is SECURITY DEFINER with a pinned search_path, closed to anon, open to signed-in users")

print(f"{len(checks)} S16 checks passed")
