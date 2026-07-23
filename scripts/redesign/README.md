# Redesign dev scaffolding (team / worktrees / Chronos serving access)

Reproducible setup for the module-per-source server redesign. The server reads the
**live read-only `transparenta_prod`** DB + prod Meili/OpenSearch in the
**`transparenta-eu-etl-prod`** namespace (the `transparenta-unified` sandbox is
deprecated and NOT used), reached directly through private Chronos Tailscale
ingress. Redis remains the Phoenix development service and is not exposed from
Chronos.

## One-time / per-session

```bash
# 1. Phoenix-only development forwards (idempotent; tmux 'dev-db-forward')
scripts/redesign/tunnels.sh

# 2. generate guarded Chronos connection files (secret-safe; mode 0600)
scripts/redesign/gen-prod-env.sh
```

The generator first runs the fail-closed Chronos target guard against an
explicit kubeconfig/context, then reads the DB, Meili master, OpenSearch
reader, OpenSearch CA, and ClickHouse read-only Secrets without printing their
values. The Meili master key is used only in process memory to discover the
single built-in key
whose immutable contract is `actions=["search"]`, `indexes=["*"]`, and no
expiry. The generator proves that key can call multi-search and receives HTTP
403 from the keys-admin API, then writes only the search-only key to the local
application environment. It defaults to:

- `chronos-prod-postgres.basa-discus.ts.net:5432`;
- `chronos-prod-meilisearch.basa-discus.ts.net:7700`;
- `chronos-prod-opensearch.basa-discus.ts.net:9200` over authenticated HTTPS;
- `chronos-prod-clickhouse.basa-discus.ts.net:8123` as the `readonly` user.

The generator also proves that ClickHouse reports database `proto`, user
`readonly`, and read-only mode before writing its four `PROD_CLICKHOUSE_*`
variables. No production serving service needs a local port-forward.

It writes `.claude/redesign-prod.env`, `.claude/redesign-psql.env`, and
`.claude/chronos-opensearch-ca.pem`, all gitignored and mode `0600`.

## One port for both surfaces (unified dev server)

The legacy API (`pnpm dev`, `/graphql`, phoenix-dev) and the redesign API
(`/api/v1/graphql`, Chronos prod — parliament, companies, pnrr, …) historically
ran as two processes on two ports. To let the client use a **single origin**,
`pnpm dev` now also mounts the redesign surface on its own port when the redesign
env is present:

- `pnpm dev` loads `.env` **and** (if present) `.claude/redesign-prod.env`, which
  sets `REDESIGN_SURFACE_ENABLED=true`. The legacy server then serves both
  `/graphql` (legacy/phoenix) and `/api/v1/graphql` + `/api/v1/mcp` +
  `/api/v1/health` (redesign/Chronos) on the **same port**.
- Bring up Phoenix forwards (`pnpm dev:forward`) and generate the Chronos prod
  env before starting the combined server.
- **Deploy-safe:** the mount is gated on `REDESIGN_SURFACE_ENABLED` (default
  **off**). Deployed legacy servers never load `redesign-prod.env`, so the flag
  stays unset, the kernel is never built, and `/api/v1/*` is never registered —
  behavior is identical to before. If the flag is on but the redesign env is
  missing/invalid, the server logs a warning and starts legacy-only.
- `pnpm dev:redesign` still runs the redesign surface standalone (Chronos-only)
  if you want it isolated.

## Phoenix development forwards — `scripts/dev-db-forward.sh`

Production services do not use local forwards. The compatibility
`scripts/redesign/tunnels.sh` launcher starts this Phoenix-only supervisor for
the legacy development database and Redis dependencies:

```bash
pnpm dev:forward          # launch all forwards, detached in tmux 'dev-db-forward'
pnpm dev:forward:status   # show which forward ports are listening
pnpm dev:forward:stop     # tear the tmux session down
```

| Local port | Source (cluster · ns · service)                   | Consumed by (env)                       |
| ---------- | ------------------------------------------------- | --------------------------------------- |
| `5432`     | phoenix · `hack-for-facts-dev` · `postgres-db-rw` | legacy `BUDGET_DATABASE_URL`            |
| `5433`     | phoenix · … · `postgres-userdata-rw`              | legacy `USER_DATABASE_URL`              |
| `5434`     | phoenix · … · `postgres-ins-rw`                   | legacy `INS_DATABASE_URL`               |
| `16379`    | phoenix · … · `redis`                             | legacy `REDIS_URL` / `BULLMQ_REDIS_URL` |

Each Phoenix forward self-reconnects (~4s) if kubectl drops. It needs the
Phoenix kubeconfig and Tailscale. Override via `PHOENIX_KUBECONFIG` and
`PHOENIX_NS`.

## Per module (the team)

```bash
# create + bootstrap a module worktree off redesign/base, on its own PORT
scripts/redesign/bootstrap-worktree.sh <module> <port>
# e.g.
scripts/redesign/bootstrap-worktree.sh pnrr 3017
```

Each module-orchestrator agent works in `.claude/worktrees/redesign-<module>`
(branch `feat/redesign-<module>`), runs `pnpm dev` on its `PORT`, runs golden/data
tests against the live tunneled prod DB, and commits to its branch. The GM merges
each module into `redesign/base`, which integrates to `dev` at milestones.

## Secrets

- `.claude/redesign-prod.env`, `.claude/redesign-psql.env`, the private CA PEM,
  and every worktree `.env` are gitignored. Credentials are fetched from
  Chronos with the guarded explicit context and never printed. Propagate with
  `cp`, never by parsing.
- Private MagicDNS names and port numbers are not secrets.

## Models (per module agent)

- **Opus** (the orchestrator + Claude sub-agents): interface design + implementation + decisions.
- **Codex** `gpt-5.5` xhigh (`codex exec`): test design/implementation + double-check.
- **OpenCode/GLM 5.2** (`opencode run`) + Codex in parallel: review, adversarial review, brainstorming.
