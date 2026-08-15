#!/usr/bin/env python3
"""Fail closed: historical one-off production data repair is retired."""

import sys


print(
    "retired utility: use a reviewed versioned repair through the protected control plane",
    file=sys.stderr,
)
raise SystemExit(64)
