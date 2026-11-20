#!/usr/bin/env bash
# CI rehearsal of the VPS deployment on a GitHub runner, with the REAL deploy/ files:
# layout as bootstrap-fitness.sh leaves it -> deploy through the real SSH gate -> HTTPS via Caddy + headers ->
# first Super Admin + sign in + Calamari from its settings file -> fit_app has no DDL, audit is append-only, DB not
# published -> backup + restore test -> restore.sh brings back the backed-up state -> broken image rolls back -> redeploy keeps data.
set -Eeuo pipefail
GOOD="$1"; BAD="$2"
export FIT_STAGING_DIR="$RUNNER_TEMP/fitness-staging" SKIP_PULL=1 HEALTH_INSECURE=1
DIR="$FIT_STAGING_DIR"; EDGE="$RUNNER_TEMP/edge"
step() { echo; echo "::group::$*"; }
end() { echo "::endgroup::"; }
gate() { SSH_ORIGINAL_COMMAND="$1" deploy/ssh-gate.sh < "${2:-/dev/null}"; }
dc() { IMAGE_TAG="$(cat "$DIR/IMAGE_TAG")" docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" "$@"; }
BASE="https://localhost"
C=(-fsSk)
J="$(mktemp)"
api() { curl "${C[@]}" -b "$J" -c "$J" -H "Origin: $BASE" -H 'Content-Type: application/json' "$@"; }

step "Edge (stand-in for the shared Caddy) + layout as bootstrap-fitness.sh leaves it"
docker network create edge >/dev/null
mkdir -p "$EDGE/sites" && cp .github/scripts/edge/compose.yaml .github/scripts/edge/Caddyfile "$EDGE/"
sed -e "s/__DOMAIN__/localhost/g" -e "s/__ALIAS__/fit-app-staging/g" deploy/fitness.caddy > "$EDGE/sites/fitness-staging.caddy"
docker compose --project-directory "$EDGE" -f "$EDGE/compose.yaml" up -d --quiet-pull
install -d -m 750 "$DIR" "$DIR/backups"
install -d -m 755 "$DIR/status"
umask 077
cat > "$DIR/.env" <<ENV
COMPOSE_PROJECT_NAME=fitness-staging
FIT_DOMAIN=localhost
FIT_APP_ALIAS=fit-app-staging
POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -hex 16)
FIT_OWNER_PASSWORD=$(openssl rand -hex 16)
FIT_APP_PASSWORD=$(openssl rand -hex 16)
ANTHROPIC_API_KEY=
FITNESS_SCHEDULER_ENABLED=true
ENV
umask 022
tar -czf "$RUNNER_TEMP/bundle.tgz" deploy   # what deploy.yml sends (git archive of deploy/)
end

step "Gate refuses anything else"
if gate "id" 2>/dev/null; then echo "gate allowed 'id'"; exit 1; fi
if gate "deploy staging not-a-sha" 2>/dev/null; then echo "gate allowed a bad sha"; exit 1; fi
if gate "deploy production $GOOD" 2>/dev/null; then echo "gate allowed an environment that is not set up"; exit 1; fi
end

step "Deploy $GOOD to staging"
gate "deploy staging $GOOD" "$RUNNER_TEMP/bundle.tgz"
[[ "$(cat "$DIR/IMAGE_TAG")" == "$GOOD" ]]
gate "status staging"
end

step "HTTPS through Caddy, HTTP -> HTTPS, security headers, the app is served"
MIGS="$(node -e "console.log(require('./src/db/migrations/meta/_journal.json').entries.length)")"
H="$(curl "${C[@]}" -D - "$BASE/healthz")"; echo "$H"
grep -q '"status":"ok"' <<<"$H"; grep -q "\"migrations\":$MIGS" <<<"$H"; grep -q '"scheduler":"on"' <<<"$H"
grep -qi '^strict-transport-security: max-age=31536000' <<<"$H"
P="$(curl "${C[@]}" -D - "$BASE/challenges")"
grep -qi "^content-security-policy: default-src 'self'" <<<"$P"; grep -qi '^x-frame-options: DENY' <<<"$P"; grep -q '<div id="root">' <<<"$P"
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/)" =~ ^30[18]$ ]]
[[ "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/challenges")" == 401 ]]
end

step "First Super Admin (CLI) + sign in + Calamari from its settings file"
OUT="$("$DIR/cli.sh" create-super-admin owner Owner)"; echo "${OUT%%:*}"
PW="${OUT##*: }"
api -d "{\"username\":\"owner\",\"password\":\"$PW\"}" "$BASE/api/auth/login" | grep -q '"mustChangePassword":true'
NEWPW="$(openssl rand -hex 12)"
api -d "{\"current\":\"$PW\",\"next\":\"$NEWPW\"}" "$BASE/api/auth/change-password" | grep -q '"success":true'
"$DIR/cli.sh" create-challenge calamari-2026 config/challenges/calamari-2026.json owner
api "$BASE/api/challenges" | grep -q '"name":"Calamari"'
api -X POST -d '{}' "$BASE/api/challenges/1/publish" | grep -q '"success":true'
api -d '{"username":"priya","displayName":"Priya"}' "$BASE/api/admin/users" | grep -q '"tempPassword"'
end

step "fit_app has no DDL; audit log is append-only; PostgreSQL is not reachable from the host"
if dc exec -T fit-db psql -U fit_app -d fitness -c 'create table ci_should_fail(i int)' 2>/dev/null; then echo "fit_app could run DDL"; exit 1; fi
if dc exec -T fit-db psql -U fit_app -d fitness -v ON_ERROR_STOP=1 -c 'delete from audit_log' 2>/dev/null; then echo "audit_log is not append-only"; exit 1; fi
if dc exec -T fit-db psql -U postgres -d fitness -v ON_ERROR_STOP=1 -c "update audit_log set action = 'x'" 2>/dev/null; then echo "audit_log is not append-only for postgres"; exit 1; fi
if nc -z -w 2 127.0.0.1 5432; then echo "5432 is published"; exit 1; fi
end

step "Backup + restore test"
FORCE_WEEKLY=1 "$DIR/backup.sh"
grep -q '^ok ' "$DIR/status/backup"
ls "$DIR"/backups/weekly/*.dump "$DIR"/backups/weekly/media-*.tar.gz
"$DIR/restore-test.sh"
grep -q '^ok .*missing_files=0' "$DIR/status/restore"
curl "${C[@]}" "$BASE/healthz" | grep -q '"backup":{"status":"ok"'
end

step "restore.sh: an account created after the backup disappears when the backup is restored"
api -d '{"username":"after.backup","displayName":"After"}' "$BASE/api/admin/users" | grep -q '"tempPassword"'
[[ "$(dc exec -T fit-db psql -At -U postgres -d fitness -c "select count(*) from users where username = 'after.backup'")" == 1 ]]
MEDIA="$(ls -1t "$DIR"/backups/nightly/media-*.tar.gz | head -1)"
"$DIR/restore.sh" "$(ls -1t "$DIR"/backups/nightly/fitness-*.dump | head -1)" --media "$MEDIA" --yes
[[ "$(dc exec -T fit-db psql -At -U postgres -d fitness -c "select count(*) from users where username = 'after.backup'")" == 0 ]]
api -d "{\"username\":\"owner\",\"password\":\"$NEWPW\"}" "$BASE/api/auth/login" | grep -q '"success":true'
api "$BASE/api/challenges" | grep -q '"name":"Calamari"'
end

step "Broken image: health fails -> automatic rollback"
if gate "deploy staging $BAD" "$RUNNER_TEMP/bundle.tgz"; then echo "bad deploy should have failed"; exit 1; fi
[[ "$(cat "$DIR/IMAGE_TAG")" == "$GOOD" ]]
curl "${C[@]}" "$BASE/healthz" | grep -q '"status":"ok"'
end

step "Redeploy (idempotent) keeps data"
gate "deploy staging $GOOD" "$RUNNER_TEMP/bundle.tgz"
api "$BASE/api/challenges" | grep -q '"name":"Calamari"'
[[ "$(ls "$DIR"/backups/predeploy/*.dump | wc -l)" -ge 3 ]]
end
echo "STACK TEST PASSED"
