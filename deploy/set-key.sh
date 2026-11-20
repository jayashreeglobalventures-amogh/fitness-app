#!/usr/bin/env bash
# set-key.sh anthropic            Sets ANTHROPIC_API_KEY (screenshot reading), read from stdin so it never appears in
#                                 the shell history or the process list; empty input turns reading off.
# Edits only that line of .env, recreates the app, prints /healthz.
. "$(dirname "$0")/lib.sh"
[[ "${1:-}" == anthropic ]] || { echo "usage: set-key.sh anthropic   (then paste the key and press Enter)" >&2; exit 2; }
read -rs -p "Anthropic API key (empty = off): " KEY; echo
[[ -z "$KEY" || "$KEY" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { echo "that does not look like an Anthropic API key" >&2; exit 1; }
if grep -q '^ANTHROPIC_API_KEY=' .env; then sed -i.bak "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$KEY|" .env && rm -f .env.bak; else echo "ANTHROPIC_API_KEY=$KEY" >> .env; fi
export ANTHROPIC_API_KEY="$KEY"
log "screenshot reading: $([[ -n "$KEY" ]] && echo on || echo off)"
dc up -d fit-app
for _ in $(seq 1 30); do if body="$(healthy)"; then echo "$body"; exit 0; fi; sleep 2; done
log "app not healthy"; exit 1
