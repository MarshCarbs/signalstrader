#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${SCREEN_SESSION_NAME:-signalstrader}"

if ! command -v screen >/dev/null 2>&1; then
  echo "ERROR: screen is not installed."
  exit 1
fi

if screen -list | grep -q "\.${SESSION_NAME}[[:space:]]"; then
  screen -S "${SESSION_NAME}" -X quit
  echo "Stopped screen session '${SESSION_NAME}'."
else
  echo "No running screen session named '${SESSION_NAME}'."
fi
