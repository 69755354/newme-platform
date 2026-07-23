#!/usr/bin/env python3
"""supply-chain cross-reference helper — used by check-supply-chain.sh"""
import json, sys, subprocess

def main():
    audit_file = sys.argv[1]
    accept_file = sys.argv[2]

    with open(audit_file) as f:
        audit = json.load(f)
    with open(accept_file) as f:
        accept = json.load(f)

    accepted_names = {a['package'] for a in accept.get('accepted', [])}
    vulns = audit.get('vulnerabilities', {})
    high_vulns = {k: v for k, v in vulns.items() if v.get('severity') in ('high', 'critical')}

    unaccepted = set()
    for name, v in high_vulns.items():
        if name in accepted_names:
            continue
        via_deps = [x for x in v.get('via', []) if isinstance(x, str)]
        if via_deps and all(d in accepted_names for d in via_deps):
            continue
        unaccepted.add(name)

    for u in sorted(unaccepted):
        print(f'  {u}')
    print(f'COUNT={len(unaccepted)}')

if __name__ == '__main__':
    main()
