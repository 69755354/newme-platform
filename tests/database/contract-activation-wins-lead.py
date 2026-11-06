#!/usr/bin/env python3
"""Contract activation wins the lead (local PostgreSQL only, never production).

  PGDATABASE=newme_role_permissions_test PGHOST=127.0.0.1 python3 tests/database/contract-activation-wins-lead.py

Run against a database created from the replayed `history` template. Every
scenario is one transaction that is rolled back, except the concurrency case,
which commits under a unique marker and cleans itself up.

Covers: converting a quotation leaves the lead at pending_decision (not won, no
customer, no project); activating the contract wins the lead and creates exactly
one customer and one project; repeated activation, suspend/resume and a retried
conversion change nothing further; a lost lead blocks activation; the manual
win path is untouched; conversion and contract creation are admin/boss only;
admin settles the boss approval step; two sessions activating at once still give
one customer and one project; the discount check refuses out-of-range values.
"""
import json, os, subprocess, sys, threading, uuid

SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "role-permissions.py")).read()
exec(compile(SRC.split("# 1. Operator")[0], "rp", "exec"))

QUOTE = "d2300000-0000-4000-8000-000000000001"
SCHEDULE = json.dumps({"installments": [{"seq": 1, "amount": 600, "due_date": "2099-01-01", "description": "a"},
                                         {"seq": 2, "amount": 400, "due_date": "2099-02-01", "description": "b"}]})
SETUP = f"""
reset role;
set local session_replication_role = replica;
update public.leads set stage = 'quotation_submitted', quality = 'normal' where id = '{LEAD_OTHER}';
set local session_replication_role = origin;
delete from public.contracts where lead_id = '{LEAD_OTHER}';
insert into public.quotations (id, lead_id, quote_no, subtotal, total_amount, status, created_by)
values ('{QUOTE}', '{LEAD_OTHER}', 'NM-S2-TEST-1', 1000, 1000, 'accepted', '{SALES}');
"""

def run_as(uid, body):
    rc, out, err = scenario(uid, SETUP + act_as(uid) + "\n" + body)
    return rc, out, err

def lead_state(lead=LEAD_OTHER):
    return ("select stage||'/'||coalesce(final_status,'-')||'/'||(select count(*) from public.customers where lead_id = l.id)"
            "||'/'||(select count(*) from public.projects where lead_id = l.id) from public.leads l where id = '%s';" % lead)

CONVERT = f"select (public.convert_quotation_to_contract('{QUOTE}', '{SCHEDULE}'::jsonb) ->> 'contract_id');"

def approve_both(cid):
    return (f"select public.set_contract_status('{cid}', 'pending_admin', 'go'); "
            f"select public.approve_contract('{cid}', null, 'approve', 'one'); "
            f"select public.approve_contract('{cid}', null, 'approve', 'two'); ")

# 1. conversion does not win the lead
rc, out, err = run_as(ADMIN, CONVERT + lead_state())
assert rc == 0, err
assert out.splitlines()[-1] == "pending_decision/-/0/0", out
passed("converting a quotation moves the lead to pending_decision: not won, no customer, no project")

# 1b. a stage_change event records the move
rc, out, err = run_as(ADMIN, CONVERT + "select count(*) from public.business_events where lead_id = '%s' and event_type = 'stage_change' and description like '%%to pending_decision%%';" % LEAD_OTHER)
assert rc == 0 and out.splitlines()[-1] == "1", (out, err)
passed("the move to pending_decision is written as a stage_change event")

# 2. retried conversion changes nothing (no win, no project, no second event)
rc, out, err = run_as(ADMIN, CONVERT + CONVERT.replace("select (", "select (") + lead_state()
                      + "select count(*) from public.business_events where lead_id = '%s' and event_type = 'stage_change' and description like '%%to pending_decision%%';" % LEAD_OTHER)
assert rc == 0, err
lines = out.splitlines()
assert lines[-2] == "pending_decision/-/0/0" and lines[-1] == "1", out
passed("a retried conversion neither wins the lead nor repeats the stage event")

# 3. activation wins; repeated activation / suspend+resume idempotent
chain = f"""
create temp table t_c as select (public.convert_quotation_to_contract('{QUOTE}', '{SCHEDULE}'::jsonb) ->> 'contract_id')::uuid as cid;
select public.set_contract_status(cid, 'pending_admin', 'go') from t_c;
select public.approve_contract(cid, null, 'approve', 'one') from t_c;
select public.approve_contract(cid, null, 'approve', 'two') from t_c;
select 'before:' || stage || '/' || coalesce(final_status,'-') from public.leads where id = '{LEAD_OTHER}';
select 'wonat-before:' || (won_at is null) from public.leads where id = '{LEAD_OTHER}';
select public.set_contract_status(cid, 'active', null) from t_c;
select 'after:' || ({lead_state()[:-1]});
do $$ begin begin perform public.set_contract_status((select cid from t_c), 'active', null); raise exception 'second activation was accepted'; exception when sqlstate '22023' then null; end; end $$;
select 'again:' || ({lead_state()[:-1]});
select public.set_contract_status(cid, 'suspended', null) from t_c;
select public.set_contract_status(cid, 'active', null) from t_c;
select 'resume:' || ({lead_state()[:-1]});
select 'wonat-after:' || (won_at is not null) from public.leads where id = '{LEAD_OTHER}';
select 'cust:' || (select count(*) from public.contracts c join public.customers u on u.id = c.customer_id where c.lead_id = '{LEAD_OTHER}');
select 'wonevents:' || count(*) from public.business_events where lead_id = '{LEAD_OTHER}' and event_type = 'won';
select 'proj:' || count(*) from public.projects p join t_c on p.contract_id = t_c.cid;
"""
rc, out, err = run_as(ADMIN, chain)
assert rc == 0, err
L = out.splitlines()
assert "before:pending_decision/-" in L, L
assert "after:won/won/1/1" in L and "again:won/won/1/1" in L and "resume:won/won/1/1" in L, L
assert "cust:1" in L and "wonevents:1" in L and "proj:1" in L, L
# the stats columns (dashboard "won this month" reads leads.won_at): empty after conversion, stamped at activation
assert "wonat-before:true" in L and "wonat-after:true" in L, L
passed("activating the contract wins the lead with one customer and one project; repeat and suspend/resume change nothing; admin settled both approval steps")

# 3b. a lead still at 'new' (no first contact yet) is marked won without being blocked by the first-contact gate
rc, out, err = run_as(ADMIN, f"""
reset role; set local session_replication_role = replica;
update public.leads set stage = 'new' where id = '{LEAD_OTHER}';
set local session_replication_role = origin; {act_as(ADMIN)}
""" + chain.split("select 'before:'")[0] + f"""
select public.set_contract_status(cid, 'active', null) from t_c;
select 'new-lead:' || ({lead_state()[:-1]});
""")
assert rc == 0, err
assert out.splitlines()[-1] == "new-lead:new/won/1/1", out
passed("activating a contract whose lead is still at 'new' is not blocked: the lead is marked won, with its customer and project")

# 4. lost lead blocks activation
rc, out, err = run_as(ADMIN, f"""
create temp table t_c as select (public.convert_quotation_to_contract('{QUOTE}', '{SCHEDULE}'::jsonb) ->> 'contract_id')::uuid as cid;
select public.set_contract_status(cid, 'pending_admin', 'go') from t_c;
select public.approve_contract(cid, null, 'approve', 'one') from t_c;
select public.approve_contract(cid, null, 'approve', 'two') from t_c;
reset role; update public.leads set stage = 'lost', final_status = 'lost' where id = '{LEAD_OTHER}'; {act_as(ADMIN)}
select public.set_contract_status(cid, 'active', null) from t_c;
""")
assert rc != 0 and "marked lost" in err, (out, err)
passed("a lost lead cannot be won by activating its contract")

# 5. manual win path unchanged
rc, out, err = run_as(ADMIN, f"select public.transition_lead_stage('{LEAD_OTHER}', 'quotation_submitted', 'won', 'manual', '{uuid.uuid4()}'); " + lead_state())
assert rc == 0 and out.splitlines()[-1].startswith("won/won/"), (out, err)
passed("the manual Won button still wins a lead directly")

# 6. who may create a contract (Sam, option A)
#    admin/boss/operator: any lead; sales: only a lead assigned to them; finance/designer: never.
PAY = lambda lead: json.dumps({"lead_id": lead, "amount": 100, "installments": [{"seq": 1, "amount": 100, "due_date": "2099-01-01"}]})
ASSIGN_OTHER_TO_SALES = f"reset role; update public.leads set assigned_to = '{SALES}' where id = '{LEAD_OTHER}'; "
# conversion
rc, out, err = run_as(SALES, CONVERT)           # LEAD_OTHER is unassigned: refused
assert rc != 0 and "only the assigned salesperson or a manager" in err, err
rc, out, err = run_as(SALES, ASSIGN_OTHER_TO_SALES + act_as(SALES) + CONVERT + lead_state())
assert rc == 0 and out.splitlines()[-1] == "pending_decision/-/0/0", (out, err)   # own lead: converts to a draft contract, lead not won
rc, out, err = run_as(SALES, ASSIGN_OTHER_TO_SALES + act_as(SALES) + f"create temp table t_c as select (({CONVERT.rstrip(';')})::uuid) as cid; select c.status from public.contracts c join t_c on c.id = t_c.cid;")
assert rc == 0 and out.splitlines()[-1] == "draft", (out, err)
for uid in (FINANCE, DESIGNER):
    rc, out, err = run_as(uid, ASSIGN_OTHER_TO_SALES + act_as(uid) + CONVERT)
    assert rc != 0 and "may not perform this operation" in err, (ROLE_OF[uid], err)
for uid in (ADMIN, BOSS, OPERATOR):
    rc, out, err = run_as(uid, CONVERT)
    assert rc == 0, (ROLE_OF[uid], err)
passed("a salesperson converts a quotation only on their own lead (draft contract, lead not won); admin, boss and operator on any lead; finance and designer never")
# create_contract
rc, out, err = run_as(SALES, f"select public.create_contract('{PAY(LEAD_DESIGNER)}'::jsonb) ->> 'status';")      # assigned to SALES
assert rc == 0 and out.splitlines()[-1] == "draft", (out, err)
rc, out, err = run_as(SALES, f"select public.create_contract('{PAY(LEAD_OTHER)}'::jsonb);")                       # unassigned
assert rc != 0 and "only the assigned salesperson or a manager" in err, err
for uid in (FINANCE, DESIGNER):
    rc, out, err = run_as(uid, f"select public.create_contract('{PAY(LEAD_DESIGNER)}'::jsonb);")
    assert rc != 0 and "may not perform this operation" in err, (ROLE_OF[uid], err)
for uid in (ADMIN, BOSS, OPERATOR):
    rc, out, err = run_as(uid, f"select public.create_contract('{PAY(LEAD_OTHER)}'::jsonb) ->> 'status';")
    assert rc == 0 and out.splitlines()[-1] == "draft", (ROLE_OF[uid], err)
passed("create_contract: sales on their own lead only, as a draft; admin, boss and operator anywhere; finance and designer refused")
# direct insert (the policy layer; once the contract phase is on the guard refuses all direct inserts as well)
INS = lambda uid, lead, status="draft": f"insert into public.contracts (lead_id, contract_no, contract_amount, party_a_name, sales_id, created_by, status) values ('{lead}', 'S2-D-{uuid.uuid4().hex[:6]}', 1, 'x', '{uid}', '{uid}', '{status}');"
for uid in (FINANCE, DESIGNER):
    rc, out, err = run_as(uid, INS(uid, LEAD_OTHER))
    assert rc != 0, ROLE_OF[uid]
rc, out, err = run_as(SALES, INS(SALES, LEAD_OTHER))                 # not her lead
assert rc != 0
rc, out, err = run_as(SALES, INS(SALES, LEAD_DESIGNER, "active"))    # her lead, not a draft
assert rc != 0
assert query("select public.is_my_lead('%s')" % LEAD_DESIGNER) in ("f",)   # superuser has no auth.uid()
rc, out, err = run_as(SALES, f"select public.is_my_lead('{LEAD_DESIGNER}'), public.is_my_lead('{LEAD_OTHER}');")
assert rc == 0 and out.splitlines()[-1] == "t|f", (out, err)
passed("direct insert: finance, designer, a salesperson on another's lead and a non-draft are refused; the ownership test sees only the caller's own leads")

# 7. approval: first step unchanged (operator ok, boss not), second step admin or boss
base = f"""
create temp table t_c as select (public.convert_quotation_to_contract('{QUOTE}', '{SCHEDULE}'::jsonb) ->> 'contract_id')::uuid as cid;
select public.set_contract_status(cid, 'pending_admin', 'go') from t_c;
"""
def as_second(uid):
    return run_as(ADMIN, base + "select public.approve_contract(cid, null, 'approve', 'one') from t_c; "
                  + f"reset role; {act_as(uid)} select public.approve_contract(cid, null, 'approve', 'two') from t_c;")
for uid in (ADMIN, BOSS):
    rc, out, err = as_second(uid)
    assert rc == 0, (ROLE_OF[uid], err)
for uid in (OPERATOR, FINANCE, SALES):
    rc, out, err = as_second(uid)
    assert rc != 0 and "may not perform" in err, (ROLE_OF[uid], err)
rc, out, err = run_as(ADMIN, base + f"reset role; {act_as(BOSS)} select public.approve_contract(cid, null, 'approve', 'x') from t_c;")
assert rc != 0 and "may not perform" in err, err
rc, out, err = run_as(ADMIN, base + f"reset role; {act_as(OPERATOR)} select public.approve_contract(cid, null, 'approve', 'x') from t_c;")
assert rc == 0, err
passed("the boss approval step accepts admin and boss only; the first step is unchanged (admin/operator, not boss)")

# 8. discount constraint
rc, out, err = run_as(ADMIN, "reset role; insert into public.quotations (lead_id, quote_no, subtotal, total_amount, discount_rate) values ('%s', 'NM-S2-DISC-1', 1, 1, 150);" % LEAD_OTHER)
assert rc != 0 and "quotations_discount_rate_range" in err, err
rc, out, err = run_as(ADMIN, "reset role; insert into public.quotations (lead_id, quote_no, subtotal, total_amount, discount_rate) values ('%s', 'NM-S2-DISC-2', 1, 1, -1);" % LEAD_OTHER)
assert rc != 0 and "quotations_discount_rate_range" in err, err
for v in ("0", "100", "12.5"):
    rc, out, err = run_as(ADMIN, "reset role; insert into public.quotations (lead_id, quote_no, subtotal, total_amount, discount_rate) values ('%s', 'NM-S2-DISC-3', 1, 1, %s);" % (LEAD_OTHER, v))
    assert rc == 0, (v, err)
assert query("select convalidated from pg_constraint where conname = 'quotations_discount_rate_range'") == "f"
passed("quotation discount outside 0..100 is refused for new rows; the check is NOT VALID so old rows are not scanned")

# 9. two sessions activate the same contract at once: one customer, one project
marker = "s2c-" + uuid.uuid4().hex[:8]
lead = str(uuid.uuid4()); quote = str(uuid.uuid4()); admin2 = str(uuid.uuid4())
try:
    query(f"""
insert into auth.users (id, email, email_confirmed_at, created_at) values ('{admin2}', '{admin2}@s2.invalid', now(), now());
insert into public.profiles (id, email, role, is_active, full_name) values ('{admin2}', '{admin2}@s2.invalid', 'admin', true, 'S2 admin');
insert into public.leads (id, source, customer_name, phone, stage, quality) values ('{lead}', 'offline', '{marker}', '+971500000777', 'negotiation', 'normal');
insert into public.quotations (id, lead_id, quote_no, subtotal, total_amount, status, created_by) values ('{quote}', '{lead}', 'NM-{marker}', 1000, 1000, 'accepted', '{admin2}');
""")
    claims = json.dumps({"sub": admin2, "role": "authenticated", "iat": 4102444800})
    pre = f"select set_config('request.jwt.claims', '{claims}', false); set role authenticated;"
    cid = query(pre + f"select (public.convert_quotation_to_contract('{quote}', '{SCHEDULE}'::jsonb) ->> 'contract_id');").splitlines()[-1]
    query(pre + f"select public.set_contract_status('{cid}', 'pending_admin', 'go'); select public.approve_contract('{cid}', null, 'approve', 'a'); select public.approve_contract('{cid}', null, 'approve', 'b');")
    results = []
    def worker():
        results.append(run(pre + f"select pg_sleep(0.2); select public.set_contract_status('{cid}', 'active', null);"))
    ts = [threading.Thread(target=worker) for _ in range(2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    ok = [r for r in results if r.returncode == 0]
    assert len(ok) >= 1, [r.stderr for r in results]
    for r in results:
        assert r.returncode == 0 or "not a permitted transition" in r.stderr, r.stderr   # the loser finds it already active
    assert query(f"select (select count(*) from public.customers where lead_id = '{lead}') || '/' || (select count(*) from public.projects where lead_id = '{lead}') || '/' || (select count(*) from public.business_events where lead_id = '{lead}' and event_type = 'won') || '/' || (select stage from public.leads where id = '{lead}')") == "1/1/1/won"
    passed("two sessions activating the same contract at once leave one customer, one project and one won event")
finally:
    query(f"""
update public.quotations set contract_id = null where lead_id = '{lead}';
delete from public.projects where lead_id = '{lead}';
delete from public.installment_plans where contract_id in (select id from public.contracts where lead_id = '{lead}');
delete from public.contract_approvals where contract_id in (select id from public.contracts where lead_id = '{lead}');
delete from public.contracts where lead_id = '{lead}';
delete from public.quotations where lead_id = '{lead}';
delete from public.customers where lead_id = '{lead}';
delete from public.business_events where lead_id = '{lead}';
delete from public.activities where lead_id = '{lead}';
delete from public.leads where id = '{lead}';
delete from public.profiles where id = '{admin2}';
delete from auth.users where id = '{admin2}';
""")

print(f"{len(checks)} contract activation checks passed")
