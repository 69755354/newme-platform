#!/usr/bin/env python3
"""Policy-equivalence check for 20261104110000_role_least_privilege (local PostgreSQL only).

Proves that wrapping session_token_is_current() in a scalar sub-select changed NO
rule's meaning: a database from BEFORE the migration (PRE_S2_DATABASE, a template
that has every earlier migration but not this one) is cloned, every policy is
snapshotted, the migration is applied, and the snapshots are compared policy by
policy. The only differences allowed are

  (a) the wrapper itself: `session_token_is_current()` versus
      `( SELECT session_token_is_current() AS session_token_is_current)`, and
  (b) the policies this migration deliberately adds, drops or rewrites (the explicit
      list below, reviewed against the migration's own header).

Everything else -- command, roles, permissive/restrictive, qual, with_check --
must be byte-identical after the wrapper is normalised away.

  PRE_S2_DATABASE=s2base PGHOST=127.0.0.1 python3 tests/database/policy-equivalence.py
"""
import os, re, subprocess

PRE = os.environ.get("PRE_S2_DATABASE")
assert PRE, "PRE_S2_DATABASE (template without the S2 migration) is required"
assert os.environ.get("PGHOST") in ("127.0.0.1", "localhost"), "loopback test database required"
TMP = "s2_policy_equiv_%d" % os.getpid()
MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "supabase", "migrations", "20261104110000_role_least_privilege.sql")

INTENDED = set("""activities.policy_activities_insert_designer
activities.policy_activities_insert_designer_involved
activities.policy_activities_insert_sales
activities.policy_activities_select_designer
activities.policy_activities_select_designer_involved
activities.policy_activities_select_finance
business_events.policy_business_events_select_designer
business_events.policy_business_events_select_designer_involved
business_events.policy_business_events_select_finance
contracts.policy_contracts_insert_admin
contracts.policy_contracts_insert_finance
contracts.policy_contracts_insert_sales
crm_daily_funnel_snapshot.policy_crm_daily_funnel_snapshot_select_designer
customers.policy_customers_insert_sales
customers.policy_customers_select_designer
customers.policy_customers_select_designer_involved
customers.policy_customers_select_finance
knx_designs.policy_knx_designs_select_designer
knx_designs.policy_knx_designs_select_designer_involved
knx_designs.policy_knx_designs_select_finance
lead_documents.policy_lead_documents_select_designer
lead_documents.policy_lead_documents_select_designer_involved
lead_documents.policy_lead_documents_select_finance
lead_files.lead_files_insert_staff
lead_files.policy_lead_files_select_designer
lead_files.policy_lead_files_select_designer_involved
lead_files.policy_lead_files_select_finance
lead_milestones.policy_lead_milestones_select_designer
lead_milestones.policy_lead_milestones_select_designer_involved
leads.policy_leads_insert_sales
leads.policy_leads_select_designer_involved
lead_workflow_stages.policy_lead_workflow_stages_select_designer
lead_workflow_stages.policy_lead_workflow_stages_select_designer_involved
marketing_campaigns.policy_marketing_campaigns_select_designer
products.policy_products_delete_designer
products.policy_products_insert_designer
products.policy_products_update_designer
projects.policy_projects_insert_designer
projects.policy_projects_insert_sales
projects.policy_projects_select_designer
projects.policy_projects_select_designer_involved
projects.policy_projects_update_designer
projects.policy_projects_update_designer_involved
projects.policy_projects_update_sales
transfer_history.policy_transfer_history_select_designer
transfer_history.policy_transfer_history_select_finance""".split())

def psql(db, sql=None, f=None):
    cmd = ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", db]
    cmd += ["-1", "-f", f] if f else ["-c", sql]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr
    return p.stdout

WRAPPED = re.compile(r"\(? ?SELECT (?:public\.)?session_token_is_current\(\) AS session_token_is_current\)", re.I)

def snapshot(db):
    out = {}
    names = psql(db, "select tablename||'.'||policyname from pg_policies where schemaname='public' order by 1").splitlines()
    for n in names:
        t, pol = n.split(".", 1)
        out[n] = psql(db, "select permissive||'~~'||roles::text||'~~'||cmd||'~~'||coalesce(qual,'<null>')||'~~'||coalesce(with_check,'<null>') "
                          "from pg_policies where schemaname='public' and tablename='%s' and policyname='%s'" % (t, pol)).strip()
    return out

def count_session(db):
    return int(psql(db, "select count(*) from pg_policies where schemaname='public' and (qual ~ 'session_token_is_current' or with_check ~ 'session_token_is_current')").strip())

def count_bare(db):
    return int(psql(db, "select count(*) from pg_policies where schemaname='public' and ((qual ~ 'session_token_is_current[(][)]' and qual !~* 'select[[:space:]]+(public[.])?session_token_is_current') or (with_check ~ 'session_token_is_current[(][)]' and with_check !~* 'select[[:space:]]+(public[.])?session_token_is_current'))").strip())

subprocess.run(["createdb", "--template", PRE, TMP], check=True)
try:
    before = snapshot(TMP)
    n_before = count_session(TMP)
    n_profiles = int(psql(TMP, "select count(*) from pg_policies where schemaname='public' and tablename='profiles' and (qual ~ 'session_token_is_current' or with_check ~ 'session_token_is_current')").strip())
    assert n_before > 0 and count_bare(TMP) == n_before, (n_before, count_bare(TMP))
    psql(TMP, f=MIGRATION)
    after = snapshot(TMP)
    # profiles keeps the bare call on purpose (see the migration): everything else is wrapped
    assert count_bare(TMP) == n_profiles, ("a session check is still evaluated per row", count_bare(TMP), n_profiles)
    assert count_session(TMP) == n_before
    changed = set()
    for n in set(before) | set(after):
        if n in INTENDED:
            continue
        assert n in before and n in after, ("policy appeared or vanished outside the intended list", n)
        if WRAPPED.sub("session_token_is_current()", after[n]) != before[n]:
            changed.add(n)
    assert not changed, ("rules changed beyond the session wrapper", sorted(changed))
    for n in INTENDED:
        assert n in before or n in after, n
    wrapped = sum(1 for n in after if WRAPPED.search(after[n]))
    assert wrapped == n_before - n_profiles, (wrapped, n_before, n_profiles)
    print("PASS %d session-checking policies are all wrapped; %d other policies are identical; %d changed on purpose"
          % (wrapped, len(set(before) & set(after)) - len(INTENDED & set(before) & set(after)) - wrapped, len(INTENDED)))
finally:
    subprocess.run(["dropdb", "--if-exists", TMP], check=False)
