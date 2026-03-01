#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${SCREEN_SESSION_NAME:-signalstrader}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/screen_${SESSION_NAME}.log"

if ! command -v screen >/dev/null 2>&1; then
  echo "ERROR: screen is not installed. Install it with: sudo apt-get install -y screen"
  exit 1
fi

if screen -list | grep -q "\.${SESSION_NAME}[[:space:]]"; then
  echo "Screen session '${SESSION_NAME}' already exists."
  echo "Attach with: screen -r ${SESSION_NAME}"
  exit 0
fi

cd "${PROJECT_DIR}"
npm run build

mkdir -p "${LOG_DIR}"
: > "${LOG_FILE}"

screen -L -Logfile "${LOG_FILE}" -dmS "${SESSION_NAME}" bash -lc "cd '${PROJECT_DIR}' && npm run start:prod"
sleep 2

if ! screen -list | grep -q "\.${SESSION_NAME}[[:space:]]"; then
  echo "ERROR: Bot process exited immediately. Screen session was not kept alive."
  echo "Check startup log: ${LOG_FILE}"
  if [[ -f "${LOG_FILE}" ]]; then
    echo "---- Last startup log lines ----"
    tail -n 80 "${LOG_FILE}" || true
    echo "--------------------------------"
  fi
  exit 1
fi

echo "Bot started in screen session '${SESSION_NAME}'."
echo "Attach: screen -r ${SESSION_NAME}"
echo "List sessions: screen -ls"
echo "Log file: ${LOG_FILE}"
