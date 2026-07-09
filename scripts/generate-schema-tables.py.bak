#!/usr/bin/env python3
"""generate-schema-tables.py — Extract public table names from Supabase migrations.

Writes to scripts/schema-tables.txt for use by check-schema-refs.sh.
Run this after adding new migrations or manually creating tables.
"""

import re
import glob
import os

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS_DIR = os.path.join(PROJECT_DIR, "supabase", "migrations")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "scripts", "schema-tables.txt")

tables = set()

for f in sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql"))):
    with open(f) as fh:
        content = fh.read()
        for m in re.finditer(
            r"CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)",
            content,
            re.IGNORECASE,
        ):
            tables.add(m.group(1))

# Remove false positives
tables.discard("AS")

with open(OUTPUT_FILE, "w") as fh:
    for t in sorted(tables):
        fh.write(t + "\n")

print(f"Extracted {len(tables)} tables from migrations → {OUTPUT_FILE}")
