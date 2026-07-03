#!/usr/bin/env python3
"""Issue a coding auth token — called by Hermes when delegating to OpenCode/Codex."""
import json, time, sys, argparse

parser = argparse.ArgumentParser()
parser.add_argument('--tool', required=True, choices=['opencode', 'codex', 'manual'])
parser.add_argument('--reason', required=True, help='Task description')
parser.add_argument('--ttl', type=int, default=7200, help='Token lifetime in seconds (default 2h)')
args = parser.parse_args()

token = {
    'session_id': f'hermes-{int(time.time())}',
    'tool': args.tool,
    'reason': args.reason,
    'issued_at': int(time.time()),
    'expires_at': int(time.time()) + args.ttl,
    'issued_by': 'hermes-agent'
}

with open('.hermes/state/coding-auth.json', 'w') as f:
    json.dump(token, f, indent=2)

print(f"✅ Coding auth issued: tool={args.tool}, expires in {args.ttl}s")
print(f"   Reason: {args.reason}")
