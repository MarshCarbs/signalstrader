#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: .env not found at ${ENV_FILE}"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed."
  exit 1
fi

read -rp "Enter new SHARES_PER_TRADE (e.g. 12): " NEW_SHARES
NEW_SHARES="$(echo "${NEW_SHARES}" | tr -d '[:space:]')"

if [[ -z "${NEW_SHARES}" ]]; then
  echo "ERROR: value cannot be empty."
  exit 1
fi

if ! [[ "${NEW_SHARES}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: invalid number '${NEW_SHARES}'. Use values like 12 or 12.5"
  exit 1
fi

if grep -q '^SHARES_PER_TRADE=' "${ENV_FILE}"; then
  sed -i "s/^SHARES_PER_TRADE=.*/SHARES_PER_TRADE=${NEW_SHARES}/" "${ENV_FILE}"
else
  echo "SHARES_PER_TRADE=${NEW_SHARES}" >> "${ENV_FILE}"
fi

echo "Updated SHARES_PER_TRADE=${NEW_SHARES} in ${ENV_FILE}"
echo "Restarting bot..."
npm --prefix "${PROJECT_DIR}" run vm:stop
npm --prefix "${PROJECT_DIR}" run vm:start
echo "Done."
