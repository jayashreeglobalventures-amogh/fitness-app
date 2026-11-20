#!/usr/bin/env bash
# cli.sh <command> [args]     The app's admin CLI inside fit-app:
#   create-super-admin <username> "<name>"      first account (prints a temporary password once)
#   create-challenge <slug> <config.json> <admin username>   e.g. calamari-2026 config/challenges/calamari-2026.json
#   apply-config <slug> <config.json> <admin username> "<reason>" [first day]   new rules version from a settings file
#   validate-config <config.json>
. "$(dirname "$0")/lib.sh"
if [[ -t 0 ]]; then tty=(); else tty=(-T); fi
exec docker compose --project-directory "$FIT_DIR" -f compose.yaml exec "${tty[@]}" fit-app node dist/src/cli.js "$@"
