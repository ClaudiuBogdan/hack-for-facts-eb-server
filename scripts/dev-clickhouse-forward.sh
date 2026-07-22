#!/usr/bin/env bash
# Port-forward the chronos prototype ClickHouse (plain HTTP) for the dev
# analytics backend. Pair with PROD_CLICKHOUSE_URL=http://localhost:58123
# (see clickhouse-analysis-repo.ts). Ctrl-C to stop.
set -euo pipefail
KC="${CHRONOS_KUBECONFIG:-$HOME/.kube/chronos.yaml}"
exec kubectl --kubeconfig "$KC" port-forward -n transparenta-eu-etl-prod \
  pod/chi-transparenta-analytics-analytics-0-0-0 58123:8123
