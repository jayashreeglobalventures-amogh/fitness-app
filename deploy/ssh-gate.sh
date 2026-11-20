#!/usr/bin/env bash
# Forced command for the deploy-fitness SSH key (installed by bootstrap-fitness.sh as /usr/local/bin/fitness-ssh-gate,
# root-owned). Allowed, and nothing else:
#   deploy <staging|production> <sha>   stdin = tar.gz of the repo's deploy/ directory at <sha>
#   status <staging|production>         deployed tag, previous tag, backup / restore-test status
set -Eeuo pipefail
umask 077
read -r cmd envname arg extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ -z "${extra:-}" ]] || { echo "denied" >&2; exit 1; }
case "$envname" in
  staging) DIR="${FIT_STAGING_DIR:-/opt/fitness-staging}" ;;
  production) DIR="${FIT_PRODUCTION_DIR:-/opt/fitness}" ;;
  *) echo "denied: environment must be staging or production" >&2; exit 1 ;;
esac
[[ -f "$DIR/.env" ]] || { echo "denied: $envname is not set up on this server" >&2; exit 1; }

case "$cmd" in
  deploy)
    [[ "$arg" =~ ^[0-9a-f]{40}$ ]] || { echo "denied: bad sha" >&2; exit 1; }
    stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
    head -c 5000000 | tar -xz -C "$stage" --no-same-owner --no-same-permissions
    src="$stage/deploy"
    [[ -f "$src/deploy.sh" && -f "$src/compose.yaml" && -f "$src/lib.sh" ]] || { echo "denied: bad bundle" >&2; exit 1; }
    for f in "$src"/*.sh; do
      case "$(basename "$f")" in bootstrap-fitness.sh|ssh-gate.sh) ;; *) install -m 700 "$f" "$DIR/" ;; esac
    done
    install -m 600 "$src/compose.yaml" "$DIR/"
    install -d -m 755 "$DIR/initdb" && install -m 755 "$src"/initdb/*.sh "$DIR/initdb/"
    units="$HOME/.config/systemd/user"; mkdir -p "$units"
    install -m 644 "$src"/systemd/*.service "$src"/systemd/*.timer "$units/"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    { systemctl --user daemon-reload && systemctl --user enable --now "fitness-backup@$envname.timer" "fitness-restore-test@$envname.timer"; } >/dev/null 2>&1 \
      || echo "warning: backup timers not enabled (systemd user session unavailable)"
    rm -rf "$stage"; trap - EXIT
    FIT_DIR="$DIR" exec "$DIR/deploy.sh" "$arg"
    ;;
  status)
    cd "$DIR"
    echo "environment: $envname ($DIR)"
    echo "image: $(cat IMAGE_TAG 2>/dev/null || echo none) (previous: $(cat PREVIOUS_TAG 2>/dev/null || echo none))"
    echo "backup: $(cat status/backup 2>/dev/null || echo none)"
    echo "restore-test: $(cat status/restore 2>/dev/null || echo none)"
    echo "offsite: $(cat status/offsite 2>/dev/null || echo none)"
    ;;
  *) echo "denied" >&2; exit 1 ;;
esac
