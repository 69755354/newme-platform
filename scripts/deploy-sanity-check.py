#!/usr/bin/env python3
"""
Deploy sanity check — verify Next.js build integrity before declaring deploy done.
Run: python3 deploy-sanity-check.py [--strict]
Exit 0 = all good, exit 1 = issues found.
"""
import os, sys, glob

NEXT_DIR = os.path.expanduser("~/newme-platform/.next/server/app")

ROUTES = [
    "page_client-reference-manifest.js",
    "(dashboard)/dashboard/page_client-reference-manifest.js",
    "(dashboard)/leads/page_client-reference-manifest.js",
    "(dashboard)/leads/[id]/page_client-reference-manifest.js",
    "login/page_client-reference-manifest.js",
    "_not-found/page_client-reference-manifest.js",
    "api/health/route_client-reference-manifest.js",
]

def check_manifest(route):
    path = os.path.join(NEXT_DIR, route)
    if os.path.exists(path):
        return True, None
    return False, f"MISSING: {route}"

def check_no_dev_artifacts():
    dev_dir = os.path.expanduser("~/newme-platform/.next/dev")
    if os.path.exists(dev_dir) and os.listdir(dev_dir):
        return False, "STALE .next/dev/ directory exists (dev/prod mix risk)"
    return True, None

def main():
    strict = "--strict" in sys.argv
    issues = []

    # 1. Check manifests
    for route in ROUTES:
        ok, err = check_manifest(route)
        if not ok:
            issues.append(err)

    # 2. Check no dev artifacts
    ok, err = check_no_dev_artifacts()
    if not ok:
        issues.append(err)

    # 3. Check BUILD_ID exists
    build_id = os.path.expanduser("~/newme-platform/.next/BUILD_ID")
    if not os.path.exists(build_id):
        issues.append("MISSING: BUILD_ID")

    if issues:
        print("❌ DEPLOY SANITY FAILED:")
        for i in issues:
            print(f"  • {i}")
        return 1

    print("✅ Deploy sanity check passed")
    return 0

if __name__ == "__main__":
    sys.exit(main())
