#!/usr/bin/env bash
# Shared helpers for the NewMe database backup and restore drill (S7 item 7).
# Sourced, not executed. Nothing here prints a credential.

backup_log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
backup_die() { backup_log "ERROR: $*"; exit "${2:-1}"; }

# require_mode <path> <max-octal-mode-allowed-bits> <label>: file must be owned by
# the current user and not accessible to group/other.
require_private() {
  local path="$1" label="$2" mode
  [ -e "$path" ] || backup_die "$label is missing: $path" 2
  [ ! -L "$path" ] || backup_die "$label must not be a symlink: $path" 2
  mode="$(stat -c '%a' "$path")"
  case "$mode" in
    400|600|700) ;;
    *) backup_die "$label must be mode 400/600 (is $mode): $path" 2 ;;
  esac
  [ "$(stat -c '%u' "$path")" = "$(id -u)" ] || backup_die "$label must be owned by the running user: $path" 2
}

# write_pg_service <url-file> <service-file>: turn a postgres:// URL into a libpq
# service file (mode 600) so the password never appears in a process argument
# list. Prints the host and project hint (no password) on stdout.
write_pg_service() {
  local url_file="$1" service_file="$2"
  python3 -I - "$url_file" "$service_file" <<'PY'
import os, sys
from urllib.parse import urlsplit, unquote, parse_qs
raw = open(sys.argv[1], encoding="utf-8").read().strip()
u = urlsplit(raw)
if u.scheme not in ("postgres", "postgresql") or not u.hostname or not u.username or not u.password:
    sys.exit("database URL file is malformed")
q = parse_qs(u.query)
lines = ["[newme]", f"host={u.hostname}", f"port={u.port or 5432}",
         f"dbname={unquote(u.path.lstrip('/')) or 'postgres'}", f"user={unquote(u.username)}",
         f"password={unquote(u.password)}", f"sslmode={(q.get('sslmode') or ['require'])[0]}"]
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines) + "\n")
print(u.hostname + " " + unquote(u.username))
PY
}

# table_counts <plain-dump>: "schema.table<TAB>rows" for every table in the dump,
# computed from the dump's own COPY blocks, so it is exactly consistent with it.
table_counts() {
  pg_restore --data-only -f - "$1" 2>/dev/null | awk '
    /^COPY / { name=$2; n=0; incopy=1; next }
    incopy && /^\\\.$/ { printf "%s\t%d\n", name, n; incopy=0; next }
    incopy { n++ }
  ' | LC_ALL=C sort
}

# encrypt_file <in> <out> <key-file>: AES-256-CBC with PBKDF2, key read from file.
encrypt_file() { openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$3" -in "$1" -out "$2"; }
decrypt_file() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$3" -in "$1" -out "$2"; }

send_alert() {
  # send_alert <failure|recovery> <summary>; best effort, never fails the caller.
  local event="$1" summary="$2"
  if [ -n "${BACKUP_ALERT_SCRIPT:-}" ] && [ -x "$BACKUP_ALERT_SCRIPT" ]; then
    bash "$BACKUP_ALERT_SCRIPT" "${BACKUP_ALERT_KEY:-db-backup}" "$event" "$summary" >/dev/null 2>&1 || backup_log "alert delivery failed"
  fi
}
