import os, sys, json, urllib.request, urllib.error, urllib.parse

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', file=sys.stderr)
    sys.exit(1)

def api(method, table, params, body):
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    pstr = '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k,v in (params or {}).items())
    if pstr: url += '?' + pstr
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}', 'Content-Type': 'application/json', 'Prefer': 'return=representation'}
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

# Find leads with null name
status, data = api('GET', 'leads', {'select': 'id,customer_name,source,created_at', 'customer_name': 'is.null'}, None)
print('NULL NAME LEADS:', json.dumps(data, indent=2)[:500])

if isinstance(data, list) and len(data) > 0:
    for l in data:
        name = "Unknown Lead (" + str(l.get('source', 'N/A')) + ")"
        status, resp = api('PATCH', 'leads', {'id': 'eq.' + str(l['id'])}, {'customer_name': name})
        print('PATCH', l['id'], 'status=', status, 'resp=', json.dumps(resp)[:300])
        
# Verify
status, data = api('GET', 'leads', {'select': 'id,customer_name', 'customer_name': 'is.null'}, None)
print('\nAFTER FIX - null names:', len(data) if isinstance(data, list) else data)
