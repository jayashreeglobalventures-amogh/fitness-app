#!/usr/bin/env bash
# set-key.sh anthropic            Sets ANTHROPIC_API_KEY (screenshot reading by Claude).
# set-key.sh omniroute            Sets OMNIROUTE_API_KEY (screenshot reading and, with COACH_WRITER=omniroute in .env,
#                                 the AI coach, through the OmniRoute gateway).
# The key is read from stdin so it never appears in the shell history or the process list; empty input turns it off.
# Edits only that line of .env, recreates the app, prints /healthz.
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  anthropic) VAR=ANTHROPIC_API_KEY; LABEL="Anthropic API key"; PATTERN='^sk-ant-[A-Za-z0-9_-]{20,}$' ;;
  omniroute) VAR=OMNIROUTE_API_KEY; LABEL="OmniRoute API key"; PATTERN='^[A-Za-z0-9_.-]{16,}$' ;;
  *) echo "usage: set-key.sh anthropic|omniroute   (then paste the key and press Enter)" >&2; exit 2 ;;
esac
read -rs -p "$LABEL (empty = off): " KEY; echo
[[ -z "$KEY" || "$KEY" =~ $PATTERN ]] || { echo "that does not look like an $LABEL" >&2; exit 1; }
if grep -q "^$VAR=" .env; then sed -i.bak "s|^$VAR=.*|$VAR=$KEY|" .env && rm -f .env.bak; else echo "$VAR=$KEY" >> .env; fi
export "$VAR=$KEY"
log "$LABEL: $([[ -n "$KEY" ]] && echo on || echo off)"
dc up -d fit-app
for _ in $(seq 1 30); do if body="$(healthy)"; then echo "$body"; exit 0; fi; sleep 2; done
log "app not healthy"; exit 1
