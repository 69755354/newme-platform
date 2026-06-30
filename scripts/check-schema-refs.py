#!/usr/bin/env python3
"""check-schema-refs.py — Gate: verify all supabase.from("table") references exist in schema."""

import re
import sys
import os
import subprocess

RED = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
NC = "\033[0m"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REF_FILE = os.path.join(SCRIPT_DIR, "schema-tables.txt")
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

print(f"{YELLOW}=== Schema Reference Check ==={NC}")

if not os.path.exists(REF_FILE):
    print(f"{RED}✗ {REF_FILE} not found{NC}")
    sys.exit(1)

with open(REF_FILE) as f:
    tables = {line.strip() for line in f if line.strip()}

print(f"Using reference: {REF_FILE} ({len(tables)} tables)\n")
print("Scanning source code for .from() references...")

# Grep all .from( calls
try:
    result = subprocess.run(
        ["grep", "-rn", r"\.from(", "src/",
         "--include=*.ts", "--include=*.tsx",
         "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=.git"],
        capture_output=True, text=True, cwd=PROJECT_DIR, timeout=10
    )
    lines = result.stdout.split("\n") if result.returncode in (0, 1) else []
except Exception as e:
    print(f"{RED}✗ grep failed: {e}{NC}")
    sys.exit(1)

# Extract table names from .from("X") or .from('X')
FROM_RE = re.compile(r"\.from\(\s*['\"]([^'\"]+)['\"]")

violations = 0
checked = 0

for line in lines:
    if not line.strip():
        continue
    # Parse: file:lineno:content
    parts = line.split(":", 2)
    if len(parts) < 3:
        continue
    filepath, lineno, content = parts[0], parts[1], parts[2]

    m = FROM_RE.search(content)
    if not m:
        continue
    table_name = m.group(1)

    # Skip dynamic/variable refs
    if "${" in table_name or table_name.startswith("`"):
        continue

    checked += 1

    if table_name not in tables:
        print(f"{RED}❌ {filepath}:{lineno} — '{table_name}' NOT FOUND in schema{NC}")
        violations += 1

print(f"\nChecked {checked} table references")

if violations > 0:
    print(f"{RED}✗ Found {violations} invalid reference(s){NC}")
    sys.exit(1)
else:
    print(f"{GREEN}✓ All table references exist in schema{NC}")
