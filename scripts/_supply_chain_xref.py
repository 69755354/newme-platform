#!/usr/bin/env python3
"""Strict supply-chain exception cross-reference used by check-supply-chain.sh."""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any

REQUIRED_EXCEPTION_FIELDS = {
    "package",
    "vuln_id",
    "severity",
    "risk_reason",
    "mitigation",
    "owner",
    "expires",
    "audit_ref",
}
ADVISORY_ID = re.compile(
    r"^(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})$",
    re.IGNORECASE,
)
ADVISORY_URL_ID = re.compile(
    r"(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})",
    re.IGNORECASE,
)


def load_json(path: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def non_empty_text(entry: dict[str, Any], field: str) -> str:
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"exception field {field!r} must be a non-empty string")
    return value.strip()


def validate_exceptions(document: dict[str, Any]) -> set[tuple[str, str]]:
    entries = document.get("accepted")
    if not isinstance(entries, list):
        raise ValueError("accepted must be an array")

    today = dt.datetime.now(dt.timezone.utc).date()
    accepted: set[tuple[str, str]] = set()
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise ValueError(f"accepted[{index}] must be an object")
        missing = sorted(REQUIRED_EXCEPTION_FIELDS - raw.keys())
        if missing:
            raise ValueError(f"accepted[{index}] is missing: {', '.join(missing)}")

        package = non_empty_text(raw, "package")
        vuln_id = non_empty_text(raw, "vuln_id").upper()
        severity = non_empty_text(raw, "severity").lower()
        non_empty_text(raw, "risk_reason")
        non_empty_text(raw, "mitigation")
        non_empty_text(raw, "owner")
        non_empty_text(raw, "audit_ref")
        expires_text = non_empty_text(raw, "expires")

        if not ADVISORY_ID.fullmatch(vuln_id):
            raise ValueError(f"accepted[{index}] has invalid vuln_id: {vuln_id}")
        if severity not in {"high", "critical"}:
            raise ValueError(f"accepted[{index}] severity must be high or critical")
        try:
            expires = dt.date.fromisoformat(expires_text)
        except ValueError as exc:
            raise ValueError(f"accepted[{index}] expires must be YYYY-MM-DD") from exc
        if expires < today:
            raise ValueError(f"accepted[{index}] expired on {expires_text}")

        key = (package, vuln_id)
        if key in accepted:
            raise ValueError(f"duplicate exception for {package}/{vuln_id}")
        accepted.add(key)
    return accepted


def advisory_identity(package: str, via: dict[str, Any]) -> tuple[str, str]:
    advisory_package = via.get("name") or via.get("dependency") or package
    if not isinstance(advisory_package, str) or not advisory_package:
        advisory_package = package
    url = via.get("url")
    match = ADVISORY_URL_ID.search(url) if isinstance(url, str) else None
    if match:
        return advisory_package, match.group(0).upper()
    source = via.get("source")
    return advisory_package, f"NPM-{source}" if source is not None else "UNKNOWN"


def leaf_advisories(
    package: str,
    vulnerabilities: dict[str, Any],
    trail: frozenset[str] = frozenset(),
) -> set[tuple[str, str]]:
    if package in trail:
        return {(package, "DEPENDENCY-CYCLE")}
    value = vulnerabilities.get(package)
    if not isinstance(value, dict):
        return {(package, "UNKNOWN")}
    via = value.get("via")
    if not isinstance(via, list) or not via:
        return {(package, "UNKNOWN")}

    leaves: set[tuple[str, str]] = set()
    next_trail = trail | {package}
    for item in via:
        if isinstance(item, dict):
            leaves.add(advisory_identity(package, item))
        elif isinstance(item, str):
            leaves.update(leaf_advisories(item, vulnerabilities, next_trail))
        else:
            leaves.add((package, "UNKNOWN"))
    return leaves or {(package, "UNKNOWN")}


def validate_audit(document: dict[str, Any]) -> dict[str, Any]:
    vulnerabilities = document.get("vulnerabilities")
    metadata = document.get("metadata")
    if not isinstance(vulnerabilities, dict):
        raise ValueError("audit JSON is missing vulnerabilities")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("vulnerabilities"), dict):
        raise ValueError("audit JSON is missing vulnerability metadata")
    return vulnerabilities


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: _supply_chain_xref.py <audit.json> <accept.json>", file=sys.stderr)
        return 2

    try:
        audit = load_json(sys.argv[1], "audit output")
        accept = load_json(sys.argv[2], "exception file")
        vulnerabilities = validate_audit(audit)
        accepted = validate_exceptions(accept)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    high_vulnerabilities = {
        name: value
        for name, value in vulnerabilities.items()
        if isinstance(value, dict) and value.get("severity") in {"high", "critical"}
    }

    unaccepted: dict[str, set[tuple[str, str]]] = {}
    for name in high_vulnerabilities:
        leaves = leaf_advisories(name, vulnerabilities)
        missing = {identity for identity in leaves if identity not in accepted}
        if missing:
            unaccepted[name] = missing

    for name in sorted(unaccepted):
        identities = ", ".join(
            f"{package}/{vuln_id}" for package, vuln_id in sorted(unaccepted[name])
        )
        print(f"  {name}: {identities}")
    print(f"COUNT={len(unaccepted)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
