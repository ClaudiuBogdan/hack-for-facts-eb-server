#!/usr/bin/env bash
# Generate the redesign PROD connection env from the live Chronos namespace secrets,
# SECRET-SAFELY: credentials are fetched with an explicit guarded kubeconfig and written to a
# gitignored file — never printed to stdout / the terminal / agent context.
#
# Output: <repo>/.claude/redesign-prod.env  (under gitignored .claude/, chmod 600)
# Points directly at private Tailscale ingress by default. Phoenix development
# database and Redis forwarding remains independent in scripts/dev-db-forward.sh.
set -euo pipefail

NS=transparenta-eu-etl-prod
DB_CREDENTIAL_SECRET=${DB_CREDENTIAL_SECRET:-transparenta-prod-agent-readonly-credentials}
MEILI_MASTER_SECRET=${MEILI_MASTER_SECRET:-${MEILI_CREDENTIAL_SECRET:-transparenta-eu-etl-meilisearch-master-key}}
OS_CREDENTIAL_SECRET=${OS_CREDENTIAL_SECRET:-transparenta-opensearch-reader}
OS_TLS_SECRET=${OS_TLS_SECRET:-transparenta-opensearch-tls}
CH_CREDENTIAL_SECRET=${CH_CREDENTIAL_SECRET:-transparenta-clickhouse-users}
DB_HOST=${DB_HOST:-chronos-prod-postgres.basa-discus.ts.net}
DB_PORT=${DB_PORT:-5432}
MEILI_HOST=${MEILI_HOST:-chronos-prod-meilisearch.basa-discus.ts.net}
MEILI_PORT=${MEILI_PORT:-7700}
OS_HOST=${OS_HOST:-chronos-prod-opensearch.basa-discus.ts.net}
OS_PORT=${OS_PORT:-9200}
OS_TLS_SERVERNAME=${OS_TLS_SERVERNAME:-transparenta-eu-etl-opensearch.transparenta-eu-etl-prod.svc.cluster.local}
CH_HOST=${CH_HOST:-chronos-prod-clickhouse.basa-discus.ts.net}
CH_PORT=${CH_PORT:-8123}
CH_DATABASE=${CH_DATABASE:-proto}
CH_USER=${CH_USER:-readonly}
REPO_ROOT="$(git rev-parse --show-toplevel)"
OUT=${OUT:-$REPO_ROOT/.claude/redesign-prod.env}
OUT_OS_CA=${OUT_OS_CA:-$REPO_ROOT/.claude/chronos-opensearch-ca.pem}
# Separate file for libpq PG* vars (psql tooling). Kept OUT of the app env because
# `pnpm dev` loads redesign-prod.env into the legacy server process, and an ambient
# PGSSLMODE=require would force SSL onto the plain phoenix-dev DB forwards.
OUT_PSQL=${OUT_PSQL:-$REPO_ROOT/.claude/redesign-psql.env}
CHRONOS_KUBECONFIG=${CHRONOS_KUBECONFIG:-$HOME/.kube/chronos.yaml}
CHRONOS_CONTEXT=${CHRONOS_CONTEXT:-chronos}
SERVER_AGENT_ROOT=${SERVER_AGENT_ROOT:-$(cd "$REPO_ROOT/../.." && pwd)/server-agent}
TARGET_GUARD=${TARGET_GUARD:-$SERVER_AGENT_ROOT/chronos/kubernetes/transparenta-eu/scripts/verify-chronos-target.sh}
TARGET_IDENTITY=${TARGET_IDENTITY:-$SERVER_AGENT_ROOT/chronos/kubernetes/transparenta-eu/configs/chronos-target.env}

[[ "$CHRONOS_KUBECONFIG" = /* ]] || { echo "ERROR: CHRONOS_KUBECONFIG must be absolute"; exit 1; }
"$TARGET_GUARD" \
  --kubeconfig "$CHRONOS_KUBECONFIG" \
  --context "$CHRONOS_CONTEXT" \
  --identity "$TARGET_IDENTITY"

kubectl_args=(--kubeconfig "$CHRONOS_KUBECONFIG" --context "$CHRONOS_CONTEXT" -n "$NS")
secret_value() {
  local secret=$1 key=$2 value
  value=$(kubectl "${kubectl_args[@]}" get secret "$secret" -o json \
    | jq -r --arg key "$key" '.data[$key] // empty' \
    | base64 -d)
  [[ -n "$value" ]] || { echo "ERROR: missing $secret/$key" >&2; return 1; }
  printf '%s' "$value"
}

# Values stay in process memory and gitignored mode-0600 files; they are never printed.
U=$(secret_value "$DB_CREDENTIAL_SECRET" username)
P=$(secret_value "$DB_CREDENTIAL_SECRET" password)
MEILI_MASTER=$(secret_value "$MEILI_MASTER_SECRET" MEILI_MASTER_KEY)
OSU=$(secret_value "$OS_CREDENTIAL_SECRET" username)
OSP=$(secret_value "$OS_CREDENTIAL_SECRET" password)
OS_CA=$(secret_value "$OS_TLS_SECRET" ca.pem)
CHP=$(secret_value "$CH_CREDENTIAL_SECRET" readonly_password)

meili_search_key() {
  local master_key=$1
  local url=$2
  local master_config keys candidate_count uid key single
  local search_config search_status keys_admin_status

  master_config=$(printf 'header = "Authorization: Bearer %s"\n' "$master_key")
  keys=$(printf '%s' "$master_config" | curl --silent --show-error --fail \
    --config - "$url/keys?limit=100")
  candidate_count=$(printf '%s' "$keys" | jq \
    '[.results[] | select(.actions == ["search"] and .indexes == ["*"] and .expiresAt == null)] | length')
  [[ "$candidate_count" -eq 1 ]] || {
    echo "ERROR: expected exactly one built-in Meilisearch search-only key, found $candidate_count" >&2
    return 1
  }

  uid=$(printf '%s' "$keys" | jq -r \
    '.results[] | select(.actions == ["search"] and .indexes == ["*"] and .expiresAt == null) | .uid')
  key=$(printf '%s' "$keys" | jq -r \
    '.results[] | select(.actions == ["search"] and .indexes == ["*"] and .expiresAt == null) | .key // empty')
  if [[ -z "$key" ]]; then
    single=$(printf '%s' "$master_config" | curl --silent --show-error --fail \
      --config - "$url/keys/$uid")
    key=$(printf '%s' "$single" | jq -r '.key // empty')
  fi
  [[ -n "$key" ]] || {
    echo 'ERROR: Meilisearch Keys API did not return the search-only key' >&2
    return 1
  }

  search_config=$(printf 'header = "Authorization: Bearer %s"\n' "$key")
  search_status=$(printf '%s' "$search_config" | curl --silent --show-error \
    --config - --output /dev/null --write-out '%{http_code}' --request POST \
    --header 'Content-Type: application/json' --data '{"queries":[]}' \
    "$url/multi-search")
  keys_admin_status=$(printf '%s' "$search_config" | curl --silent --show-error \
    --config - --output /dev/null --write-out '%{http_code}' "$url/keys")
  [[ "$search_status" == '200' ]] || {
    echo "ERROR: Meilisearch search-only check returned HTTP $search_status" >&2
    return 1
  }
  [[ "$keys_admin_status" == '403' ]] || {
    echo "ERROR: Meilisearch search-only keys-admin denial returned HTTP $keys_admin_status" >&2
    return 1
  }

  printf '%s' "$key"
}

MK=$(meili_search_key "$MEILI_MASTER" "http://$MEILI_HOST:$MEILI_PORT")
unset MEILI_MASTER

clickhouse_readonly_check() {
  local user=$1 password=$2 url=$3 database=$4
  local basic_auth curl_config result expected

  # A base64 Basic header keeps the password out of argv and the terminal.
  basic_auth=$(printf '%s:%s' "$user" "$password" | base64 | tr -d '\n')
  curl_config=$(printf 'header = "Authorization: Basic %s"\n' "$basic_auth")
  result=$(printf '%s' "$curl_config" | curl --silent --show-error --fail \
    --config - --data-binary \
    "SELECT currentDatabase(), currentUser(), getSetting('readonly') FORMAT TabSeparated" \
    "$url/?database=$database")
  expected="$database"$'\t'"$user"$'\t1'
  [[ "$result" == "$expected" ]] || {
    echo "ERROR: ClickHouse endpoint did not confirm database/user/read-only mode" >&2
    return 1
  }
}

clickhouse_readonly_check "$CH_USER" "$CHP" \
  "http://$CH_HOST:$CH_PORT" "$CH_DATABASE"

# URL-encode user/password for the DATABASE_URL (password may contain +,/,= etc.)
enc() { URLENC_IN="$1" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["URLENC_IN"],safe=""))'; }
UENC="$(enc "$U")"; PENC="$(enc "$P")"

mkdir -p "$(dirname "$OUT")"
umask 077
printf '%s\n' "$OS_CA" > "$OUT_OS_CA"
chmod 600 "$OUT_OS_CA"
cat > "$OUT" <<EOF
# GENERATED by scripts/redesign/gen-prod-env.sh — DO NOT COMMIT.
# Chronos transparenta_prod over private Tailscale ingress (read-only serving).
PROD_DATABASE_URL=postgresql://$UENC:$PENC@$DB_HOST:$DB_PORT/transparenta_prod?sslmode=require
PROD_MEILI_HOST=http://$MEILI_HOST:$MEILI_PORT
PROD_MEILI_API_KEY=$MK
PROD_OPENSEARCH_URL=https://$OS_HOST:$OS_PORT
PROD_OPENSEARCH_USERNAME=$OSU
PROD_OPENSEARCH_PASSWORD=$OSP
PROD_OPENSEARCH_CA_FILE=$OUT_OS_CA
PROD_OPENSEARCH_TLS_SERVERNAME=$OS_TLS_SERVERNAME
PROD_CLICKHOUSE_URL=http://$CH_HOST:$CH_PORT
PROD_CLICKHOUSE_DATABASE=$CH_DATABASE
PROD_CLICKHOUSE_USER=$CH_USER
PROD_CLICKHOUSE_PASSWORD=$CHP
# Mounts the redesign GraphQL/MCP surface on the legacy port when this env is
# loaded by \`pnpm dev\`. Dev-only — deployed legacy servers never load this file.
REDESIGN_SURFACE_ENABLED=true
EOF
chmod 600 "$OUT"
unset CHP

# libpq PG* vars for psql tooling — SEPARATE file (never loaded by the app).
cat > "$OUT_PSQL" <<EOF
# GENERATED by scripts/redesign/gen-prod-env.sh — DO NOT COMMIT.
# libpq vars for psql into Chronos prod. Source ONLY for tooling, never the app:
#   set -a; source .claude/redesign-psql.env; set +a; psql -c 'select 1'
PGHOST=$DB_HOST
PGPORT=$DB_PORT
PGDATABASE=transparenta_prod
PGUSER=$U
PGPASSWORD=$P
PGSSLMODE=require
EOF
chmod 600 "$OUT_PSQL"

echo "wrote $OUT, $OUT_PSQL, and $OUT_OS_CA"
echo "app keys:  $(grep -v '^#' "$OUT" | sed -E 's/=.*//' | tr '\n' ' ')"
echo "psql keys: $(grep -v '^#' "$OUT_PSQL" | sed -E 's/=.*//' | tr '\n' ' ')"
