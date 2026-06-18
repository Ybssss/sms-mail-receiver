#!/usr/bin/env bash
# Push to https://github.com/Ybssss/sms-mail-receiver
# Usage:
#   ./scripts/push-to-github.sh
#   ./scripts/push-to-github.sh "update mail receiver"

set -euo pipefail

REMOTE_URL="${REMOTE_URL:-https://github.com/Ybssss/sms-mail-receiver.git}"
COMMIT_MESSAGE="${1:-first commit}"
BRANCH="${BRANCH:-main}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Project: $PROJECT_ROOT"
echo "Remote:  $REMOTE_URL"

command -v git >/dev/null

if [[ ! -d .git ]]; then
  git init
fi

if [[ -f .env ]] && git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "ERROR: .env is tracked by git. Run: git rm --cached .env"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "$COMMIT_MESSAGE"
  echo "Committed changes."
else
  echo "No file changes to commit."
fi

git branch -M "$BRANCH"

if ! git remote | grep -q .; then
  git remote add origin "$REMOTE_URL"
  echo "Added remote origin."
else
  current_url="$(git remote get-url origin)"
  if [[ "$current_url" != "$REMOTE_URL" ]]; then
    echo "Updating origin: $current_url -> $REMOTE_URL"
    git remote set-url origin "$REMOTE_URL"
  fi
fi

echo "Pushing to origin/$BRANCH..."
git fetch origin "$BRANCH" 2>/dev/null || true
if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git pull --rebase origin "$BRANCH"
fi
git push -u origin "$BRANCH"

echo ""
echo "Done: https://github.com/Ybssss/sms-mail-receiver"
