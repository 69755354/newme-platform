#!/usr/bin/env bash
# Compatibility entrypoint for any legacy cron that still invokes this name.
# The canonical dependency probe owns Supabase reachability and Hermes state;
# it intentionally does not consume a separate Sentry Cron seat.
set -euo pipefail

DEPENDENCY_PROBE="${DEPENDENCY_PROBE:-/opt/hermes-scripts/observability/dependency-probe.sh}"
exec bash "$DEPENDENCY_PROBE"
