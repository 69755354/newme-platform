#!/bin/sh
# POSIX compatibility wrapper. The Node guard is the single source of truth.
exec node "$(dirname "$0")/guard-prod-build.mjs"
