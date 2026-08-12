#!/usr/bin/env python3
"""Reset sales passwords and run full CRM matrix test"""
import json, urllib.request, os


def credential(name):
    """Test credentials come from the environment.

    Plaintext passwords for four identities were published below until
    2026-08-12; see supabase/preflight/f02-credential-cutover.md §7. This
    refuses rather than defaulting: a default is how the published value got
    here in the first place.
    """
    configured = os.environ.get(name)
    if not configured:
        raise SystemExit(f"{name} is not set; this harness does not run unconfigured")
    return configured

os.chdir('/home/ubuntu/newme-platform')
with open('.env.local') as f:
    env = dict(line.strip().split('=', 1) for line in f if '=' in line and not line.startswith('#'))

pat = env['SUPABASE_PAT']
url_base = env['NEXT_PUBLIC_SUPABASE_URL']
anon_key = env['NEXT_PUBLIC_SUPABASE_ANON_KEY']

# Step 1: Get service_role key via Mgmt API
req = urllib.request.Request(
    "https://api.supabase.com/v1/projects/vfopmpxlhwzpxqegayew/api-keys",
    headers={"Authorization": f"Bearer {pat}"}
)
resp = urllib.request.urlopen(req, timeout=10)
keys = json.loads(resp.read())
service_key = next(k['api_key'] for k in keys if k['name'] == 'service_role')
print(f"✅ Got service_role key (len={len(service_key)})")

# Step 2: Reset sales passwords
sales_users = {
    "4dc710b5-9e5c-4ad6-a601-0a4f5945cba1": "Faheem",
    "3666d8d0-baf4-45cb-8e7f-4243c999b2b1": "Mohamed"
}
for uid, name in sales_users.items():
    data = json.dumps({"password": credential("NEWME_TEST_SALES_PASSWORD")}).encode()
    req = urllib.request.Request(
        f"{url_base}/auth/v1/admin/users/{uid}",
        data=data,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json"
        },
        method="PUT"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        body = json.loads(resp.read())
        print(f"✅ {name}: password reset")
    except Exception as e:
        print(f"❌ {name}: {e}")

# Step 3: Login all accounts
accounts = [
    ("admin@newme.ae", credential("NEWME_TEST_ADMIN_PASSWORD"), "admin"),
    ("tanya@newme.ae", credential("NEWME_TEST_TANYA_PASSWORD"), "boss"),
    ("faheem@newme.ae", credential("NEWME_TEST_FAHEEM_PASSWORD"), "sales-Faheem"),
    ("mohamed@newme.ae", credential("NEWME_TEST_MOHAMED_PASSWORD"), "sales-Mohamed"),
]

tokens = {}
for email, pwd, label in accounts:
    data = json.dumps({"email": email, "password": pwd}).encode()
    req = urllib.request.Request(
        f"{url_base}/auth/v1/token?grant_type=password",
        data=data,
        headers={"apikey": anon_key, "Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        body = json.loads(resp.read())
        tokens[label] = body["access_token"]
        print(f"✅ {label}: logged in")
    except Exception as e:
        err = e.read().decode()[:150] if hasattr(e, 'read') else str(e)
        print(f"❌ {label}: {err}")

# Step 4: Data isolation matrix
tables = [
    ("leads", "id"),
    ("quotes", "id"),
    ("contracts", "id"),
    ("payments", "id"),
    ("activities", "id"),
    ("activity_logs", "id"),
    ("products", "id"),
    ("notifications", "id"),
    ("profiles", "id"),
]

print("\n" + "=" * 80)
print("DATA ISOLATION MATRIX (row counts per role via RLS)")
print("=" * 80)
header = f"{'Role':<20s}"
for t, _ in tables:
    header += f" {t[:11]:>11s}"
print(header)
print("-" * len(header))

results = {}
for label, token in tokens.items():
    results[label] = {}
    row = f"{label:<20s}"
    for table, col in tables:
        req = urllib.request.Request(
            f"{url_base}/rest/v1/{table}?select={col}&limit=5000",
            headers={"apikey": anon_key, "Authorization": f"Bearer {token}"}
        )
        try:
            resp = urllib.request.urlopen(req, timeout=10)
            rows = json.loads(resp.read())
            count = len(rows)
            results[label][table] = count
            row += f" {str(count):>11s}"
        except Exception as e:
            status = getattr(e, 'code', 'ERR')
            results[label][table] = f"E{status}"
            row += f" {'E'+str(status):>11s}"
    print(row)

# Step 5: Leads breakdown by assigned_to
print("\n" + "=" * 80)
print("LEADS DATA ISOLATION DETAIL")
print("=" * 80)
for label, token in tokens.items():
    if label.startswith("sales"):
        req = urllib.request.Request(
            f"{url_base}/rest/v1/leads?select=id,assigned_to,stage&limit=500",
            headers={"apikey": anon_key, "Authorization": f"Bearer {token}"}
        )
        try:
            resp = urllib.request.urlopen(req, timeout=10)
            leads = json.loads(resp.read())
            stages = {}
            for l in leads:
                s = l.get('stage', '?')
                stages[s] = stages.get(s, 0) + 1
            print(f"\n{label}: sees {len(leads)} leads")
            for s, c in sorted(stages.items()):
                print(f"  {s}: {c}")
            # Check if any lead is not assigned to this user
            own = sum(1 for l in leads if l.get('assigned_to'))
            other = sum(1 for l in leads if not l.get('assigned_to'))
            print(f"  assigned_to set: {own}, NULL: {other}")
        except Exception as e:
            print(f"\n{label}: ERROR - {e}")

# Step 6: Write results - check for RLS failures
print("\n" + "=" * 80)
print("WRITE OPERATION TEST (RLS INSERT/UPDATE)")
print("=" * 80)
write_tests = [
    ("leads", {"full_name": "TEST-DELETE-ME", "phone": "000", "source": "test", "stage": "new_lead"}),
    ("activities", {"lead_id": None, "type": "note", "content": "test"}),
    ("notifications", {"user_id": None, "type": "system", "title": "test", "message": "test"}),
]

for label, token in tokens.items():
    print(f"\n--- {label} ---")
    for table, payload in write_tests:
        if table == "activities" and label in tokens:
            # Get a lead_id first
            req = urllib.request.Request(
                f"{url_base}/rest/v1/leads?select=id&limit=1",
                headers={"apikey": anon_key, "Authorization": f"Bearer {token}"}
            )
            try:
                resp = urllib.request.urlopen(req, timeout=5)
                leads = json.loads(resp.read())
                if leads:
                    payload["lead_id"] = leads[0]["id"]
            except:
                pass

        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{url_base}/rest/v1/{table}",
            data=data,
            headers={
                "apikey": anon_key,
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            }
        )
        try:
            resp = urllib.request.urlopen(req, timeout=10)
            print(f"  INSERT {table}: ✅ {resp.getcode()}")
        except Exception as e:
            status = getattr(e, 'code', '?')
            err = ''
            if hasattr(e, 'read'):
                err = json.loads(e.read().decode()).get('message', '')[:80]
            print(f"  INSERT {table}: ❌ {status} - {err}")
