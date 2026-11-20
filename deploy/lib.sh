# Shared helpers for the fitness ops scripts. Sourced, not run.
# FIT_DIR = the environment directory (/opt/fitness-staging or /opt/fitness); its .env holds the secrets and
# COMPOSE_PROJECT_NAME / FIT_DOMAIN / FIT_APP_ALIAS for that environment.
set -Eeuo pipefail
umask 077
# Scripts are installed inside their environment directory, so that directory is the default.
FIT_DIR="${FIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)}"
[[ -f "$FIT_DIR/.env" ]] || { echo "no .env in $FIT_DIR (not a fitness environment directory)" >&2; exit 1; }
REPO="ghcr.io/jayashreeglobalventures-amogh/fitness-app"
cd "$FIT_DIR"
set -a; . ./.env; set +a
: "${COMPOSE_PROJECT_NAME:?}" "${FIT_DOMAIN:?}" "${FIT_APP_ALIAS:?}"
log() { echo "[$(basename "$0" .sh) $(date -u +%H:%M:%S)] $*"; }
compose() { IMAGE_TAG="$1" docker compose --project-directory "$FIT_DIR" -f "$FIT_DIR/compose.yaml" "${@:2}"; }
dc() { compose "$(cat "$FIT_DIR/IMAGE_TAG")" "$@"; }
healthy() {
  local body
  body="$(curl -fsS --max-time 5 ${HEALTH_INSECURE:+-k} --resolve "$FIT_DOMAIN:443:127.0.0.1" "https://$FIT_DOMAIN/healthz" 2>/dev/null)" || return 1
  grep -q '"status":"ok"' <<<"$body" && grep -q '"database":"ok"' <<<"$body" && echo "$body"
}
dump_db() { dc exec -T fit-db pg_dump -Fc -U fit_owner fitness > "$1.part" && dc exec -T fit-db pg_restore --list < "$1.part" >/dev/null && mv "$1.part" "$1" && chmod 600 "$1"; }
