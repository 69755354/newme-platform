#!/usr/bin/env python3
"""Fail-closed validation for the non-secret shape of production configuration."""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.parse
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


def require_api_key(values: dict[str, str], key: str) -> str:
    value = values.get(key, "")
    if not API_KEY_PATTERN.fullmatch(value):
        raise ConfigError(f"release {key} is missing or malformed")
    return value


def validate_sentry_dsn(release: dict[str, str]) -> None:
    dsn = release.get("SENTRY_DSN") or release.get("NEXT_PUBLIC_SENTRY_DSN") or ""
    parsed = urllib.parse.urlsplit(dsn)
    if (
        parsed.scheme != "https"
        or not parsed.username
        or not parsed.hostname
        or not parsed.hostname.endswith(".sentry.io")
        or not re.fullmatch(r"/\d+", parsed.path)
    ):
        raise ConfigError("release Sentry DSN is missing or malformed")


def rest_probe(label: str, url: str, key: str) -> None:
    request = urllib.request.Request(
        f"{url}/rest/v1/profiles?select=id&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
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
        publishable_key = require_api_key(release, "NEXT_PUBLIC_SUPABASE_ANON_KEY")
        service_key = require_api_key(release, "SUPABASE_SERVICE_ROLE_KEY")
        if publishable_key == service_key:
            raise ConfigError("publishable and service Supabase credentials are identical")
        validate_sentry_dsn(release)
        print("CONFIG_VALIDATION=PASS")
        if args.network:
            rest_probe("publishable", EXPECTED_SUPABASE_URL, publishable_key)
            rest_probe("service", EXPECTED_SUPABASE_URL, service_key)
        return 0
    except (ConfigError, OSError, UnicodeError) as exc:
        print(f"production config validation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
