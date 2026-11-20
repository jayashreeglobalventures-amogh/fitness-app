#!/usr/bin/env bash
# One-time setup of ONE fitness environment on the shared VPS (docs/VPS_DEPLOYMENT.md). Run as root:
#   sudo bash bootstrap-fitness.sh --env staging    --domain fitness-test.amogh.systems --deploy-key "ssh-ed25519 AAAA... deploy-fitness"
#   sudo bash bootstrap-fitness.sh --env production --domain fitness.amogh.systems      --deploy-key "ssh-ed25519 AAAA... deploy-fitness"
# Safe to re-run: every step checks first; secrets are never overwritten or printed.
# Touches shared infrastructure ONLY by (a) adding deploy-fitness to the existing sshd AllowUsers line, validated
# with `sshd -t` and rolled back on failure, and (b) adding one site file to the shared Caddy, validated with
# `caddy validate` and removed again on failure. Nothing of AaryaShree IMS or Rent is otherwise read or changed.
set -Eeuo pipefail
ENVNAME="" DOMAIN="" DEPLOY_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENVNAME="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --deploy-key) DEPLOY_KEY="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
case "$ENVNAME" in staging) DIR=/opt/fitness-staging; PROJECT=fitness-staging ;; production) DIR=/opt/fitness; PROJECT=fitness ;; *) echo "--env staging|production" >&2; exit 2 ;; esac
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "--domain is required" >&2; exit 2; }
[[ -z "$DEPLOY_KEY" || "$DEPLOY_KEY" == ssh-ed25519\ * ]] || { echo "--deploy-key must be an ssh-ed25519 public key" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$HERE/ssh-gate.sh" && -f "$HERE/fitness.caddy" ]] || { echo "run from the repo's deploy/ directory" >&2; exit 1; }
EDGE_DIR=/opt/edge
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
[[ -f "$EDGE_DIR/compose.yaml" ]] || { echo "shared Caddy edge not found at $EDGE_DIR" >&2; exit 1; }
docker network inspect edge >/dev/null
step() { echo; echo "==> $*"; }

step "Deploy user deploy-fitness (docker group, no sudo, key restricted to fitness-ssh-gate)"
id deploy-fitness >/dev/null 2>&1 || useradd -m -s /bin/bash -U deploy-fitness
usermod -p '*' deploy-fitness
usermod -aG docker deploy-fitness
gpasswd -d deploy-fitness sudo >/dev/null 2>&1 || true
loginctl enable-linger deploy-fitness
install -m 755 -o root -g root "$HERE/ssh-gate.sh" /usr/local/bin/fitness-ssh-gate
install -d -m 700 -o deploy-fitness -g deploy-fitness /home/deploy-fitness/.ssh
if [[ -n "$DEPLOY_KEY" ]]; then
  echo "command=\"/usr/local/bin/fitness-ssh-gate\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $DEPLOY_KEY" > /home/deploy-fitness/.ssh/authorized_keys
  chown deploy-fitness:deploy-fitness /home/deploy-fitness/.ssh/authorized_keys && chmod 600 /home/deploy-fitness/.ssh/authorized_keys
fi

step "sshd: allow deploy-fitness (validated with sshd -t)"
CONF="$(grep -l '^AllowUsers' /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | head -1 || true)"
if [[ -n "$CONF" ]] && ! grep -Eq '^AllowUsers.*\bdeploy-fitness\b' "$CONF"; then
  cp -p "$CONF" "$CONF.bak-fitness"
  sed -i -E 's/^(AllowUsers .*)$/\1 deploy-fitness/' "$CONF"
  if sshd -t; then systemctl reload-or-restart ssh; rm -f "$CONF.bak-fitness"; echo "added deploy-fitness to AllowUsers in $CONF"
  else mv "$CONF.bak-fitness" "$CONF"; echo "sshd -t failed - change rolled back" >&2; exit 1; fi
else
  echo "AllowUsers already includes deploy-fitness (or is not used)"
fi

step "Environment directory $DIR and secrets"
install -d -m 750 -o deploy-fitness -g deploy-fitness "$DIR" "$DIR/backups"
install -d -m 755 -o deploy-fitness -g deploy-fitness "$DIR/status"
if [[ ! -f "$DIR/.env" ]]; then
  rnd() { openssl rand -hex "$1"; }
  umask 077
  cat > "$DIR/.env" <<ENV
# $ENVNAME secrets. 600, owner deploy-fitness. NEVER commit or paste anywhere else; copy into your password manager.
COMPOSE_PROJECT_NAME=$PROJECT
FIT_DOMAIN=$DOMAIN
FIT_APP_ALIAS=fit-app-$ENVNAME
POSTGRES_SUPERUSER_PASSWORD=$(rnd 16)
FIT_OWNER_PASSWORD=$(rnd 16)
FIT_APP_PASSWORD=$(rnd 16)
# Screenshot reading (Claude). Set with: $DIR/set-key.sh anthropic   (empty = manual review only)
ANTHROPIC_API_KEY=
FITNESS_SCHEDULER_ENABLED=true
ENV
  chown deploy-fitness:deploy-fitness "$DIR/.env"; chmod 600 "$DIR/.env"
  echo "created $DIR/.env - copy it into your password manager: sudo cat $DIR/.env"
else
  echo "$DIR/.env exists - left unchanged"
fi

step "Shared Caddy: site file for $DOMAIN (validated before reload)"
SITE="$EDGE_DIR/sites/fitness-$ENVNAME.caddy"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__ALIAS__/fit-app-$ENVNAME/g" "$HERE/fitness.caddy" > "$SITE.new"
chmod 644 "$SITE.new"
EXISTED=0; [[ -f "$SITE" ]] && { cp -p "$SITE" "$SITE.prev"; EXISTED=1; }
mv "$SITE.new" "$SITE"
edge() { docker compose --project-directory "$EDGE_DIR" -f "$EDGE_DIR/compose.yaml" "$@"; }
if edge exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  rm -f "$SITE.prev"
  echo "Caddy now serves $DOMAIN (HTTPS certificate is obtained on first request once DNS points here)"
else
  if [[ $EXISTED == 1 ]]; then mv "$SITE.prev" "$SITE"; else rm -f "$SITE"; fi
  echo "caddy validate FAILED - site file removed, Caddy untouched" >&2; exit 1
fi

step "Done"
cat <<NEXT
Next (docs/VPS_DEPLOYMENT.md):
  1. sudo -iu deploy-fitness docker login ghcr.io -u <github user>    # paste a token with read:packages only
  2. GitHub: set the deploy secrets/variables, then run the deploy workflow for $ENVNAME.
  3. First account:   sudo -iu deploy-fitness $DIR/cli.sh create-super-admin <username> "<name>"
  4. Calamari:        sudo -iu deploy-fitness $DIR/cli.sh create-challenge calamari-2026 config/challenges/calamari-2026.json <username>
  5. (optional) screenshot reading:  sudo -iu deploy-fitness $DIR/set-key.sh anthropic
NEXT
