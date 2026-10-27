#!/usr/bin/env python3
"""Read-only NewMe service health probe.

Process recovery belongs to systemd and audited service-control operations.
This probe deliberately never sends signals or invokes service-manager mutations.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


HEALTH_URL = os.environ.get("NEWME_HEALTH_URL", "http://127.0.0.1:3001/api/health")
ACCEPTED_STATUSES = {"ok", "healthy"}


def main() -> int:
    try:
        request = urllib.request.Request(HEALTH_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(json.dumps({"healthy": False, "reason": type(error).__name__}), file=sys.stderr)
        return 1

    status = payload.get("status")
    healthy = status in ACCEPTED_STATUSES
    result = {
        "healthy": healthy,
        "status": status,
        "release": payload.get("release") or payload.get("version"),
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
