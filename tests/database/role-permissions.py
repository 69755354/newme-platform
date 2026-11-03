#!/usr/bin/env python3
"""Role permission behaviour on an isolated PostgreSQL database, never production.

OS fix stream S2 (review 2026-11-03: 0-总报告 挡住干活#3 / 安全风险#1, 2-security
F-06, 4c problems 1-3). Runs the same way as whatsapp-privacy.py:

  PGDATABASE=newme_role_permissions_test PGHOST=127.0.0.1 python3 tests/database/role-permissions.py

against a database created from the replayed `history` template (production
baseline + every pending migration, including 20261104110000_role_least_privilege).

Every scenario runs inside one transaction that is rolled back, acting as the
`authenticated` PostgREST role with the claim shape GoTrue issues, so nothing the
file does survives it. Each check prints PASS <name>; any assertion failure is a
non-zero exit.
"""
import json
import os
import subprocess
import uuid

assert os.environ.get("PGDATABASE") == "newme_role_permissions_test", "explicit isolated database required"
assert os.environ.get("PGHOST") in ("127.0.0.1", "localhost"), "loopback test database required"
COMMAND = ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1"]

def run(sql):
    return subprocess.run(COMMAND, input=sql, capture_output=True, text=True, timeout=60)

def query(sql):
    p = run(sql)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()

checks = []
def passed(name):
    checks.append(name)
    print("PASS " + name, flush=True)

# Fixed identities; every one is created and rolled back inside each scenario.
ADMIN    = "d2000000-0000-4000-8000-000000000001"
BOSS     = "d2000000-0000-4000-8000-000000000002"
OPERATOR = "d2000000-0000-4000-8000-000000000003"
SALES    = "d2000000-0000-4000-8000-000000000004"
FINANCE  = "d2000000-0000-4000-8000-000000000005"
DESIGNER = "d2000000-0000-4000-8000-000000000006"
ROLE_OF = {ADMIN: "admin", BOSS: "boss", OPERATOR: "operator", SALES: "sales", FINANCE: "finance", DESIGNER: "designer"}

LEAD_SALES    = "d2100000-0000-4000-8000-000000000001"   # assigned to SALES, has a contract
LEAD_DESIGNER = "d2100000-0000-4000-8000-000000000002"   # assigned to SALES, project managed by DESIGNER
LEAD_OTHER    = "d2100000-0000-4000-8000-000000000003"   # unassigned, nobody involved
PRODUCT       = "d2200000-0000-4000-8000-000000000001"

FIXTURE = f"""
insert into auth.users (id, email, email_confirmed_at, created_at)
select id::uuid, id || '@s2.invalid', now() - interval '30 days', now() - interval '30 days'
  from unnest(array['{ADMIN}','{BOSS}','{OPERATOR}','{SALES}','{FINANCE}','{DESIGNER}']) id;
insert into public.profiles (id, email, role, is_active, full_name)
values ('{ADMIN}', '{ADMIN}@s2.invalid', 'admin', true, 'S2 admin'),
       ('{BOSS}', '{BOSS}@s2.invalid', 'boss', true, 'S2 boss'),
       ('{OPERATOR}', '{OPERATOR}@s2.invalid', 'operator', true, 'S2 operator'),
       ('{SALES}', '{SALES}@s2.invalid', 'sales', true, 'S2 sales'),
       ('{FINANCE}', '{FINANCE}@s2.invalid', 'finance', true, 'S2 finance'),
       ('{DESIGNER}', '{DESIGNER}@s2.invalid', 'designer', true, 'S2 designer');
insert into public.leads (id, source, customer_name, phone, stage, quality, assigned_to)
values ('{LEAD_SALES}', 'offline', 'S2 lead one', '+971500000901', 'contacted', 'normal', '{SALES}'),
       ('{LEAD_DESIGNER}', 'offline', 'S2 lead two', '+971500000902', 'contacted', 'normal', '{SALES}'),
       ('{LEAD_OTHER}', 'offline', 'S2 lead three', '+971500000903', 'new', null, null);
insert into public.projects (name, lead_id, project_manager)
values ('S2 project', '{LEAD_DESIGNER}', '{DESIGNER}');
insert into public.activities (lead_id, user_id, type, content)
values ('{LEAD_SALES}', '{SALES}', 'note', 'S2 private note one'),
       ('{LEAD_DESIGNER}', '{SALES}', 'note', 'S2 note two'),
       ('{LEAD_OTHER}', '{ADMIN}', 'note', 'S2 private note three');
insert into public.business_events (lead_id, user_id, event_type, description)
values ('{LEAD_SALES}', '{SALES}', 'stage_change', 'S2 event one'),
       ('{LEAD_OTHER}', '{ADMIN}', 'stage_change', 'S2 event three');
insert into public.transfer_history (lead_id, to_user_id, transferred_by)
values ('{LEAD_SALES}', '{SALES}', '{ADMIN}');
insert into public.products (id, sku, name, unit_price)
values ('{PRODUCT}', 'S2-SKU', 'S2 product', 10);
insert into public.contracts (lead_id, contract_no, contract_amount, party_a_name, sales_id, created_by, status)
values ('{LEAD_SALES}', 'S2-CONTRACT-1', 100, 'S2 customer', '{SALES}', '{SALES}', 'draft');
insert into public.follow_up_logs (lead_id, user_id, contact_type, summary, contact_time, contact_result)
values ('{LEAD_SALES}', '{SALES}', 'call', 'S2 contact', now(), 'answered'),
       ('{LEAD_OTHER}', '{ADMIN}', 'call', 'S2 contact', now(), 'answered');
update public.leads set quality = 'normal' where id = '{LEAD_OTHER}';
insert into public.lead_milestones (lead_id, milestone_key, completed_by)
values ('{LEAD_SALES}', 'first_contact', '{SALES}'),
       ('{LEAD_OTHER}', 'first_contact', '{ADMIN}');
"""

def act_as(uid):
    claims = json.dumps({"sub": uid, "role": "authenticated", "iat": 4102444800})
    return f"select set_config('request.jwt.claims', '{claims}', true); set local role authenticated;"

def scenario(uid, body):
    """Fixture + act as uid + body, all rolled back. Returns (rc, stdout, stderr)."""
    p = run("begin;\n" + FIXTURE + act_as(uid) + "\n" + body + "\nrollback;")
    return p.returncode, p.stdout.strip(), p.stderr

def count(uid, sql):
    rc, out, err = scenario(uid, sql)
    assert rc == 0, err
    return int(out.splitlines()[-1])

# ---------------------------------------------------------------------------
# 1. Operator may close a lead (won/lost) through transition_lead_stage
# ---------------------------------------------------------------------------
def transition(uid, lead, expected, nxt):
    key = str(uuid.uuid4())
    rc, out, err = scenario(uid,
        f"select public.transition_lead_stage('{lead}', '{expected}', '{nxt}', 'S2 note', '{key}');")
    return rc, out, err

rc, out, err = transition(OPERATOR, LEAD_OTHER, "new", "lost")
assert rc == 0, err
assert json.loads(out.splitlines()[-1])["final_status"] == "lost"
rc, out, err = transition(OPERATOR, LEAD_SALES, "contacted", "won")
assert rc == 0 and json.loads(out.splitlines()[-1])["stage"] == "won", err
rc, out, err = transition(OPERATOR, LEAD_SALES, "new", "won")
assert rc != 0 and "Lead stage changed concurrently" in err, err
passed("operator can mark a lead won or lost through transition_lead_stage; a stale expected stage still reports the unchanged conflict message")

for uid in (ADMIN, BOSS):
    rc, out, err = transition(uid, LEAD_SALES, "contacted", "won")
    assert rc == 0, err
passed("admin and boss keep full stage-transition rights")

rc, out, err = transition(SALES, LEAD_OTHER, "new", "lost")
assert rc != 0 and "not assigned to you" in err, err
for uid in (FINANCE, DESIGNER):
    rc, out, err = transition(uid, LEAD_SALES, "contacted", "won")
    assert rc != 0 and "invalid CRM role" in err, err
passed("sales stays limited to own leads; finance and designer cannot transition any lead")

# ---------------------------------------------------------------------------
# 2. Designer / finance no longer read company-wide lead data
# ---------------------------------------------------------------------------
for table in ("activities", "business_events", "lead_milestones", "transfer_history", "customers", "lead_files", "lead_documents"):
    assert count(FINANCE, f"select count(*) from public.{table};") == 0, table
passed("finance reads no activities, events, milestones, transfers, customers or lead files")

assert count(FINANCE, "select count(*) from public.contracts where contract_no = 'S2-CONTRACT-1';") == 1
assert count(FINANCE, f"select count(*) from public.leads where id in ('{LEAD_SALES}','{LEAD_DESIGNER}','{LEAD_OTHER}');") == 0
assert count(FINANCE, f"select count(*) from public.contract_lead_display('{LEAD_SALES}') where customer_name = 'S2 lead one';") == 1
assert count(FINANCE, f"select count(*) from public.contract_lead_display('{LEAD_OTHER}');") == 0
assert count(DESIGNER, f"select count(*) from public.contract_lead_display('{LEAD_SALES}');") == 0
assert count(SALES, f"select count(*) from public.contract_lead_display('{LEAD_SALES}');") == 1
passed("finance reads contracts and no lead rows; the contract customer name comes from contract_lead_display() for roles that may see the contract")

assert count(DESIGNER, "select count(*) from public.activities where content like 'S2 %';") == 1
assert count(DESIGNER, f"select count(*) from public.activities where lead_id = '{LEAD_DESIGNER}';") == 1
assert count(DESIGNER, "select count(*) from public.business_events where description like 'S2 %';") == 0
assert count(DESIGNER, "select count(*) from public.lead_milestones where lead_id in ('%s','%s');" % (LEAD_SALES, LEAD_OTHER)) == 0
assert count(DESIGNER, "select count(*) from public.transfer_history;") == 0
assert count(DESIGNER, f"select count(*) from public.leads where id in ('{LEAD_SALES}','{LEAD_DESIGNER}','{LEAD_OTHER}');") == 1
assert count(DESIGNER, "select count(*) from public.projects where name = 'S2 project';") == 1
passed("designer reads only the leads, activities and projects it is involved in")

# review B-1: no way to become "involved" by writing projects
for uid in (DESIGNER, FINANCE):
    rc, out, err = scenario(uid, f"insert into public.projects (name, lead_id, sales_id, project_manager) values ('evil', '{LEAD_OTHER}', '{uid}', '{uid}');")
    # the BEFORE INSERT trigger fires ahead of the policy check; either refusal is the boundary
    assert rc != 0 and ("row-level security" in err or "assigned to you" in err), (uid, err)
    rc, out, err = scenario(uid, f"insert into public.projects (name, sales_id, project_manager) values ('evil', '{uid}', '{uid}');")
    assert rc != 0 and "row-level security" in err, (uid, err)
rc, out, err = scenario(DESIGNER, f"update public.projects set lead_id = '{LEAD_OTHER}' where name = 'S2 project';")
assert rc != 0 and "manager only" in err, err
rc, out, err = scenario(DESIGNER, f"update public.projects set assigned_to = '{SALES}' where name = 'S2 project';")
assert rc != 0 and "manager only" in err, err
assert count(DESIGNER, "update public.projects set name = 'S2 project renamed' where name = 'S2 project'; select count(*) from public.projects where name = 'S2 project renamed';") == 1
rc, out, err = scenario(SALES, f"insert into public.projects (name, lead_id, sales_id) values ('evil', '{LEAD_OTHER}', '{SALES}');")
assert rc != 0 and "assigned to you" in err, err
assert count(SALES, f"insert into public.projects (name, lead_id, sales_id) values ('mine', '{LEAD_SALES}', '{SALES}'); select count(*) from public.projects where name = 'mine';") == 1
rc, out, err = scenario(SALES, f"update public.projects set lead_id = '{LEAD_OTHER}' where name = 'S2 project'; reset role; select count(*) from public.projects where name = 'S2 project' and lead_id = '{LEAD_DESIGNER}';")
assert rc == 0 and out.splitlines()[-1] == "1", (out, err)   # not the salesperson's project: untouched
assert count(ADMIN, f"update public.projects set lead_id = '{LEAD_SALES}' where name = 'S2 project'; select count(*) from public.projects where name = 'S2 project' and lead_id = '{LEAD_SALES}';") == 1
passed("designer, finance and sales cannot attach or re-point a project to a lead that is not theirs; managers can")

# review B-1: lead_workflow_stages no longer leaks lead ids and notes
rc, out, err = scenario(DESIGNER,
    f"reset role; insert into public.lead_workflow_stages (lead_id, stage_key, notes) values ('{LEAD_OTHER}', 'design', 'S2 secret'), ('{LEAD_DESIGNER}', 'design', 'S2 visible'); "
    + act_as(DESIGNER) + " select count(*) || ':' || coalesce(string_agg(notes, ','), '') from public.lead_workflow_stages where notes like 'S2 %';")
assert rc == 0 and out.splitlines()[-1] == "1:S2 visible", (out, err)
passed("designer reads workflow stages only for its involved leads")

# review F-6: file records and customers
for uid in (DESIGNER, FINANCE):
    rc, out, err = scenario(uid, f"insert into public.lead_files (lead_id, uploaded_by, file_name, file_path) values ('{LEAD_OTHER}', '{uid}', 'x', 'x');")
    assert rc != 0 and "row-level security" in err, (uid, err)
    rc, out, err = scenario(uid, f"insert into public.customers (name, assigned_sales_id) values ('S2 cust', '{uid}');")
    assert rc != 0 and "row-level security" in err, (uid, err)
assert count(DESIGNER, f"insert into public.lead_files (lead_id, uploaded_by, file_name, file_path) values ('{LEAD_DESIGNER}', '{DESIGNER}', 'x', 'x'); select count(*) from public.lead_files where lead_id = '{LEAD_DESIGNER}';") == 1
assert count(SALES, f"insert into public.customers (name, assigned_sales_id) values ('S2 cust', '{SALES}'); select count(*) from public.customers where name = 'S2 cust';") == 1
passed("designer and finance cannot attach files to leads they do not see or create customers; designer may file on its own lead, sales still creates customers")

# designer insert on an invisible lead refused; on an involved lead allowed
rc, out, err = scenario(DESIGNER,
    f"insert into public.activities (lead_id, user_id, type, content) values ('{LEAD_OTHER}', '{DESIGNER}', 'note', 'S2 injected');")
assert rc != 0 and "row-level security" in err, err
rc, out, err = scenario(DESIGNER,
    f"insert into public.activities (lead_id, user_id, type, content) values ('{LEAD_DESIGNER}', '{DESIGNER}', 'note', 'S2 own note'); select count(*) from public.activities where content = 'S2 own note';")
assert rc == 0 and out.splitlines()[-1] == "1", err
passed("designer can add an activity only on a lead it is involved in, as itself")

# lead creation: finance / designer refused, sales allowed (own or unassigned)
for uid in (FINANCE, DESIGNER):
    rc, out, err = scenario(uid, "insert into public.leads (source, customer_name, phone) values ('offline', 'S2 injected lead', '+971500000999');")
    assert rc != 0 and "row-level security" in err, (uid, err)
assert count(SALES, f"insert into public.leads (source, customer_name, phone, assigned_to) values ('offline', 'S2 sales lead', '+971500000998', '{SALES}'); select count(*) from public.leads where customer_name = 'S2 sales lead';") == 1
passed("finance and designer cannot create leads; sales still can")

# product catalogue: designer read-only, finance read-only
for uid in (DESIGNER, FINANCE):
    assert count(uid, f"select count(*) from public.products where id = '{PRODUCT}';") == 1
    rc, out, err = scenario(uid, f"insert into public.products (sku, name, unit_price) values ('S2-NEW', 'S2 new', 1);")
    assert rc != 0 and "row-level security" in err, err
    assert count(uid, f"update public.products set unit_price = 99 where id = '{PRODUCT}'; select count(*) from public.products where id = '{PRODUCT}' and unit_price = 99;") == 0
    assert count(uid, f"delete from public.products where id = '{PRODUCT}'; select count(*) from public.products where id = '{PRODUCT}';") == 1
passed("designer and finance read the product catalogue but cannot write it")

# operator / sales / admin unaffected
assert count(OPERATOR, "select count(*) from public.activities where content like 'S2 %';") == 3
assert count(OPERATOR, f"update public.products set unit_price = 11 where id = '{PRODUCT}'; select count(*) from public.products where id = '{PRODUCT}' and unit_price = 11;") == 1
assert count(SALES, "select count(*) from public.activities where content like 'S2 %';") == 2
assert count(ADMIN, "select count(*) from public.activities where content like 'S2 %';") == 3
passed("admin, operator and sales keep their existing read and write scope")

# ---------------------------------------------------------------------------
# 3. search_path pinned on the advisor-flagged guard functions
# ---------------------------------------------------------------------------
unpinned = query("""
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('money_write_is_direct','guard_contracts_write','guard_payments_write',
                     'guard_installment_plans_write','guard_definer_only_write','require_current_session',
                     'contract_transition_is_allowed','guard_contract_transition','guard_quotations_write')
   and not coalesce(p.proconfig @> array['search_path=pg_catalog, public, pg_temp'], false)
""")
assert unpinned == "0", unpinned
assert query("select count(*) from pg_proc where proname in ('money_write_is_direct','guard_contracts_write','guard_payments_write','guard_installment_plans_write','guard_definer_only_write','require_current_session','contract_transition_is_allowed','guard_contract_transition','guard_quotations_write')") == "9"
passed("the nine guard functions carry a pinned search_path")

# ---------------------------------------------------------------------------
# 4. The release manifest's posture predicate is true here and notices drift
# ---------------------------------------------------------------------------
manifest = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "infra", "release", "release-manifest.json")))
predicate = next(x["sql"] for x in manifest["posture"]["deferred_contract"]["predicates"] if x["name"] == "s2-role-least-privilege-present")
assert query(predicate) == "t", "posture predicate is false on a migrated database"
# each B-1 guard, removed inside a rolled-back transaction, must flip the predicate
for drift in (
    "drop trigger trg_guard_projects_lead_binding on public.projects",
    "drop policy policy_projects_insert_sales on public.projects",
    "create policy policy_lead_workflow_stages_select_designer on public.lead_workflow_stages for select to authenticated using (true)",
    "drop policy lead_files_insert_staff on public.lead_files",
    "drop function public.contract_lead_display(uuid)",
):
    flipped = query(f"begin; {drift}; select ({predicate}); rollback;").splitlines()
    assert flipped and flipped[-1] == "f", (drift, flipped)
passed("the s2-role-least-privilege-present predicate holds after the migration and fails when any guard is removed")

# re-applying the migration is a no-op for the predicate and for the policies
before = query("select md5(string_agg(policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'")
migration = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "supabase", "migrations", "20261104110000_role_least_privilege.sql")
p = subprocess.run(COMMAND + ["-1", "-f", migration], capture_output=True, text=True, timeout=60)
assert p.returncode == 0, p.stderr
assert query("select md5(string_agg(policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'") == before
passed("re-running the migration leaves every policy unchanged")

print(f"{len(checks)} role permission checks passed")
