#!/usr/bin/env bash
# Bring up the shared SSH tunnels to the PROD-namespace Griffin services
# (transparenta-eu-etl-prod). One shared tunnel set serves every worktree
# (all read-only, same endpoints); only the server PORT differs per worktree.
# The deprecated `transparenta-unified` namespace is NOT used.
#
# Idempotent: re-running is a no-op if the tmux session is already up.
#   reset with:  tmux kill-session -t redesign-tunnels
set -euo pipefail

SESSION=redesign-tunnels
NS=transparenta-eu-etl-prod
DB_PORT=${DB_PORT:-55432}
MEILI_PORT=${MEILI_PORT:-57700}
OS_PORT=${OS_PORT:-59200}
REDIS_PORT=${REDIS_PORT:-56379}

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tunnels already running ($SESSION) — skipping (kill-session to reset)"
else
  echo "discovering prod-namespace ClusterIPs on griffin..."
  read -r DB MEILI OS REDIS < <(ssh -o ConnectTimeout=12 griffin "kubectl get svc -n $NS -o jsonpath='{.items[?(@.metadata.name==\"transparenta-prod-postgres-rw\")].spec.clusterIP} {.items[?(@.metadata.name==\"transparenta-eu-etl-meilisearch\")].spec.clusterIP} {.items[?(@.metadata.name==\"transparenta-eu-etl-opensearch\")].spec.clusterIP} {.items[?(@.metadata.name==\"transparenta-eu-etl-redis\")].spec.clusterIP}'") || true  # jsonpath has no trailing newline; read returns 1 at EOF under set -e
  echo "  db=$DB meili=$MEILI opensearch=$OS redis=$REDIS"
  [ -n "$DB" ] || { echo "ERROR: could not resolve prod DB ClusterIP"; exit 1; }
  tmux new-session -d -s "$SESSION" \
    "ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -L $DB_PORT:$DB:5432 -L $MEILI_PORT:$MEILI:7700 -L $OS_PORT:$OS:9200 -L $REDIS_PORT:$REDIS:6379 \
      griffin"
  sleep 4
  echo "started $SESSION"
fi

echo "listening tunnel ports:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ":($DB_PORT|$MEILI_PORT|$OS_PORT|$REDIS_PORT)\b" \
  | awk '{print "  ",$1,$9}' | sort -u || echo "  WARN: no tunnel ports listening"
