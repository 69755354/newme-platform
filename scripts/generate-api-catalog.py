#!/usr/bin/env python3
"""
generate-api-catalog.py — Scan src/app/api/**/route.ts and produce an API catalog.

Outputs:
  1. /tmp/p1-catalog-output/api-catalog.md   (Markdown table)
  2. /tmp/p1-catalog-output/api-catalog.json  (JSON)

Extracts:
  - HTTP method (GET/POST/PATCH/DELETE)
  - URL path (derived from file path)
  - RBAC role annotations from leading comments
"""

import re
import json
import glob
import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
API_DIR = PROJECT_DIR / "src" / "app" / "api"
OUTPUT_DIR = Path("/tmp/p1-catalog-output")


# One spelling of "this is an exported route handler", used both to list a route's
# methods and to find where its header comment stops.
HANDLER_RE = re.compile(r'export\s+(?:async\s+)?function\s+(GET|POST|PATCH|DELETE|PUT|HEAD)\b')


def extract_path(route_file: Path) -> str:
    """Derive the API path from the route file's location relative to src/app/api."""
    rel = route_file.relative_to(API_DIR)
    parts = list(rel.parts)
    # Remove trailing 'route.ts'
    if parts and parts[-1] == "route.ts":
        parts = parts[:-1]
    # Build path, converting [param] to :param style
    segments = []
    for p in parts:
        if p.startswith("[") and p.endswith("]"):
            segments.append(":" + p[1:-1])
        else:
            segments.append(p)
    path = "/api/" + "/".join(segments)
    # Handle root /api/ case
    if path.endswith("/"):
        path = path[:-1]
    if not path.startswith("/api/"):
        path = "/api/" + path.lstrip("/")
    return path


def extract_rbac(content: str) -> str:
    """
    Scan leading comments (// or /** ... */) before the first export for RBAC-related annotations.
    Look for keywords: admin, sales, boss, operator, finance, designer, authenticated, public
    inside comments that describe role/permission.
    """
    # Grab everything before the first exported handler. `async` is optional: a route
    # that returns a static payload needs no await (src/app/api/health/route.ts), and
    # matching only the async form read that file's whole body as its header.
    header = HANDLER_RE.split(content, maxsplit=1)[0]

    # Look for role-related patterns in comments
    roles_found = set()

    # Pattern 1: "role: admin" or "roles: admin, sales"
    for m in re.finditer(r"(?:role|roles|rbac|RBAC)[\s:]+([\w\s,]+)", header, re.IGNORECASE):
        parts = re.split(r"[,\s]+", m.group(1).strip())
        for p in parts:
            p = p.strip().lower()
            if p in ("admin", "sales", "boss", "operator", "finance", "designer",
                       "authenticated", "public", "anon"):
                roles_found.add(p)

    # Pattern 2: "admin/boss only" or "admin-only"
    for m in re.finditer(r"\b(admin|boss|sales|operator|finance|designer)[/\s-]*only\b", header, re.IGNORECASE):
        roles_found.add(m.group(1).lower())
    for m in re.finditer(r"\b(admin|boss|sales|operator|finance|designer)\s*\+\s*(admin|boss|sales|operator|finance|designer)\b", header, re.IGNORECASE):
        roles_found.add(m.group(1).lower())
        roles_found.add(m.group(2).lower())

    # Pattern 3: "admin or boss" style
    for m in re.finditer(r"\b(admin|boss|sales|operator|finance|designer)\s+or\s+(admin|boss|sales|operator|finance|designer)\b", header, re.IGNORECASE):
        roles_found.add(m.group(1).lower())
        roles_found.add(m.group(2).lower())

    # Pattern 4: inline role check comment like "// Admin only" or "// sales_can_..."
    for m in re.finditer(r"(?:only|restricted to|requires?)\s+(admin|boss|sales|operator|finance|designer|authenticated)", header, re.IGNORECASE):
        roles_found.add(m.group(1).lower())

    # Pattern 5: look for role checks in comment lines like "Verify caller is admin or boss"
    for m in re.finditer(r"(?:caller|user|must be|verified? as)\s+(admin|boss|sales|operator|finance|designer)", header, re.IGNORECASE):
        roles_found.add(m.group(1).lower())
    for m in re.finditer(r"\b(admin|boss)\s*/\s*(boss|admin)\b", header, re.IGNORECASE):
        roles_found.add("admin")
        roles_found.add("boss")

    if roles_found:
        return ", ".join(sorted(roles_found))
    return "—"


def extract_methods(content: str) -> list:
    """Extract exported HTTP methods from the route file."""
    methods = []
    for m in HANDLER_RE.finditer(content):
        methods.append(m.group(1))
    return methods


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    route_files = sorted(glob.glob(str(API_DIR / "**" / "route.ts"), recursive=True))

    entries = []
    for rf in route_files:
        path = Path(rf)
        api_path = extract_path(path)
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:
            continue

        methods = extract_methods(content)
        rbac = extract_rbac(content)

        # `.as_posix()`, not `str()`: str() of a relative path yields backslashes on
        # Windows and forward slashes elsewhere, so the same tree produced two
        # different catalogs depending on who regenerated it. docs/api-catalog.md is
        # committed, and the paths in it are the same paths .gitattributes, the release
        # manifest and the migration gates spell with `/` (see C4-7).
        rel_file = path.relative_to(PROJECT_DIR).as_posix()

        for method in methods:
            entries.append({
                "method": method,
                "path": api_path,
                "rbac": rbac,
                "file": rel_file,
            })

        if not methods:
            entries.append({
                "method": "—",
                "path": api_path,
                "rbac": rbac,
                "file": rel_file,
            })

    # Sort by path then method
    entries.sort(key=lambda e: (e["path"], e["method"]))

    # ── JSON output ──
    json_path = OUTPUT_DIR / "api-catalog.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
    print(f"[api-catalog] JSON written ({len(entries)} endpoints) → {json_path}")

    # ── Markdown output ──
    md_path = OUTPUT_DIR / "api-catalog.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# API Catalog\n\n")
        f.write(f"**Total endpoints:** {len(entries)}\n\n")
        f.write("| Method | Path | RBAC (from comments) | Source File |\n")
        f.write("|--------|------|----------------------|-------------|\n")
        for e in entries:
            f.write(f"| {e['method']} | `{e['path']}` | {e['rbac']} | `{e['file']}` |\n")
    print(f"[api-catalog] Markdown written → {md_path}")


if __name__ == "__main__":
    main()
