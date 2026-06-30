#!/usr/bin/env python3
"""Revert sales passwords - incident recovery"""
import json, urllib.request

with open('/home/ubuntu/newme-platform/.env.local') as f:
    env = dict(line.strip().split('=', 1) for line in f if '=' in line and not line.startswith('#'))

pat = env['SUPABASE_PAT']
url_base = env['NEXT_PUBLIC_SUPABASE_URL']

# Get service_role key
req = urllib.request.Request(
    'https://api.supabase.com/v1/projects/vfopmpxlhwzpxqegayew/api-keys',
    headers={'Authorization': f'Bearer {pat}'}
)
resp = urllib.request.urlopen(req, timeout=10)
keys = json.loads(resp.read())
svc = next(k['api_key'] for k in keys if k['name'] == 'service_role')
print(f"Got service key len={len(svc)}")

# Reset both sales users to Newme@2026
sales = [
    ('4dc710b5-9e5c-4ad6-a601-0a4f5945cba1', 'Faheem'),
    ('3666d8d0-baf4-45cb-8e7f-4243c999b2b1', 'Mohamed'),
]
for uid, name in sales:
    payload = json.dumps({"password": "Newme@2026"}).encode()
    req = urllib.request.Request(
        f"{url_base}/auth/v1/admin/users/{uid}",
        data=payload,
        headers={
            "apikey": svc,
            "Authorization": f"Bearer {svc}",
            "Content-Type": "application/json"
        },
        method="PUT"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        body = json.loads(resp.read())
        print(f"OK {name}: password set to Newme@2026, email={body.get('email','?')}")
    except Exception as e:
        err = e.read().decode()[:200] if hasattr(e, 'read') else str(e)
        print(f"FAIL {name}: {err}")
