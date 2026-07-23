#!/usr/bin/env bash
set -uo pipefail

# Stable, self-healing Phoenix port-forwards for local development.
#
# Production redesign services use direct private Chronos Tailscale endpoints;
# this supervisor intentionally does not forward Griffin or Chronos prod services.
#
# Forwards the Phoenix development services over Tailscale (kubectl, no SSH tunnel):
#   - PHOENIX dev   budget  (hack-for-facts-dev) -> localhost:5432     [legacy server: BUDGET_DATABASE_URL]
#   - PHOENIX dev   userdata                      -> localhost:5433     [legacy server: USER_DATABASE_URL]
#   - PHOENIX dev   ins                           -> localhost:5434     [legacy server: INS_DATABASE_URL]
#   - PHOENIX dev   redis                         -> localhost:16379    [legacy server: REDIS_URL]
#
# Each forward runs in its own infinite reconnect loop: if kubectl port-forward
# drops (idle timeout, pod restart, transient network), it is restarted after a
# short backoff. The script is the supervisor; killing it (Ctrl+C / tmux
# kill-session) tears every forward down cleanly.
#
# Usage:
#   scripts/dev-db-forward.sh            # foreground supervisor (Ctrl+C to stop)
#   scripts/dev-db-forward.sh --tmux     # (re)launch detached in tmux session 'dev-db-forward'
#   scripts/dev-db-forward.sh --status   # show listening ports and exit
#   scripts/dev-db-forward.sh --stop     # kill the tmux session (if any)
#
# Reset a stuck session:  tmux kill-session -t dev-db-forward

SESSION=dev-db-forward
# Absolute path to this script so `--tmux` re-exec works no matter the caller's
# cwd (e.g. invoked as `pnpm dev:forward` / `bash scripts/dev-db-forward.sh`).
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
PHOENIX_KUBECONFIG="${PHOENIX_KUBECONFIG:-$HOME/.kube/phoenix.yaml}"
PHOENIX_NS="${PHOENIX_NS:-hack-for-facts-dev}"
RETRY_DELAY="${RETRY_DELAY:-3}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"

# label | kubeconfig | namespace | svc/<name> | remote_port | local_port
SERVICES=(
  "phoenix-budget-db|$PHOENIX_KUBECONFIG|$PHOENIX_NS|svc/postgres-db-rw|5432|5432"
  "phoenix-user-db|$PHOENIX_KUBECONFIG|$PHOENIX_NS|svc/postgres-userdata-rw|5432|5433"
  "phoenix-ins-db|$PHOENIX_KUBECONFIG|$PHOENIX_NS|svc/postgres-ins-rw|5432|5434"
  "phoenix-redis|$PHOENIX_KUBECONFIG|$PHOENIX_NS|svc/redis|6379|16379"
)

ALL_PORTS="5432|5433|5434|16379"

show_status() {
  echo "listening forward ports:"
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
    | grep -E ":($ALL_PORTS)\b" \
    | awk '{print "  ", $1, $2, $9}' | sort -u \
    || echo "  (none listening)"
}

case "${1:-}" in
  --status) show_status; exit 0 ;;
  --stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped $SESSION" || echo "no $SESSION session"
    exit 0
    ;;
  --tmux)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "already running ($SESSION). reset with: tmux kill-session -t $SESSION"
    else
      tmux new-session -d -s "$SESSION" "exec '$SELF'"
      echo "launched detached tmux session: $SESSION"
      sleep 5
    fi
    show_status
    exit 0
    ;;
esac

# ---- foreground supervisor ----
PIDS=()
cleanup() {
  echo ""
  echo "[forward] shutting down..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null
  echo "[forward] all forwards stopped."
  exit 0
}
trap cleanup SIGINT SIGTERM

forward_loop() {
  local label="$1" kubeconfig="$2" ns="$3" svc="$4" remote="$5" local="$6"
  while true; do
    echo "[$label] forwarding $BIND_ADDR:$local -> $svc:$remote ($ns)"
    KUBECONFIG="$kubeconfig" kubectl port-forward -n "$ns" "$svc" \
      --address "$BIND_ADDR" "$local:$remote" 2>&1 | sed "s/^/[$label] /"
    echo "[$label] dropped — reconnecting in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  done
}

echo "[forward] phoenix kubeconfig: $PHOENIX_KUBECONFIG (ns $PHOENIX_NS)"
echo "[forward] starting ${#SERVICES[@]} forwards (Ctrl+C to stop all)"
echo ""

for entry in "${SERVICES[@]}"; do
  IFS='|' read -r label kubeconfig ns svc remote local <<< "$entry"
  forward_loop "$label" "$kubeconfig" "$ns" "$svc" "$remote" "$local" &
  PIDS+=($!)
done

wait
