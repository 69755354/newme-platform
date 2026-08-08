#!/usr/bin/env python3
"""Detect recent production 5xx responses on the authentication boundary."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

AUTH_PATHS = {"/api/auth/me", "/api/auth/session"}
DEFAULT_LOG = Path("/var/log/nginx/access.log")
DEFAULT_WINDOW_SECONDS = 600
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
MONTHS = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}
ACCESS_PATTERN = re.compile(
    rb'\[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] '
    rb'"[A-Z]+ ([^ ?"]+)(?:\?[^ "]*)? HTTP/[^"]+" (\d{3})\b'
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, default=Path(os.environ.get("AUTH_ACCESS_LOG", DEFAULT_LOG)))
    parser.add_argument(
        "--window-seconds",
        type=int,
        default=int(os.environ.get("AUTH_LOG_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS)),
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=int(os.environ.get("AUTH_LOG_MAX_BYTES", DEFAULT_MAX_BYTES)),
    )
    parser.add_argument("--now", help="ISO-8601 clock override for deterministic tests")
    return parser.parse_args()


def parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("--now must include a timezone")
    return parsed


def parse_timestamp(match: re.Match[bytes]) -> datetime:
    month = MONTHS.get(match.group(2).decode("ascii"))
    if month is None:
        raise ValueError("unknown access-log month")
    offset_minutes = int(match.group(8)) * 60 + int(match.group(9))
    if match.group(7) == b"-":
        offset_minutes *= -1
    return datetime(
        int(match.group(3)),
        month,
        int(match.group(1)),
        int(match.group(4)),
        int(match.group(5)),
        int(match.group(6)),
        tzinfo=timezone(timedelta(minutes=offset_minutes)),
    )


def emit(payload: dict[str, object], *, error: bool = False) -> None:
    print(json.dumps(payload, sort_keys=True), file=sys.stderr if error else sys.stdout)


def main() -> int:
    args = parse_args()
    if args.window_seconds < 1 or args.max_bytes < 1024:
        emit({"status": "probe_error", "reason": "invalid_limits"}, error=True)
        return 2

    try:
        now = parse_now(args.now)
        window_start = now - timedelta(seconds=args.window_seconds)
        with args.log.open("rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            offset = max(0, size - args.max_bytes)
            handle.seek(offset)
            if offset:
                handle.readline()
            lines = handle.readlines()
    except (OSError, ValueError) as exc:
        emit({"status": "probe_error", "reason": type(exc).__name__}, error=True)
        return 2

    oldest: datetime | None = None
    counts: Counter[str] = Counter()
    for line in lines:
        match = ACCESS_PATTERN.search(line)
        if not match:
            continue
        try:
            timestamp = parse_timestamp(match)
        except ValueError:
            continue
        oldest = timestamp if oldest is None else min(oldest, timestamp)
        if timestamp < window_start or timestamp > now + timedelta(seconds=60):
            continue
        path = match.group(10).decode("utf-8", errors="replace")
        status = int(match.group(11))
        if path in AUTH_PATHS and 500 <= status < 600:
            counts[path] += 1

    if offset and (oldest is None or oldest > window_start):
        emit({"status": "probe_error", "reason": "window_truncated"}, error=True)
        return 2

    total = sum(counts.values())
    emit(
        {
            "status": "auth_5xx" if total else "ok",
            "auth_5xx": total,
            "paths": {path: counts[path] for path in sorted(AUTH_PATHS)},
            "window_seconds": args.window_seconds,
        }
    )
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
