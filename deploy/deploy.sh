#!/usr/bin/env bash
# deploy.sh <40-char commit sha>     (run through fitness-ssh-gate by the deploy workflow; FIT_DIR selects the environment)
# 1 pull image  2 database up  3 pre-deploy backup  4 migrations (failure stops here; the running app is untouched)
# 5 switch IMAGE_TAG (keep PREVIOUS_TAG)  6 health through Caddy  7 automatic rollback  8 prune old images
. "$(dirname "$0")/lib.sh"
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: deploy.sh <40-char commit sha>" >&2; exit 2; }
mkdir -p backups/predeploy status && chmod 755 status
chmod 755 initdb && chmod 755 initdb/*.sh  # read by postgres (uid 70)

if [[ "${SKIP_PULL:-0}" != 1 ]]; then log "pull $REPO:$SHA"; docker pull -q "$REPO:$SHA" >/dev/null; fi
docker image inspect "$REPO:$SHA" >/dev/null
docker network inspect edge >/dev/null 2>&1 || { log "the shared 'edge' network is missing (is the Caddy edge running?)"; exit 1; }

compose "$SHA" up -d --wait fit-db

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="backups/predeploy/predeploy-${SHA:0:12}-$TS.dump"
log "pre-deploy backup -> $DUMP"
compose "$SHA" exec -T fit-db pg_dump -Fc -U fit_owner fitness > "$DUMP"
compose "$SHA" exec -T fit-db pg_restore --list < "$DUMP" >/dev/null
chmod 600 "$DUMP"
ls -1t backups/predeploy/predeploy-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f   # keep 10 (prerestore- kept)

log "migrations"
if ! compose "$SHA" run --rm fit-migrate; then log "MIGRATION FAILED - nothing switched"; exit 1; fi

PREV="$(cat IMAGE_TAG 2>/dev/null || true)"
[[ -n "$PREV" && "$PREV" != "$SHA" ]] && echo "$PREV" > PREVIOUS_TAG
echo "$SHA" > IMAGE_TAG
log "start fit-app $SHA (previous: ${PREV:-none})"
compose "$SHA" up -d fit-app

body=""
for _ in $(seq 1 30); do if body="$(healthy)"; then log "healthy: $body"; break; fi; body=""; sleep 2; done

if [[ -z "$body" ]]; then
  log "HEALTH CHECK FAILED for $SHA"
  if [[ -n "$PREV" && "$PREV" != "$SHA" ]]; then
    echo "$PREV" > IMAGE_TAG
    compose "$PREV" up -d fit-app
    for _ in $(seq 1 30); do healthy >/dev/null && { log "rolled back to $PREV (healthy)"; exit 1; }; sleep 2; done
    log "ROLLBACK ALSO UNHEALTHY - restore from $DUMP may be needed (restore.sh)"
  fi
  exit 1
fi

docker image ls "$REPO" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +8 | cut -f2 \
  | grep -v -e ":$SHA\$" -e ":${PREV:-none}\$" | xargs -r docker image rm >/dev/null 2>&1 || true
log "deployed $SHA"
