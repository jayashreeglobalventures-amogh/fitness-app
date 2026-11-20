#!/usr/bin/env bash
# Nightly backup of ONE environment (systemd timer fitness-backup@<env>): database (pg_dump -Fc, verified with
# pg_restore --list) + evidence images (tar of the media volume, verified). Weekly (Sunday IST) and monthly
# (2nd IST) copies; rotation 14 nightly / 8 weekly / 12 monthly; status for /healthz; then the off-site copy.
. "$(dirname "$0")/lib.sh"
mkdir -p backups/nightly backups/weekly backups/monthly status && chmod 755 status
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DB="backups/nightly/fitness-$TS.dump"
MEDIA="backups/nightly/media-$TS.tar.gz"
fail() { echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ)" > status/backup.new; chmod 644 status/backup.new; mv status/backup.new status/backup; rm -f "$DB.part" "$MEDIA.part"; exit 1; }
trap fail ERR

dump_db "$DB"
dc exec -T fit-app tar -C /media -czf - . > "$MEDIA.part"
gzip -t "$MEDIA.part"
mv "$MEDIA.part" "$MEDIA"; chmod 600 "$MEDIA"

DOW="$(TZ=Asia/Kolkata date +%u)"; DOM="$(TZ=Asia/Kolkata date +%d)"
if [[ "$DOW" == 7 || "${FORCE_WEEKLY:-0}" == 1 ]]; then cp -p "$DB" "$MEDIA" backups/weekly/; fi
if [[ "$DOM" == 02 || "${FORCE_MONTHLY:-0}" == 1 ]]; then cp -p "$DB" "$MEDIA" backups/monthly/; fi
find backups/nightly -type f -mtime +14 -delete
find backups/weekly -type f -mtime +56 -delete
find backups/monthly -type f -mtime +366 -delete

echo "ok $(date -u +%Y-%m-%dT%H:%M:%SZ) $(basename "$DB")" > status/backup.new
chmod 644 status/backup.new; mv status/backup.new status/backup
log "backup ok: $DB ($(wc -c < "$DB") bytes), $MEDIA ($(wc -c < "$MEDIA") bytes)"
[[ -x ./offsite.sh && -f ./offsite.env ]] && ./offsite.sh || true
