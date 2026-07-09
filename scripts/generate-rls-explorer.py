#!/usr/bin/env python3
"""
generate-rls-explorer.py — Scan supabase/migrations/*.sql for CREATE POLICY statements.

Outputs:
  1. /tmp/p1-catalog-output/rls-explorer.md   (Markdown table)
  2. /tmp/p1-catalog-output/rls-explorer.json  (JSON)

Extracts from each CREATE POLICY:
  - Table name
  - Policy name
  - Role (TO authenticated, public, anon, ...)
  - Operation (FOR SELECT / INSERT / UPDATE / DELETE / ALL)
  - USING clause
  - WITH CHECK clause
  - Source file + line number
"""

import re
import json
import glob
import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = PROJECT_DIR / "supabase" / "migrations"
OUTPUT_DIR = Path("/tmp/p1-catalog-output")

# Regex to match CREATE POLICY statements spanning multiple lines.
# Handles both quoted and unquoted policy names.
# The statement ends at the next semicolon.
POLICY_RE = re.compile(
    r'CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?'
    r'(?:"([^"]+)"|(\w+))\s+'           # policy name (quoted or unquoted)
    r'ON\s+(?:public\.)?(\w+)\s+'       # table name
    r'FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\s+'
    r'TO\s+(\S+)',                       # role (authenticated, public, anon, etc.)
    re.IGNORECASE
)


def extract_using_and_with_check(content: str, start_pos: int) -> tuple[str, str]:
    """Extract USING and WITH CHECK expressions from after the policy header."""
    tail = content[start_pos:]

    # Find the closing semicolon — but there could be nested semicolons in sub-selects or
    # function bodies. Use a simple bracket-aware scanner.
    depth = 0
    end = len(tail)
    for i, ch in enumerate(tail):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        elif ch == ';' and depth == 0:
            end = i
            break

    clause_text = tail[:end].strip()

    using = ""
    with_check = ""

    # Match USING (...) — find the outermost parenthesized expression
    for clause_name, target in [("USING", "using"), ("WITH CHECK", "with_check")]:
        clause_re = re.compile(
            r'\b' + clause_name + r'\s*\(', re.IGNORECASE
        )
        m = clause_re.search(clause_text)
        if m:
            start = m.end() - 1  # position of the opening '('
            depth = 0
            expr_start = start
            paren_end = start
            for i in range(start, len(clause_text)):
                ch = clause_text[i]
                if ch == '(':
                    if depth == 0:
                        expr_start = i + 1
                    depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0:
                        paren_end = i
                        break
            expr = clause_text[expr_start:paren_end].strip()
            # Collapse whitespace
            expr = re.sub(r'\s+', ' ', expr)
            if target == "using":
                using = expr
            else:
                with_check = expr

    return using, with_check


def parse_policies(filepath: Path) -> list[dict]:
    """Parse a single SQL file for all CREATE POLICY statements."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except Exception:
        return []

    results = []
    for m in POLICY_RE.finditer(content):
        policy_name = m.group(1) or m.group(2)
        table_name = m.group(3)
        operation = m.group(4).upper()
        role = m.group(5).rstrip(';')  # strip trailing semicolon if present

        using, with_check = extract_using_and_with_check(content, m.end())

        results.append({
            "table": table_name,
            "policy_name": policy_name,
            "role": role,
            "operation": operation,
            "using": using,
            "with_check": with_check,
            "file": str(filepath.relative_to(PROJECT_DIR)),
        })

    return results


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    sql_files = sorted(glob.glob(str(MIGRATIONS_DIR / "*.sql")))

    all_policies = []
    for sf in sql_files:
        path = Path(sf)
        policies = parse_policies(path)
        all_policies.extend(policies)

    # Sort by table, then operation, then policy name
    all_policies.sort(key=lambda p: (p["table"], p["operation"], p["policy_name"]))

    # ── JSON output ──
    json_path = OUTPUT_DIR / "rls-explorer.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(all_policies, f, indent=2, ensure_ascii=False)
    print(f"[rls-explorer] JSON written ({len(all_policies)} policies) → {json_path}")

    # ── Markdown output ──
    md_path = OUTPUT_DIR / "rls-explorer.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# RLS Policy Explorer\n\n")
        f.write(f"**Total policies:** {len(all_policies)}\n\n")
        f.write("| Table | Policy Name | Role | Operation | USING | WITH CHECK | Source |\n")
        f.write("|-------|-------------|------|-----------|-------|------------|--------|\n")
        for p in all_policies:
            using_display = f"`{p['using'][:60]}{'...' if len(p['using']) > 60 else ''}`" if p['using'] else "—"
            wc_display = f"`{p['with_check'][:60]}{'...' if len(p['with_check']) > 60 else ''}`" if p['with_check'] else "—"
            f.write(
                f"| {p['table']} | {p['policy_name']} | {p['role']} | "
                f"{p['operation']} | {using_display} | {wc_display} | "
                f"`{p['file']}` |\n"
            )
    print(f"[rls-explorer] Markdown written → {md_path}")


if __name__ == "__main__":
    main()
