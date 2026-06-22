#!/usr/bin/env python3
"""GLM 5.2 CP test loop: GLM writes → runs → if fail, feed errors back → repeat"""
import subprocess, sys, os, urllib.request, json

API_KEY = os.environ["GLM_CODING_API_KEY"]
API_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
SCRIPT = "/home/ubuntu/newme-platform/scripts/regression-test.py"
MAX_ROUNDS = 5

def call_glm(messages):
    payload = json.dumps({
        "model": "glm-5.2",
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 16384
    }).encode()
    req = urllib.request.Request(API_URL, data=payload)
    req.add_header("Authorization", f"Bearer {API_KEY}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]

def run_tests():
    r = subprocess.run(["python3", SCRIPT], capture_output=True, text=True, timeout=60)
    return r.stdout + r.stderr, r.returncode

system = """You are a test engineer. Write a complete Python regression test script.
Output ONLY the Python code. No markdown fences, no explanations, no commentary.
The script must be self-contained and runnable with: python3 regression-test.py
ALL tests must pass. Fix errors iteratively based on test output."""

messages = [
    {"role": "system", "content": system},
    {"role": "user", "content": f"""Write /home/ubuntu/newme-platform/scripts/regression-test.py

CRM security fixes were deployed. Server runs on http://localhost:3001 (NOT 3000).
Creds in /home/ubuntu/newme-platform/.env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY.

CRITICAL: DO NOT create new leads. Use EXISTING data.
- Fetch users from `profiles` table (columns: id, role, email) via service_role key
- Fetch leads from `leads` table (columns: id, customer_name, assigned_to) via service_role key  
- Pick: 1 lead where assigned_to matches sales user (own_lead), 1 lead assigned to someone else (other_lead)
- Login: POST {{SUPA_URL}}/auth/v1/token?grant_type=password with apikey header
  Use password from env TEST_USER_PASSWORD or default "test1234"

Test cases (all against localhost:3001):

GET /api/activities?lead_id=X:
  sales+own_lead→200, sales+other_lead→403, admin+any→200, boss+any→200

POST /api/quotations/generate {{lead_id, devices:{{knx_ip_router:1}}}}:
  sales+own→200, sales+other→403, admin+any→200, no_lead_id→400

POST /api/cos/download-url {{key, lead_id, expires}}:
  valid key+valid lead_id→200, valid key+no lead_id→400, bad prefix→400, ../traversal→400

POST /api/hermes/knx-design {{lead_id}}:
  sales+own→200, sales+other→403, no_lead_id→400

Print PASS/FAIL per test. Exit 0 only if ALL pass. Output ONLY Python code."""}
]

for round_num in range(1, MAX_ROUNDS + 1):
    print(f"\n{'='*60}", flush=True)
    print(f"ROUND {round_num}: Asking GLM 5.2 CP...", flush=True)
    
    response = call_glm(messages)
    
    # Extract code from response (strip any markdown or commentary)
    code = response
    if "```python" in code:
        code = code.split("```python", 1)[1]
        if "```" in code:
            code = code.split("```", 1)[0]
    elif "```" in code:
        parts = code.split("```", 2)
        if len(parts) >= 2:
            code = parts[1]
    code = code.strip()
    if not code or len(code) < 50:
        print(f"  ⚠️  GLM returned empty/short response ({len(code)} chars). Raw:", flush=True)
        print(response[:500], flush=True)
        # Save raw response for debugging
        with open("/tmp/glm_raw_response.txt", "w") as f:
            f.write(response)
    
    with open(SCRIPT, "w") as f:
        f.write(code.strip() + "\n")
    
    print(f"  Wrote {len(code.split(chr(10)))} lines. Running...", flush=True)
    output, exit_code = run_tests()
    print(output, flush=True)
    
    if exit_code == 0 and "FAIL" not in output:
        print(f"\n✅ ALL TESTS PASSED after {round_num} round(s)!", flush=True)
        sys.exit(0)
    
    # Feed errors back to GLM
    messages.append({"role": "assistant", "content": response})
    messages.append({"role": "user", "content": f"Test output:\n{output}\n\nFix the script so ALL tests pass. Output ONLY the corrected Python code."})

print(f"\n❌ Failed after {MAX_ROUNDS} rounds", flush=True)
sys.exit(1)
