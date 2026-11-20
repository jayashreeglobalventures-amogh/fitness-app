#!/usr/bin/env bash
# restore.sh <db-dump> [--media <media-tar.gz>] --yes     Replace this environment's data with a backup.
# Takes a safety backup of the CURRENT state first, stops the app, restores the database in ONE transaction
# (all or nothing), optionally restores the evidence images, applies migrations, starts the app, checks health.
. "$(dirname "$0")/lib.sh"
DUMP="${1:-}"; shift || true
MEDIA=""; YES=0
while [[ $# -gt 0 ]]; do case "$1" in --media) MEDIA="$2"; shift 2 ;; --yes) YES=1; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
[[ -f "$DUMP" && "$YES" == 1 ]] || { echo "usage: restore.sh <db-dump> [--media <media.tar.gz>] --yes" >&2; exit 2; }
[[ -z "$MEDIA" || -f "$MEDIA" ]] || { echo "no such media archive: $MEDIA" >&2; exit 2; }
[[ -z "$MEDIA" ]] || MEDIA="$(readlink -f "$MEDIA")"

dc exec -T fit-db pg_restore --list < "$DUMP" >/dev/null   # refuse a corrupt file before touching anything
[[ -z "$MEDIA" ]] || gzip -t "$MEDIA"
mkdir -p backups/predeploy
SAFETY="backups/predeploy/prerestore-$(date -u +%Y%m%dT%H%M%SZ).dump"
log "safety backup of the current state -> $SAFETY"
dump_db "$SAFETY"

log "stop fit-app"
dc stop fit-app
log "restore $DUMP"
if ! dc exec -T fit-db pg_restore -U postgres -d fitness --clean --if-exists --single-transaction --exit-on-error < "$DUMP"; then
  log "RESTORE FAILED - nothing changed (single transaction); starting the app on the current data"
  dc up -d fit-app; exit 1
fi
if [[ -n "$MEDIA" ]]; then
  log "restore evidence images from $MEDIA"
  dc run --rm --no-deps --user 0 --entrypoint sh -v "$(dirname "$MEDIA"):/restore:ro" fit-app \
    -c "find /media -mindepth 1 -delete && tar -C /media -xzf /restore/$(basename "$MEDIA") && chown -R 1000:1000 /media"
fi
log "migrations (an older backup may predate the running image's schema)"
dc run --rm fit-migrate
dc up -d fit-app
for _ in $(seq 1 30); do if body="$(healthy)"; then log "healthy: $body"; exit 0; fi; sleep 2; done
log "app not healthy after restore - safety backup: $SAFETY"; exit 1
