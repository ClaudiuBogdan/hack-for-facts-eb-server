#!/usr/bin/env bash
# Port-forward the chronos prototype ClickHouse (plain HTTP) for the dev
# analytics backend. Pair with PROD_CLICKHOUSE_URL=http://localhost:58123
# (see clickhouse-analysis-repo.ts). Ctrl-C to stop.
#
# Auto-restarts: kubectl port-forward tears down on any connection blip, which
# leaves the dev API logging ClickHouse errors — loop with a short backoff so
# one terminal keeps the forward alive.
set -uo pipefail
KC="${CHRONOS_KUBECONFIG:-$HOME/.kube/chronos.yaml}"
while true; do
  kubectl --kubeconfig "$KC" port-forward -n transparenta-eu-etl-prod \
    pod/chi-transparenta-analytics-analytics-0-0-0 58123:8123
  echo "port-forward exited ($?) — retrying in 3s (Ctrl-C to stop)" >&2
  sleep 3
done
