#!/usr/bin/env bash
# Off-site copy of the latest nightly backup (database dump + evidence images), ENCRYPTED with restic, sent through
# rclone to the owner-chosen target. Runs after backup.sh when <FIT_DIR>/offsite.env exists (docs/OPERATIONS.md).
#   offsite.env (600):  RESTIC_REPOSITORY=rclone:gdrive:Fitness-backups/<env>
#                       RESTIC_PASSWORD_FILE=<FIT_DIR>/offsite.pass   (the encryption key: keep a copy in the password manager!)
#                       RCLONE_CONFIG=<FIT_DIR>/rclone.conf
. "$(dirname "$0")/lib.sh"
set -a; . ./offsite.env; set +a
command -v restic >/dev/null && command -v rclone >/dev/null || { echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ) restic/rclone missing" > status/offsite; exit 1; }
DB="$(ls -1t backups/nightly/fitness-*.dump | head -1)"
MEDIA="$(ls -1t backups/nightly/media-*.tar.gz | head -1)"
fail() { echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > status/offsite; chmod 644 status/offsite; exit 1; }
trap fail ERR
r() { restic -o rclone.timeout=10m "$@"; }
r snapshots >/dev/null 2>&1 || r init
r backup --tag "$COMPOSE_PROJECT_NAME" "$DB" "$MEDIA"
r forget --tag "$COMPOSE_PROJECT_NAME" --group-by host,tags --keep-daily 30 --keep-weekly 12 --keep-monthly 12
if [[ "$(TZ=Asia/Kolkata date +%u)" == 7 || "${FORCE_PRUNE:-0}" == 1 ]]; then r prune; r check; fi
echo "ok $(date -u +%Y-%m-%dT%H:%M:%SZ) $(basename "$DB")" > status/offsite
chmod 644 status/offsite
log "off-site copy ok: $(basename "$DB"), $(basename "$MEDIA")"
