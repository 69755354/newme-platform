#!/bin/sh
# Create the read-only account the company NAS uses to PULL database backups (S17 B-2).
# Run once as root on the production host AFTER the backup directory exists. No sshd, sudoers or
# firewall change is made: the account is restricted entirely by its authorized_keys entry
# (restrict + from= + command=), by file permissions, and by its login being key-only.
#
#   newme-nas-pull-setup.sh --pubkey-file <nas-public-key.pub> --from <NAS public IP or CIDR[,more]> [--dry-run]
#   newme-nas-pull-setup.sh --print-authorized-keys-line --pubkey-file F --from ADDR   (no root needed)
#
# What it creates (all idempotent):
#   group + system user  newme-nas-pull   (home /var/lib/newme-nas-pull, shell /bin/sh, password "*" = no password login)
#   /var/backups/newme-db-pull            root:newme-nas-pull 0750   (encrypted backup copies, written by the backup job)
#   /var/lib/newme-nas-pull/.ssh/authorized_keys   root-owned 0644, so the account cannot edit its own key
#   /var/lib/newme-nas-pull/state         newme-nas-pull 0700 (only the "last pull ok" stamp)
#   /usr/local/libexec/newme/newme-nas-rsync-ro.sh  the forced command
# Undo: userdel newme-nas-pull; groupdel newme-nas-pull; rm -r /var/lib/newme-nas-pull /var/backups/newme-db-pull
set -eu
umask 022

MODE=apply; PUBKEY=""; FROM=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey-file) PUBKEY="${2:-}"; shift 2 ;;
    --from) FROM="${2-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --print-authorized-keys-line) MODE=print; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ACCOUNT=newme-nas-pull
HOME_DIR=/var/lib/newme-nas-pull
PULL_DIR=/var/backups/newme-db-pull
WRAPPER_DST=/usr/local/libexec/newme/newme-nas-rsync-ro.sh
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "newme-nas-pull-setup: $1" >&2; exit 2; }

if [ -z "$PUBKEY" ] || [ ! -f "$PUBKEY" ]; then die "--pubkey-file is required and must exist"; fi
if [ -z "$FROM" ]; then die "--from is required: the NAS's public IP (or CIDR). A key usable from anywhere is refused"; fi
case "$FROM" in *[!0-9A-Fa-f.:/,]*) die "--from may contain only digits, hex letters, dots, colons, slashes and commas" ;; esac

# The public key file: exactly one line, a bare public key (no options), no private material.
if grep -q 'PRIVATE KEY' "$PUBKEY"; then die "that is a private key; give the .pub file"; fi
if [ "$(grep -c . "$PUBKEY")" -ne 1 ]; then die "the key file must contain exactly one line"; fi
KEYLINE="$(grep . "$PUBKEY" | head -n 1)"
case "$KEYLINE" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *|sk-ssh-ed25519@openssh.com\ *) ;;
  *) die "the key must start with its type (ssh-ed25519, ssh-rsa, ecdsa-...); keys that carry their own options are refused" ;;
esac
case "$KEYLINE" in *\"*) die "the key line contains a quote" ;; esac
if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -l -f "$PUBKEY" >/dev/null 2>&1 || die "ssh-keygen does not accept that public key"
fi

LINE="restrict,from=\"$FROM\",command=\"$WRAPPER_DST\" $KEYLINE"
if [ "$MODE" = print ]; then printf '%s\n' "$LINE"; exit 0; fi

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -d /var/backups/newme-db ] || die "/var/backups/newme-db does not exist yet; install the backup first (S7-INSTALL.md step 8)"
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi; }

getent group "$ACCOUNT" >/dev/null 2>&1 || run groupadd --system "$ACCOUNT"
if ! getent passwd "$ACCOUNT" >/dev/null 2>&1; then
  run useradd --system --gid "$ACCOUNT" --home-dir "$HOME_DIR" --no-create-home --shell /bin/sh --comment "NAS backup pull (read-only)" "$ACCOUNT"
fi
# "*" = no password exists, so password login is impossible; "!" (locked) can make some sshd setups refuse keys too.
run usermod -p '*' "$ACCOUNT"

run install -d -o root -g root -m 0755 "$HOME_DIR" "$HOME_DIR/.ssh"
run install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$HOME_DIR/state"
run install -d -o root -g "$ACCOUNT" -m 0750 "$PULL_DIR"
run install -d -o root -g root -m 0755 /usr/local/libexec/newme
run install -o root -g root -m 0755 "$HERE/newme-nas-rsync-ro.sh" "$WRAPPER_DST"
if [ "$DRY" = 1 ]; then
  echo "would write $HOME_DIR/.ssh/authorized_keys with one line (restrict, from, forced command)"
else
  printf '%s\n' "$LINE" > "$HOME_DIR/.ssh/authorized_keys.new"
  chown root:root "$HOME_DIR/.ssh/authorized_keys.new"; chmod 0644 "$HOME_DIR/.ssh/authorized_keys.new"
  mv "$HOME_DIR/.ssh/authorized_keys.new" "$HOME_DIR/.ssh/authorized_keys"
fi
echo "done. Next: run the backup once (it fills $PULL_DIR), then set NAS_PULL_REQUIRED=1 in /etc/newme/backup.env after the first NAS pull."
