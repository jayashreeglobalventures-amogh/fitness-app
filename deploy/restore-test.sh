#!/usr/bin/env bash
# Weekly restore test (systemd timer fitness-restore-test@<env>): restore the newest database dump into a
# throwaway PostgreSQL with NO network, check that every stored evidence file is in the image archive, then remove it.
. "$(dirname "$0")/lib.sh"
mkdir -p status && chmod 755 status
DUMP="${1:-$(ls -1t backups/nightly/*.dump backups/predeploy/*.dump 2>/dev/null | head -1)}"
MEDIA="$(ls -1t backups/nightly/media-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -f "$DUMP" ]] || { echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ) no-dump" > status/restore; exit 1; }
NAME="fitness-restore-test-$$"
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ) $(basename "$DUMP")" > status/restore; chmod 644 status/restore; exit 1; }
trap fail ERR

docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=restore-test -e POSTGRES_DB=fitness postgres:17.11-alpine >/dev/null
for _ in $(seq 1 90); do docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d fitness >/dev/null 2>&1 && break; sleep 1; done
sleep 1
docker exec "$NAME" psql -q -U postgres -d fitness -c "CREATE ROLE fit_owner; CREATE ROLE fit_app;" >/dev/null
docker exec -i "$NAME" pg_restore -U postgres -d fitness --exit-on-error --no-owner --role=postgres < "$DUMP"
q() { docker exec "$NAME" psql -At -U postgres -d fitness -c "$1"; }
USERS="$(q 'select count(*) from users')"
SUBMISSIONS="$(q 'select count(*) from submissions')"
MIGRATIONS="$(q 'select count(*) from drizzle.__drizzle_migrations')"
MISSING=0
if [[ -n "$MEDIA" ]]; then
  # Every file the database refers to must be in the archive (content-addressed keys: u/<user>/sha256/xx/<sha>).
  comm -23 <(q 'select distinct storage_key from files' | sort) <(tar -tzf "$MEDIA" | sed 's#^\./##' | sort) > "status/restore-missing.txt" || true
  MISSING="$(wc -l < status/restore-missing.txt | tr -d ' ')"
fi
echo "restored $(basename "$DUMP"): users=$USERS submissions=$SUBMISSIONS migrations=$MIGRATIONS missing_files=$MISSING"
[[ "$MIGRATIONS" -ge 1 && "$MISSING" == 0 ]] || fail
echo "ok $(date -u +%Y-%m-%dT%H:%M:%SZ) $(basename "$DUMP") users=$USERS submissions=$SUBMISSIONS missing_files=$MISSING" > status/restore
chmod 644 status/restore
