#!/usr/bin/env python3
"""Behavior tests against an isolated PostgreSQL 17 database, never production.

Use WHATSAPP_TEST_CONTAINER for a container labelled newme.test=whatsapp-privacy,
or PGDATABASE=newme_whatsapp_privacy_test with PGHOST=127.0.0.1 in CI.
The already migrated database must contain zero WhatsApp events/channels.
"""
import json
import os
import pathlib
import re
import subprocess
import time

container = os.environ.get("WHATSAPP_TEST_CONTAINER")
if container:
    assert re.fullmatch(r"newme-wa-privacy-[a-z0-9-]+", container), "unapproved test container"
    label = subprocess.check_output(["docker", "inspect", "--format", '{{index .Config.Labels "newme.test"}}', container], text=True).strip()
    assert label == "whatsapp-privacy", "missing disposable-test label"
    command = ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres"]
else:
    assert os.environ.get("PGDATABASE") == "newme_whatsapp_privacy_test", "explicit isolated database required"
    assert os.environ.get("PGHOST") in ("127.0.0.1", "localhost"), "loopback test database required"
    command = ["psql"]
command += ["-XqAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"]

def query(sql, error=None):
    p = subprocess.run(command, input=sql, capture_output=True, text=True, timeout=30)
    if error:
        assert p.returncode != 0 and error in p.stderr, (error, p.stdout, p.stderr)
        return None
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()

checks = []
def passed(name):
    checks.append(name)
    print("PASS " + name, flush=True)

boss = "f1000000-0000-4000-8000-000000000001"
sales = "f1000000-0000-4000-8000-000000000002"
other_admin = "f1000000-0000-4000-8000-000000000003"
channel_a = "f2000000-0000-4000-8000-000000000001"
channel_b = "f2000000-0000-4000-8000-000000000002"
key_a, key_b = "a" * 64, "b" * 64
request_id = "f3000000-0000-4000-8000-000000000001"

def caller(identity=boss, iat=None):
    claims = json.dumps({"sub": identity, "role": "authenticated", "iat": iat or int(time.time())})
    return "set role authenticated; set request.jwt.claims='" + claims + "';"

def erase(rid=request_id, customer=key_a):
    return f"select public.request_whatsapp_deletion('{rid}','{customer}');"

def event(mid, channel=channel_a, customer=key_a, at="clock_timestamp()-interval '1 minute'", received="clock_timestamp()"):
    return f"""insert into public.whatsapp_pilot_events
      (channel_id,message_id,customer_key,direction,source,message_type,occurred_at,received_at)
      values ('{channel}','{mid}','{customer}','inbound','messages','text',{at},{received}) on conflict do nothing;"""

assert query("select count(*) from public.whatsapp_pilot_channels;") == "0"
assert query("select count(*) from public.whatsapp_pilot_events;") == "0"
assert query("select current_setting('server_version_num')::int/10000;") == "17"
query(f"""
insert into auth.users(id,email,email_confirmed_at) values
('{boss}','privacy-boss@example.invalid',now()),('{sales}','privacy-sales@example.invalid',now()),
('{other_admin}','privacy-admin@example.invalid',now());
insert into public.profiles(id,email,full_name,role,is_active,force_password_change) values
('{boss}','privacy-boss@example.invalid','Privacy Test Boss','boss',true,false),
('{sales}','privacy-sales@example.invalid','Privacy Test Sales','sales',true,false),
('{other_admin}','privacy-admin@example.invalid','Privacy Test Admin','admin',true,false)
on conflict(id) do update set role=excluded.role,is_active=true,force_password_change=false;
insert into public.whatsapp_pilot_channels(id,label,purpose,owner_profile_id,waba_id,phone_number_id,business_phone,enabled,accept_since) values
('{channel_a}','Synthetic A','intake','{boss}','999990001','999990002','15550000001',false,now()-interval '60 days'),
('{channel_b}','Synthetic B','follow_up','{boss}','999990001','999990003','15550000002',false,now()-interval '60 days');
""")

# A service update committed after the read-only gate must still abort schema
# provisioning. Observe the real relation lock before releasing that update.
enabler = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
enabler.stdin.write(f"begin; set role service_role; update public.whatsapp_pilot_channels set enabled=true where id='{channel_a}'; select 'ENABLE_READY';\n")
enabler.stdin.flush()
assert 'ENABLE_READY' in enabler.stdout.readline()
migration = pathlib.Path(__file__).resolve().parents[2] / 'supabase/migrations/20261022194620_whatsapp_privacy_lifecycle.sql'
assert migration.is_file(), 'reviewed migration source required'
installer = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
installer.stdin.write("set application_name='wa_privacy_install_race';\n" + migration.read_text())
installer.stdin.close()
blocked = False
for attempt in range(100):
    if query("select count(*) from pg_stat_activity where application_name='wa_privacy_install_race' and wait_event_type='Lock';") == '1':
        blocked = True
        break
    time.sleep(.02)
assert blocked, 'migration must wait for the concurrent channel update'
enabler.stdin.write('commit;\n'); enabler.stdin.close()
assert enabler.wait(timeout=10) == 0, enabler.stderr.read()
assert installer.wait(timeout=10) != 0
assert 'whatsapp_channels_must_be_disabled' in installer.stderr.read()
query('update public.whatsapp_pilot_channels set enabled=true;')
passed('provisioning locks channel updates and rejects a concurrently enabled channel')

# Database clock and scheduler health, independent of the app's pre-filter.
query("set role service_role;" + event("before-maintenance"), "55000")
query("set role service_role; select public.maintain_whatsapp_privacy();")
query("set role service_role;" + event("fresh", received="now()+interval '100 years'"))
assert query("select (received_at<now()+interval '1 minute' and expires_at=least(occurred_at,received_at)+interval '30 days') from public.whatsapp_pilot_events where message_id='fresh';") == "t"
query("set role service_role;" + event("expired", at="now()-interval '29 days'"))
query("set role service_role;" + event("future", at="now()+interval '6 minutes'"))
assert query("select count(*) from public.whatsapp_pilot_events;") == "1"
query("begin isolation level repeatable read; set role service_role;" + event("wrong-isolation"), "25001")
passed("database admission uses real clock, age, maintenance heartbeat and read-committed isolation")

# Auth is checked before even an idempotent request can return data.
for role in ("anon", "service_role"):
    query(f"set role {role};" + erase(), "42501")
query(caller(sales) + erase(), "42501")
query("set role authenticated;" + erase(), "42501")
for mutation, code, undo in [
    ("is_active=false", "28003", "is_active=true"),
    ("force_password_change=true", "28006", "force_password_change=false"),
    ("password_changed_at=now()+interval '1 hour'", "28005", "password_changed_at=null"),
]:
    query(f"update public.profiles set {mutation} where id='{boss}';")
    query(caller() + erase(), code)
    query(f"update public.profiles set {undo} where id='{boss}';")
query(f"update auth.users set banned_until=now()+interval '1 hour' where id='{boss}';")
query(caller() + erase(), "28004")
query(f"update auth.users set banned_until=null where id='{boss}';")
passed("deletion rejects anonymous, service, sales, missing, disabled, forced, stale and banned sessions")

query("set role service_role;" + event("same-customer-second-channel", channel_b) + event("other-customer", customer=key_b))
receipt = json.loads(query(caller() + erase()))
assert receipt["state"] == "completed" and receipt["deleted_count"] == 2, receipt
assert key_a not in json.dumps(receipt) and boss not in json.dumps(receipt)
assert query(f"select count(*) from public.whatsapp_pilot_events where customer_key='{key_b}';") == "1"
assert json.loads(query(caller() + erase())) == receipt
query(caller() + erase(customer=key_b), "22023")
query(caller(other_admin) + erase(), "22023")
query(f"update public.profiles set is_active=false where id='{boss}';")
query(caller() + erase(), "28003")
query(f"update public.profiles set is_active=true where id='{boss}';")
passed("cross-channel erasure, other-customer isolation, opaque receipt and bound idempotency")

query("set role service_role;" + event("old-replay") + event("new-enquiry", at="clock_timestamp()+interval '1 second'"))
assert query(f"select string_agg(message_id,',') from public.whatsapp_pilot_events where customer_key='{key_a}';") == "new-enquiry"
passed("old retry is suppressed while a later enquiry can be admitted")

for statement in ["delete from public.whatsapp_pilot_events;", "update public.whatsapp_pilot_events set message_type='text';",
                  "truncate public.whatsapp_pilot_events;", "select * from whatsapp_privacy.requests;",
                  "select whatsapp_privacy.reset_after_restore();"]:
    query("set role service_role;" + statement, "42501")
for role in ("anon", "authenticated"):
    query(f"set role {role}; select public.maintain_whatsapp_privacy();", "42501")
    query(f"set role {role}; select * from whatsapp_privacy.suppressions;", "42501")
query(caller() + "reset role; set role service_role; select public.maintain_whatsapp_privacy();", "42501")
query("set role newme_whatsapp_maintenance; select * from public.leads;", "42501")
query("set role newme_whatsapp_maintenance; select * from public.profiles;", "42501")
passed("server cleanup has narrow privileges and cannot read CRM; web service cannot directly erase rows")

# Two real sessions. Wait until PostgreSQL reports the second writer blocked on
# our advisory lock, then commit the first. No timing-only concurrency assertion.
def raced(first_sql, second_sql):
    first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    first.stdin.write("begin;" + first_sql + "select 'FIRST_READY';\n"); first.stdin.flush()
    while True:
        line = first.stdout.readline()
        assert line, first.stderr.read()
        if "FIRST_READY" in line: break
    second = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    second.stdin.write("set application_name='wa_privacy_race_second';" + second_sql + "\n"); second.stdin.close()
    blocked = False
    try:
        for _ in range(100):
            if query("select exists(select from pg_stat_activity where application_name='wa_privacy_race_second' and wait_event='advisory');") == "t":
                blocked = True; break
            assert second.poll() is None, "second session completed without the expected lock"
            time.sleep(.03)
        assert blocked, "second writer never waited on the shared lock"
    finally:
        first.stdin.write("commit;\n"); first.stdin.close()
    first.wait(15); second.wait(15)
    assert first.returncode == 0, first.stderr.read()
    assert second.returncode == 0, second.stderr.read()

for index, deletion_first in enumerate([False, True], 2):
    key = str(index) * 64
    rid = f"f3000000-0000-4000-8000-{index:012d}"
    insert = "set role service_role;" + event(f"raced-{index}", customer=key)
    deletion = caller() + erase(rid, key)
    raced(deletion if deletion_first else insert, insert if deletion_first else deletion)
    assert query(f"select count(*) from public.whatsapp_pilot_events where customer_key='{key}';") == "0"
passed("real concurrent insertion/deletion serializes correctly in both arrival orders")

# Fixtures can only be aged by the test database owner; applications cannot.
query("update public.whatsapp_pilot_events set occurred_at=now()-interval '29 days',received_at=now()-interval '29 days',expires_at=now()+interval '1 day'-interval '1 second';")
cleanup = json.loads(query("set role service_role; select public.maintain_whatsapp_privacy();"))
assert cleanup["deleted_expired"] == 2 and cleanup["backlog"] is False, cleanup
assert query("select count(*) from public.whatsapp_pilot_events;") == "0"
query("update whatsapp_privacy.maintenance set last_completed_at=now()-interval '16 minutes';")
assert json.loads(query(caller() + "select public.whatsapp_privacy_status();"))["healthy"] is False
query("set role service_role;" + event("stale-maintenance", customer=key_b), "55000")
query("set role service_role; select public.maintain_whatsapp_privacy();")
query("set role service_role;" + event("back-after-cleanup", customer=key_b))
assert json.loads(query(caller() + "select public.whatsapp_privacy_status();"))["healthy"] is True
passed("physical early purge, stale-job fail-closed and recovery after successful maintenance")

# More than one bounded batch, including physically expired rows. Owner-only
# fixture ageing simulates missed maintenance without waiting a month.
query(f"""insert into public.whatsapp_pilot_events(channel_id,message_id,customer_key,direction,source,message_type,occurred_at)
select '{channel_a}','batch-'||n,'{key_b}','inbound','messages','text',now()-interval '1 minute'
from generate_series(1,5001) n;
update public.whatsapp_pilot_events set occurred_at=now()-interval '31 days',received_at=now()-interval '31 days',expires_at=now()-interval '1 day'
where message_id like 'batch-%';""")
query("set role service_role;" + event("expired-backlog-blocks", customer=key_b), "55000")
first_batch = json.loads(query("set role service_role; select public.maintain_whatsapp_privacy();"))
assert first_batch["deleted_expired"] == 5000 and first_batch["backlog"] is True
second_batch = json.loads(query("set role service_role; select public.maintain_whatsapp_privacy();"))
assert second_batch["deleted_expired"] == 1 and second_batch["backlog"] is False
passed("expired backlog blocks admission and drains in bounded 5000-row batches")

# A transaction that waits over the admission margin must roll back at commit.
query("begin; set role service_role;" + event("commit-boundary", customer=key_b,
      at="clock_timestamp()-interval '29 days'+interval '150 milliseconds'") + "select pg_sleep(.2); commit;", "40001")
assert query("select count(*) from public.whatsapp_pilot_events where message_id='commit-boundary';") == "0"
passed("deferred commit-age guard rolls back an event that ages out inside its transaction")

query("update whatsapp_privacy.requests set deadline_at=now()-interval '1 second'; update whatsapp_privacy.suppressions set expires_at=now()-interval '1 second';")
query("set role service_role; select public.maintain_whatsapp_privacy();")
assert query("select count(*) from whatsapp_privacy.requests;") == "0"
assert query("select count(*) from whatsapp_privacy.suppressions;") == "0"
passed("completed requests and minimal replay-suppression records expire")

# Durable pending work can be completed by the next scheduler run, without a
# browser session or the customer's raw phone number.
query(f"""insert into whatsapp_privacy.requests values
('f3000000-0000-4000-8000-000000000099','{key_b}','{boss}',now(),now()+interval '30 days',now(),'pending',null,0);
insert into whatsapp_privacy.suppressions values('{key_b}',now(),now()+interval '30 days');""")
pending = json.loads(query(caller() + "select public.whatsapp_privacy_status();"))
assert pending["pending_requests"] == 1
assert key_b not in json.dumps(pending) and boss not in json.dumps(pending)
assert json.loads(query("set role service_role; select public.maintain_whatsapp_privacy();"))["completed_requests"] == 1
assert query("select count(*) from public.whatsapp_pilot_events;") == "0"
passed("scheduled maintenance resumes a durable pending deletion and status omits customer references")

# Recreate one synthetic row after the cutoff for the restore check.
query("set role service_role;" + event("restore-fixture", customer=key_b, at="clock_timestamp()+interval '1 second'"))

# Restore quarantine is an operations-only action. Test in this disposable DB.
assert query("select whatsapp_privacy.reset_after_restore();") == "1"
assert query("select count(*) from public.whatsapp_pilot_events;") == "0"
assert query("select count(*) from public.whatsapp_pilot_channels where enabled;") == "0"
assert query("select count(*) from public.whatsapp_pilot_channels where accept_since>now();") == "2"
assert json.loads(query(caller() + "select public.whatsapp_privacy_status();"))["healthy"] is False
passed("restore quarantine removes observer history and disables both channels before reuse")
print(json.dumps({"whatsapp_privacy_database": "passed", "checks": checks, "synthetic_only": True}), flush=True)
