#!/usr/bin/env python3
"""
Issue a signed coding auth token — Ed25519-signed, verifiable at commit and deploy gates.

CONTROL-PLANE GATES:
  1. --tool manual REQUIRES root-owned approval file (single-use)
  2. All tokens are Ed25519-signed with a root-owned private key
  3. Unsigned or forged tokens are rejected by verify-coding-auth.py

Approval file: /var/lib/newme/coding-auth/manual-approval
Private key:   /var/lib/newme/coding-auth/ed25519.key (root:root, 0400)
Token file:    .hermes/state/coding-auth.json
"""
import base64
import json
import os
import secrets
import stat
import sys
import time
import argparse
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.hazmat.primitives import serialization
    from cryptography.exceptions import InvalidSignature
except ImportError:
    print("ERROR: cryptography package required (pip install cryptography)", file=sys.stderr)
    sys.exit(1)

APPROVAL_FILE = "/var/lib/newme/coding-auth/manual-approval"
KEY_FILE = "/var/lib/newme/coding-auth/ed25519.key"
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

    if st.st_uid != 0 or st.st_gid != 0:
        return False, f"approval file owner must be root:root"

    mode = st.st_mode
    if mode & stat.S_IWGRP:
        return False, "approval file is group-writable"
    if mode & stat.S_IWOTH:
        return False, "approval file is world-writable"

    data = parse_approval_file(path)
    if not data:
        return False, "approval file empty or unparseable"

    expires = data.get("expires_at")
    if expires:
        try:
            exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) > exp_dt:
                return False, f"approval expired at {expires}"
        except ValueError:
            return False, f"invalid expires_at format: {expires}"

    approved_task = data.get("task_id")
    if not approved_task:
        return False, "approval file missing task_id"
    if approved_task != task_id:
        return False, f"task_id mismatch: approval={approved_task}, requested={task_id}"

    return True, "ok"


def consume_approval(path: str):
    """Delete the approval file after successful use."""
    try:
        os.remove(path)
    except OSError:
        pass


def load_private_key() -> ed25519.Ed25519PrivateKey:
    """Load Ed25519 private key. Must be readable (typically root-only)."""
    if not os.path.isfile(KEY_FILE):
        print(f"❌ Private key not found: {KEY_FILE}", file=sys.stderr)
        print("   This file must be root-owned and created once during setup.", file=sys.stderr)
        sys.exit(1)
    try:
        with open(KEY_FILE, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    except Exception as e:
        print(f"❌ Cannot load private key: {e}", file=sys.stderr)
        sys.exit(1)


def sign_token(payload: dict) -> str:
    """Sign token payload with Ed25519, return base64 signature."""
    private_key = load_private_key()
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    sig = private_key.sign(canonical.encode())
    return base64.b64encode(sig).decode()


def log_issuance(tool: str, reason: str, task_id: str | None, approved_by: str | None):
    """Append evidence to issuance log."""
    entry = {
        "tool": tool,
        "reason": reason,
        "task_id": task_id,
        "approved_by": approved_by,
        "issued_at": int(time.time()),
    }
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tool", required=True, choices=["opencode", "codex", "manual"])
    parser.add_argument("--reason", required=True, help="Task description")
    parser.add_argument("--ttl", type=int, default=7200, help="Token lifetime in seconds (default 2h)")
    parser.add_argument("--task-id", default="", help="Task ID (required for manual to match approval)")
    parser.add_argument("--agent", default="GLM-CP", help="Agent name (default: GLM-CP)")
    parser.add_argument("--scope", default="*", help="Allowed file scope glob (default: *)")
    args = parser.parse_args()

    # ── Manual gate: require root approval file ──
    approved_by = None
    if args.tool == "manual":
        if not args.task_id:
            print("❌ --tool manual requires --task-id", file=sys.stderr)
            sys.exit(1)
        ok, reason = verify_approval(APPROVAL_FILE, args.task_id)
        if not ok:
            print(f"❌ Manual coding auth DENIED: {reason}", file=sys.stderr)
            print(f"   Approval file: {APPROVAL_FILE}", file=sys.stderr)
            sys.exit(1)
        approval_data = parse_approval_file(APPROVAL_FILE)
        approved_by = approval_data.get("approved_by", "human") if approval_data else "human"
        consume_approval(APPROVAL_FILE)

    # ── Build unsigned payload ──
    issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    expires_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    # Recalculate expires_at properly
    from datetime import timedelta
    exp_dt = datetime.now(timezone.utc) + timedelta(seconds=args.ttl)
    expires_at = exp_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    payload = {
        "version": 1,
        "agent": args.agent,
        "tool": args.tool,
        "task_id": args.task_id or None,
        "scope": args.scope,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "nonce": secrets.token_hex(16),
        "approved_by": approved_by,
    }

    # ── Sign ──
    try:
        payload["signature"] = sign_token(payload)
    except SystemExit:
        raise
    except Exception as e:
        print(f"❌ Signing failed: {e}", file=sys.stderr)
        sys.exit(1)

    # ── Write token ──
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(payload, f, indent=2)

    log_issuance(args.tool, args.reason, args.task_id or None, approved_by)

    ttl_min = args.ttl // 60
    print(f"✅ Coding auth issued: tool={args.tool}, expires in {ttl_min}min")
    if args.tool == "manual":
        print(f"   Task: {args.task_id}, Approved by: {approved_by}")
    print(f"   Reason: {args.reason}")
    print(f"   Signed: Ed25519 ✓")


if __name__ == "__main__":
    main()
