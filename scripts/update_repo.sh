#!/usr/bin/env bash
set -euo pipefail

REMOTE="${UPDATE_REMOTE:-origin}"
BRANCH="${UPDATE_BRANCH:-main}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not installed."
  exit 1
fi

cd "${PROJECT_DIR}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: ${PROJECT_DIR} is not a git repository."
  exit 1
fi

HAS_LOCAL_CHANGES=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  HAS_LOCAL_CHANGES=1
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  HAS_LOCAL_CHANGES=1
fi

STASHED=0
STASH_NAME="auto-backup-before-update-$(date -u +%Y%m%d-%H%M%S)"

if [[ "${HAS_LOCAL_CHANGES}" -eq 1 ]]; then
  echo "Local changes detected. Saving backup stash: ${STASH_NAME}"
  git stash push -u -m "${STASH_NAME}" >/dev/null
  STASHED=1
else
  echo "No local changes detected."
fi

echo "Pulling latest changes from ${REMOTE}/${BRANCH}..."
git pull "${REMOTE}" "${BRANCH}"

if [[ "${STASHED}" -eq 1 ]]; then
  echo "Re-applying local changes..."
  if git stash pop --index; then
    echo "Local changes restored."
  else
    echo "WARNING: Could not apply stash cleanly."
    echo "Resolve conflicts, then check stash list with: git stash list"
    exit 1
  fi
fi

echo "Update complete."
