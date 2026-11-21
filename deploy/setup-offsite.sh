#!/usr/bin/env bash
# One-time setup of the ENCRYPTED off-site copy for one environment (docs/OPERATIONS.md). Run as root on the VPS:
#   sudo bash setup-offsite.sh <production|staging> <rclone.conf with a [gdrive] remote>
# It installs restic and rclone only if they are missing (nothing else on the server is changed), puts the rclone
# config, a new random encryption password and offsite.env in the environment directory (owned by deploy-fitness, 600),
# then makes the first off-site copy straight away. backup.sh runs it every night after the local backup.
# Re-running is safe: an existing encryption password is kept (a new one would lock you out of older copies).
set -Eeuo pipefail
die() { echo "error: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"
envname="${1:-}"; conf="${2:-}"
case "$envname" in
  production) DIR=/opt/fitness ;;
  staging) DIR=/opt/fitness-staging ;;
  *) die "usage: sudo bash setup-offsite.sh <production|staging> <rclone.conf>" ;;
esac
USER_NAME=deploy-fitness
[[ -f "$DIR/.env" ]] || die "$envname is not set up on this server ($DIR/.env missing)"
[[ -x "$DIR/offsite.sh" ]] || die "$DIR/offsite.sh missing - deploy once first"
[[ -f "$conf" ]] || die "rclone config file not found: $conf"
grep -q '^\[gdrive\]' "$conf" || die "the rclone config must contain a remote named [gdrive]"
ls "$DIR"/backups/nightly/fitness-*.dump >/dev/null 2>&1 || die "no nightly backup yet in $DIR/backups/nightly - wait for the 03:15 run"

need=()
command -v restic >/dev/null || need+=(restic)
command -v rclone >/dev/null || need+=(rclone)
if ((${#need[@]})); then echo "==> installing ${need[*]}"; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"; fi

install -o "$USER_NAME" -g "$USER_NAME" -m 600 "$conf" "$DIR/rclone.conf"   # rclone refreshes its token here, so it must be writable
new_pass=0
if [[ ! -s "$DIR/offsite.pass" ]]; then
  (umask 077; openssl rand -base64 33 | tr -d '\n' > "$DIR/offsite.pass"); new_pass=1
fi
chown "$USER_NAME:$USER_NAME" "$DIR/offsite.pass"; chmod 600 "$DIR/offsite.pass"
cat > "$DIR/offsite.env" <<EOF
RESTIC_REPOSITORY=rclone:gdrive:Fitness-backups/$envname
RESTIC_PASSWORD_FILE=$DIR/offsite.pass
RCLONE_CONFIG=$DIR/rclone.conf
EOF
chown "$USER_NAME:$USER_NAME" "$DIR/offsite.env"; chmod 600 "$DIR/offsite.env"

echo "==> first off-site copy of $envname (can take a minute)"
sudo -Hu "$USER_NAME" env FIT_DIR="$DIR" bash -c "cd '$DIR' && ./offsite.sh" || true
echo "==> status: $(cat "$DIR/status/offsite" 2>/dev/null || echo none)"
sudo -Hu "$USER_NAME" env RESTIC_REPOSITORY="rclone:gdrive:Fitness-backups/$envname" RESTIC_PASSWORD_FILE="$DIR/offsite.pass" RCLONE_CONFIG="$DIR/rclone.conf" \
  restic snapshots --compact 2>/dev/null | tail -5 || true

if ((new_pass)); then
  cat <<EOF

================================================================================
 ENCRYPTION PASSWORD for the $envname off-site backups - SAVE IT IN YOUR PASSWORD
 MANAGER NOW (name it "Fitness off-site backup - $envname"). Without it the copies
 in Google Drive can never be opened. It is not shown again.

   $(cat "$DIR/offsite.pass")

================================================================================
EOF
fi
grep -q '^ok' "$DIR/status/offsite" 2>/dev/null && echo "==> Done: off-site copies are on for $envname." || { echo "==> The first copy FAILED - send the output above to Claude."; exit 1; }
