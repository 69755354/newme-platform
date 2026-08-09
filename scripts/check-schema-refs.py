#!/usr/bin/env python3
"""Fail when a literal Supabase table reference is absent from the reviewed schema list."""

from pathlib import Path
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
REF_FILE = SCRIPT_DIR / "schema-tables.txt"
FROM_RE = re.compile(r"\.from\(\s*['\"]([^'\"]+)['\"]")


def literal_refs(content: str) -> list[tuple[int, str]]:
    """Return line-numbered literal table references, including multiline calls."""
    return [
        (content.count("\n", 0, match.start()) + 1, match.group(1))
        for match in FROM_RE.finditer(content)
    ]


if "--self-test" in sys.argv:
    fixture = "client.from(\n  'missing_multiline_table'\n)"
    refs = literal_refs(fixture)
    if refs != [(1, "missing_multiline_table")]:
        print(f"FAIL multiline schema reference self-test: {refs!r}")
        raise SystemExit(1)
    print("Schema reference gate self-test passed")
    raise SystemExit(0)

print("=== Schema Reference Check ===")
if not REF_FILE.is_file():
    print(f"FAIL {REF_FILE} not found")
    raise SystemExit(1)

tables = {
    line.strip()
    for line in REF_FILE.read_text(encoding="utf-8").splitlines()
    if line.strip()
}
print(f"Using reference: {REF_FILE} ({len(tables)} tables)")
print("Scanning TypeScript source for literal .from() references...")

checked = 0
violations = 0
try:
    source_files = sorted(
        path
        for path in (PROJECT_DIR / "src").rglob("*")
        if path.is_file() and path.suffix in {".ts", ".tsx"}
    )
    for source_file in source_files:
        relative = source_file.relative_to(PROJECT_DIR).as_posix()
        content = source_file.read_text(encoding="utf-8")
        for lineno, table_name in literal_refs(content):
            checked += 1
            if table_name not in tables:
                print(f"FAIL {relative}:{lineno} - '{table_name}' NOT FOUND in schema")
                violations += 1
except (OSError, UnicodeError) as error:
    print(f"FAIL source scan failed: {error}")
    raise SystemExit(1) from error

print(f"Checked {checked} table references")
if violations:
    print(f"FAIL found {violations} invalid reference(s)")
    raise SystemExit(1)

print("PASS all literal table references exist in the reviewed schema list")
