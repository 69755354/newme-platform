#!/usr/bin/env python3
"""
Issue a coding auth token — called by Hermes when delegating to OpenCode/Codex.

CONTROL-PLANE GATE (2026-07-04):
  --tool manual NOW REQUIRES a root-owned approval file.
  Ubuntu cannot self-sign without human-approved root-level authorization.

Approval file: /var/lib/newme/coding-auth/manual-approval
  - Must exist, owner root:root, mode 0xxx (not group/world writable)
  - Must contain task_id matching --task-id
  - Must not be expired (expires_at field)
  - Consumed (deleted) after successful issuance — single-use only
"""
import json
import os
import stat
import sys
import time
import argparse

APPROVAL_FILE = "/var/lib/newme/coding-auth/manual-approval"
TOKEN_FILE = ".hermes/state/coding-auth.json"
LOG_FILE = ".hermes/state/coding-auth-issued.log"


def parse_approval_file(path: str) -> dict | None:
    """Parse key=value lines from approval file into a dict."""
    if not os.path.isfile(path):
        return None
    result = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    result[k.strip()] = v.strip()
        return result
    except Exception:
        return None


def verify_approval(path: str, task_id: str) -> tuple[bool, str]:
    """Verify root-owned approval file. Returns (ok, reason)."""
    if not os.path.isfile(path):
        return False, f"approval file not found: {path}"

    st = os.stat(path)

    # Check owner
    if st.st_uid != 0 or st.st_gid != 0:
        return False, f"approval file owner must be root:root (got uid={st.st_uid} gid={st.st_gid})"

    # Check group/world write
    mode = st.st_mode
    if mode & stat.S_IWGRP:
        return False, "approval file is group-writable"
    if mode & stat.S_IWOTH:
        return False, "approval file is world-writable"

    # Parse content
    data = parse_approval_file(path)
    if not data:
        return False, "approval file empty or unparseable"

    # Check expiration
    expires = data.get("expires_at")
    if expires:
        try:
            exp_dt = time.mktime(time.strptime(expires, "%Y-%m-%dT%H:%M:%SZ"))
            if time.time() > exp_dt:
                return False, f"approval expired at {expires}"
        except ValueError:
            return False, f"invalid expires_at format: {expires}"

    # Check task_id match
    approved_task = data.get("task_id")
    if not approved_task:
        return False, "approval file missing task_id"
    if approved_task != task_id:
        return False, f"task_id mismatch: approval={approved_task}, requested={task_id}"

    return True, "ok"


def consume_approval(path: str):
    """Delete the approval file after successful use (single-use)."""
    try:
        os.remove(path)
    except OSError:
        pass  # best-effort


def log_issuance(tool: str, reason: str, task_id: str | None, approved_by: str | None):
    """Append an evidence line to the issuance log."""
    entry = {
        "tool": tool,
        "reason": reason,
        "task_id": task_id,
        "approved_by": approved_by,
        "issued_at": int(time.time()),
        "approval_file": APPROVAL_FILE if os.path.isfile(APPROVAL_FILE) else None,
    }
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tool", required=True, choices=["opencode", "codex", "manual"]
    )
    parser.add_argument("--reason", required=True, help="Task description")
    parser.add_argument(
        "--ttl",
        type=int,
        default=7200,
        help="Token lifetime in seconds (default 2h)",
    )
    parser.add_argument(
        "--task-id",
        default="",
        help="Task identifier (required for --tool manual to match approval file)",
    )
    args = parser.parse_args()

    # ── CONTROL-PLANE GATE: manual requires root approval ──
    if args.tool == "manual":
        if not args.task_id:
            print(
                "❌ --tool manual requires --task-id (must match approval file task_id)",
                file=sys.stderr,
            )
            sys.exit(1)

        ok, reason = verify_approval(APPROVAL_FILE, args.task_id)
        if not ok:
            print(f"❌ Manual coding auth DENIED: {reason}", file=sys.stderr)
            print(f"   Approval file: {APPROVAL_FILE}", file=sys.stderr)
            print(
                "   This file must be root-owned, single-use, and created by a human.",
                file=sys.stderr,
            )
            sys.exit(1)

        # Parse for logging
        approval_data = parse_approval_file(APPROVAL_FILE)
        approved_by = (
            approval_data.get("approved_by", "unknown") if approval_data else "unknown"
        )

        consume_approval(APPROVAL_FILE)
    else:
        task_id = args.task_id or None
        approved_by = "hermes-auto"

    # ── Issue token ──
    token = {
        "session_id": f"hermes-{int(time.time())}",
        "tool": args.tool,
        "reason": args.reason,
        "task_id": args.task_id or None,
        "issued_at": int(time.time()),
        "expires_at": int(time.time()) + args.ttl,
        "issued_by": "hermes-agent",
    }

    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(token, f, indent=2)

    log_issuance(args.tool, args.reason, args.task_id or None, approved_by)

    print(f"✅ Coding auth issued: tool={args.tool}, expires in {args.ttl}s")
    if args.tool == "manual":
        print(f"   Task: {args.task_id}, Approved by: {approved_by}")
    print(f"   Reason: {args.reason}")


if __name__ == "__main__":
    main()
