#!/usr/bin/env bash
# Create + bootstrap one module worktree off redesign/base so a module-orchestrator
# agent can run the server and the tests against the live prod services.
#
#   usage: scripts/redesign/bootstrap-worktree.sh <module> <port>
#   e.g.:  scripts/redesign/bootstrap-worktree.sh pnrr 3017
#
# Produces: .claude/worktrees/redesign-<module> on branch feat/redesign-<module>,
# with a gitignored .env (prod connection copied verbatim + per-worktree PORT) and
# node_modules installed (shared pnpm store).
set -euo pipefail

MODULE="${1:?usage: bootstrap-worktree.sh <module> <port>}"
PORT="${2:?usage: bootstrap-worktree.sh <module> <port>}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PROD_ENV="$REPO_ROOT/.claude/redesign-prod.env"
WT="$REPO_ROOT/.claude/worktrees/redesign-$MODULE"
BR="feat/redesign-$MODULE"

[ -f "$PROD_ENV" ] || { echo "ERROR: $PROD_ENV missing — run gen-prod-env.sh first"; exit 1; }
git -C "$REPO_ROOT" show-ref --verify --quiet refs/heads/redesign/base \
  || { echo "ERROR: redesign/base branch not found"; exit 1; }

if [ -d "$WT" ]; then
  echo "worktree already exists: $WT"
else
  git -C "$REPO_ROOT" worktree add "$WT" -b "$BR" redesign/base
fi

# .env = prod connection (copied verbatim, never parsed) + per-worktree server vars.
# (.env is gitignored inside the worktree.)
umask 077
cp "$PROD_ENV" "$WT/.env"
{
  echo ""
  echo "# --- per-worktree server vars ---"
  echo "NODE_ENV=development"
  echo "LOG_LEVEL=debug"
  echo "PORT=$PORT"
  echo "REDESIGN_MODULE=$MODULE"
} >> "$WT/.env"
chmod 600 "$WT/.env"

( cd "$WT" && pnpm install --frozen-lockfile )

echo "worktree ready: $WT"
echo "  branch=$BR  PORT=$PORT  (server: cd $WT && pnpm dev)"
