#!/usr/bin/env python3
"""Fail-closed validation for the non-secret shape of production configuration."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

EXPECTED_SITE_URL = "https://app.newme.ae"
EXPECTED_SUPABASE_URL = "https://vfopmpxlhwzpxqegayew.supabase.co"
TOKEN_PATTERN = re.compile(r"[0-9a-f]{64}")
API_KEY_PATTERN = re.compile(r"[A-Za-z0-9._-]{20,2048}")
KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class ConfigError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-env", type=Path, required=True)
    parser.add_argument("--runtime-env", type=Path, required=True)
    parser.add_argument("--require-runtime-service-key", action="store_true")
    parser.add_argument("--require-no-release-service-key", action="store_true")
    parser.add_argument("--network", action="store_true")
    return parser.parse_args()


def parse_env(path: Path) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        raise ConfigError(f"{path.name} must be a regular file")
    values: dict[str, str] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ConfigError(f"{path.name} has invalid syntax at line {number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not KEY_PATTERN.fullmatch(key):
            raise ConfigError(f"{path.name} has an invalid key at line {number}")
        if key in values:
            raise ConfigError(f"{path.name} contains duplicate key {key}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def require_exact(values: dict[str, str], key: str, expected: str, source: str) -> None:
    if values.get(key) != expected:
        raise ConfigError(f"{source} {key} is missing or unexpected")


def require_api_key(values: dict[str, str], key: str, source: str) -> str:
    value = values.get(key, "")
    if not API_KEY_PATTERN.fullmatch(value):
        raise ConfigError(f"{source} {key} is missing or malformed")
    return value


def classify_supabase_key(value: str) -> tuple[str, str]:
    if value.startswith("sb_publishable_"):
        return ("publishable", "opaque")
    if value.startswith("sb_secret_"):
        return ("service", "opaque")
    parts = value.split(".")
    if len(parts) != 3:
        raise ConfigError("Supabase credential type is unrecognized")
    try:
        padding = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ConfigError("Supabase credential type is unrecognized") from exc
    if not isinstance(payload, dict):
        raise ConfigError("Supabase credential type is unrecognized")
    role = payload.get("role")
    if role == "anon":
        return ("publishable", "legacy_jwt")
    if role == "service_role":
        return ("service", "legacy_jwt")
    raise ConfigError("Supabase credential role is not allowed")


def validate_sentry_dsn(release: dict[str, str]) -> None:
    dsn = release.get("SENTRY_DSN") or release.get("NEXT_PUBLIC_SENTRY_DSN") or ""
    if not re.fullmatch(
        r"https://[0-9a-f]{32}(?::[0-9a-f]{32})?@"
        r"[a-z0-9-]+\.ingest(?:\.[a-z0-9-]+)*\.sentry\.io/[0-9]+/*",
        dsn,
    ):
        raise ConfigError("release Sentry DSN is missing or malformed")


def rest_probe(label: str, url: str, key: str, key_format: str) -> None:
    headers = {"apikey": key}
    if key_format == "legacy_jwt":
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(
        f"{url}/rest/v1/profiles?select=id&limit=1",
        headers=headers,
        method="GET",
    )
    status = 0
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = response.status
            response.read(1)
    except urllib.error.HTTPError as exc:
        status = exc.code
    except (OSError, TimeoutError) as exc:
        raise ConfigError(f"{label} Supabase probe transport failed") from exc
    if status != 200:
        raise ConfigError(f"{label} Supabase probe returned HTTP {status or '000'}")
    print(f"NETWORK_{label.upper()}=200")


def main() -> int:
    args = parse_args()
    try:
        release = parse_env(args.release_env)
        runtime = parse_env(args.runtime_env)
        require_exact(runtime, "NEXT_PUBLIC_SITE_URL", EXPECTED_SITE_URL, "runtime")
        if not TOKEN_PATTERN.fullmatch(runtime.get("NEWME_READINESS_TOKEN", "")):
            raise ConfigError("runtime NEWME_READINESS_TOKEN is missing or malformed")
        require_exact(release, "NEXT_PUBLIC_SUPABASE_URL", EXPECTED_SUPABASE_URL, "release")
        publishable_key = require_api_key(
            release, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "release"
        )
        release_has_service_key = "SUPABASE_SERVICE_ROLE_KEY" in release
        runtime_has_service_key = "SUPABASE_SERVICE_ROLE_KEY" in runtime
        if args.require_no_release_service_key and release_has_service_key:
            raise ConfigError(
                "release SUPABASE_SERVICE_ROLE_KEY must be absent; use the fixed runtime store"
            )
        if args.require_runtime_service_key or args.require_no_release_service_key:
            service_key = require_api_key(
                runtime, "SUPABASE_SERVICE_ROLE_KEY", "runtime"
            )
        elif runtime_has_service_key:
            service_key = require_api_key(
                runtime, "SUPABASE_SERVICE_ROLE_KEY", "runtime"
            )
        else:
            service_key = require_api_key(
                release, "SUPABASE_SERVICE_ROLE_KEY", "release"
            )
        if publishable_key == service_key:
            raise ConfigError("publishable and service Supabase credentials are identical")
        publishable_role, publishable_format = classify_supabase_key(publishable_key)
        service_role, service_format = classify_supabase_key(service_key)
        if publishable_role != "publishable":
            raise ConfigError("release NEXT_PUBLIC_SUPABASE_ANON_KEY is not publishable")
        if service_role != "service":
            raise ConfigError("release SUPABASE_SERVICE_ROLE_KEY is not server-only")
        validate_sentry_dsn(release)
        print("CONFIG_VALIDATION=PASS")
        if args.network:
            rest_probe("publishable", EXPECTED_SUPABASE_URL, publishable_key, publishable_format)
            rest_probe("service", EXPECTED_SUPABASE_URL, service_key, service_format)
        return 0
    except (ConfigError, OSError, UnicodeError) as exc:
        print(f"production config validation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
