import os
import json
import base64
import time
import sys
import requests
from dotenv import load_dotenv

load_dotenv(".env.local")

SUPA_URL = os.getenv("SUPABASE_URL") or os.getenv("SUPA_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SERVICE_ROLE_KEY")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")

if not SUPA_URL or not SERVICE_KEY:
    print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")
    sys.exit(1)

PROJECT_REF = SUPA_URL.split("//")[1].split(".")[0]
COOKIE_NAME = f"sb-{PROJECT_REF}-auth-token"
BASE = "http://localhost:3001"

results = []
all_pass = True

def record(name, ok, detail=""):
    global all_pass
    status = "PASS" if ok else "FAIL"
    if not ok:
        all_pass = False
    print(f"[{status}] {name} {detail}")
    results.append((name, ok))

admin_headers = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

email_a = f"sales_a_{int(time.time())}@test.local"
email_admin = f"admin_{int(time.time())}@test.local"

# Step 1: Create users
def create_user(email):
    r = requests.post(
        f"{SUPA_URL}/auth/v1/admin/users",
        headers=admin_headers,
        json={"email": email, "password": "Test1234!", "email_confirm": True},
    )
    r.raise_for_status()
    return r.json()["id"]

sales_a_id = create_user(email_a)
admin_id = create_user(email_admin)
print(f"Created sales_a: {sales_a_id}, admin: {admin_id}")

# Step 2: Login both
def login(email):
    r = requests.post(
        f"{SUPA_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": ANON_KEY or SERVICE_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": "Test1234!"},
    )
    r.raise_for_status()
    return r.json()

sales_login = login(email_a)
admin_login = login(email_admin)

# Step 3: Build cookies
def make_cookie(login_resp):
    expires_at = int(time.time()) + login_resp.get("expires_in", 3600)
    val = json.dumps({"access_token": login_resp["access_token"], "refresh_token": login_resp["refresh_token"], "expires_at": expires_at})
    return base64.urlsafe_b64encode(val.encode()).decode()

sales_cookie_val = make_cookie(sales_login)
admin_cookie_val = make_cookie(admin_login)

def session_with(cookie_val):
    s = requests.Session()
    s.cookies.set(COOKIE_NAME, cookie_val)
    return s

sales_session = session_with(sales_cookie_val)
admin_session = session_with(admin_cookie_val)

# Step 4: Create leads
def create_lead(assigned_to):
    payload = {
        "customer_name": f"Customer_{int(time.time()*1000)}",
        "source": "website",
        "quality": "valid",
        "lead_status": "new",
        "stage": "new",
        "next_action": "call",
        "next_followup_date": "2025-12-31",
    }
    if assigned_to:
        payload["assigned_to"] = assigned_to
    r = requests.post(
        f"{SUPA_URL}/rest/v1/leads?select=id",
        headers={**admin_headers, "Prefer": "return=representation"},
        json=payload,
    )
    r.raise_for_status()
    return r.json()[0]["id"]

own_lead = create_lead(sales_a_id)
other_lead = create_lead(None)
print(f"Created leads: own={own_lead}, other={other_lead}")

# Step 5: Run tests
def run(session, method, path, expected, body=None, name=""):
    url = f"{BASE}{path}"
    try:
        if method == "GET":
            r = session.get(url, timeout=30)
        else:
            r = session.post(url, json=body, timeout=30)
        ok = r.status_code == expected
        record(name, ok, f"-> {r.status_code} (expected {expected}) resp={r.text[:200]}")
        return r
    except Exception as e:
        record(name, False, f"-> exception {e}")

# ACT tests
run(sales_session, "GET", f"/api/activities?lead_id={own_lead}", 200, name="ACT-1")
run(sales_session, "GET", f"/api/activities?lead_id={other_lead}", 403, name="ACT-2")
run(admin_session, "GET", f"/api/activities?lead_id={own_lead}", 200, name="ACT-3")

# QT tests
run(sales_session, "POST", "/api/quotations/generate", 200,
    {"lead_id": own_lead, "devices": {"knx_ip_router": 1}}, name="QT-1")
run(sales_session, "POST", "/api/quotations/generate", 403,
    {"lead_id": other_lead, "devices": {"knx_ip_router": 1}}, name="QT-2")
run(admin_session, "POST", "/api/quotations/generate", 200,
    {"lead_id": other_lead, "devices": {"knx_ip_router": 1}}, name="QT-3")
run(sales_session, "POST", "/api/quotations/generate", 400,
    {"devices": {"knx_ip_router": 1}}, name="QT-4")

# COS tests
run(sales_session, "POST", "/api/cos/download-url", 200,
    {"key": "quotations/t.pdf", "lead_id": own_lead}, name="COS-1")
run(sales_session, "POST", "/api/cos/download-url", 400,
    {"key": "quotations/t.pdf"}, name="COS-2")
run(sales_session, "POST", "/api/cos/download-url", 400,
    {"key": "bad/x.pdf", "lead_id": own_lead}, name="COS-3")
run(sales_session, "POST", "/api/cos/download-url", 400,
    {"key": "../../etc", "lead_id": own_lead}, name="COS-4")

# KNX tests
run(sales_session, "POST", "/api/hermes/knx-design", 200,
    {"lead_id": own_lead}, name="KNX-1")
run(sales_session, "POST", "/api/hermes/knx-design", 403,
    {"lead_id": other_lead}, name="KNX-2")
run(sales_session, "POST", "/api/hermes/knx-design", 400, {}, name="KNX-3")

# Step 6: Cleanup
def cleanup():
    try:
        for lid in [own_lead, other_lead]:
            requests.delete(f"{SUPA_URL}/rest/v1/leads?id=eq.{lid}", headers=admin_headers)
        for uid in [sales_a_id, admin_id]:
            requests.delete(f"{SUPA_URL}/auth/v1/admin/users/{uid}", headers=admin_headers)
        print("Cleanup done")
    except Exception as e:
        print(f"Cleanup error: {e}")

cleanup()

passed = sum(1 for _, ok in results if ok)
print(f"\n{passed}/{len(results)} tests passed")
sys.exit(0 if all_pass else 1)
