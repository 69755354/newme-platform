#!/usr/bin/env python3
"""
Verify coding auth token signature — called by pre-commit hook and deploy.sh.

Checks:
  1. Token file exists and is valid JSON
  2. Required fields present (version, agent, tool, issued_at, expires_at, nonce, signature)
  3. Token not expired
  4. Ed25519 signature matches (using embedded public key)

Usage:
  python3 scripts/verify-coding-auth.py --mode pre-commit   (for pre-commit hook)
  python3 scripts/verify-coding-auth.py --mode deploy        (for deploy.sh gate)

Exit 0 = valid, exit non-zero = invalid/expired/forged.
"""
import base64
import json
import os
import sys
import argparse
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.exceptions import InvalidSignature
except ImportError:
    print("ERROR: cryptography package required", file=sys.stderr)
    sys.exit(1)

# ─── Embedded Ed25519 public key (base64, 32 bytes raw) ───
# Generated during CONTROL-PLANE HOTFIX 2 setup.
# DO NOT change this — it must match the private key at
# /var/lib/newme/coding-auth/ed25519.key
PUBLIC_KEY_B64 = "HBvtbQV30cTYOYpKY/d/NcW3yb8sNMt5EC6VccwsySc="

TOKEN_FILE = ".hermes/state/coding-auth.json"

REQUIRED_FIELDS = [
    "version", "agent", "tool", "issued_at", "expires_at", "nonce", "signature"
]


def load_public_key() -> ed25519.Ed25519PublicKey:
    """Load the embedded Ed25519 public key."""
    try:
        raw = base64.b64decode(PUBLIC_KEY_B64)
        return ed25519.Ed25519PublicKey.from_public_bytes(raw)
    except Exception as e:
        print(f"FATAL: Cannot load public key: {e}", file=sys.stderr)
        sys.exit(1)


def verify_token(token_path: str) -> tuple[bool, str]:
    """Verify token at given path. Returns (valid, reason)."""
    if not os.path.isfile(token_path):
        return False, "token file not found"

    # Parse JSON
    try:
        with open(token_path) as f:
            token = json.load(f)
    except json.JSONDecodeError as e:
        return False, f"invalid JSON: {e}"

    # Required fields
    for field in REQUIRED_FIELDS:
        if field not in token:
            return False, f"missing required field: {field}"

    # Expiry check
    try:
        expires_str = token["expires_at"]
        if expires_str.endswith("Z"):
            expires_str = expires_str[:-1] + "+00:00"
        expires_dt = datetime.fromisoformat(expires_str)
        if datetime.now(timezone.utc) > expires_dt:
            return False, f"token expired at {token['expires_at']}"
    except (ValueError, KeyError) as e:
        return False, f"invalid expires_at: {e}"

    # Verify Ed25519 signature
    signature_b64 = token.pop("signature")
    try:
        sig_bytes = base64.b64decode(signature_b64)
    except Exception:
        return False, "signature is not valid base64"

    canonical = json.dumps(token, sort_keys=True, separators=(",", ":"))

    try:
        public_key = load_public_key()
        public_key.verify(sig_bytes, canonical.encode())
    except InvalidSignature:
        return False, "signature mismatch — token forged or tampered"
    except Exception as e:
        return False, f"signature verification error: {e}"

    return True, "valid"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["pre-commit", "deploy"])
    args = parser.parse_args()

    ok, reason = verify_token(TOKEN_FILE)

    label = "DEPLOY GATE" if args.mode == "deploy" else "CODING AUTH"

    if ok:
        print(f"✅ {label}: PASS — {reason}")
        sys.exit(0)
    else:
        print(f"❌ {label}: FAIL — {reason}", file=sys.stderr)
        if args.mode == "deploy":
            print("   Deploy blocked. A valid signed coding auth token is required.", file=sys.stderr)
            print(f"   Token path: {TOKEN_FILE}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
