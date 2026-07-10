# Redesign dev scaffolding (team / worktrees / Griffin access)

Reproducible setup for the module-per-source server redesign. The server reads the
**live read-only `transparenta_prod`** DB + prod Meili/OpenSearch in the
**`transparenta-eu-etl-prod`** namespace (the `transparenta-unified` sandbox is
deprecated and NOT used), reached over SSH tunnels to griffin.

## One-time / per-session

```bash
# 1. shared tunnels to prod-namespace services (idempotent; tmux 'redesign-tunnels')
scripts/redesign/tunnels.sh

# 2. generate the prod connection env (secret-safe; writes .claude/redesign-prod.env)
scripts/redesign/gen-prod-env.sh
```

Local tunnel ports: DB `55432`, Meili `57700`, OpenSearch `59200`, Redis `56379`.

## One port for both surfaces (unified dev server)

The legacy API (`pnpm dev`, `/graphql`, phoenix-dev) and the redesign API
(`/api/v1/graphql`, griffin-prod — parliament, companies, pnrr, …) historically
ran as two processes on two ports. To let the client use a **single origin**,
`pnpm dev` now also mounts the redesign surface on its own port when the redesign
env is present:

- `pnpm dev` loads `.env` **and** (if present) `.claude/redesign-prod.env`, which
  sets `REDESIGN_SURFACE_ENABLED=true`. The legacy server then serves both
  `/graphql` (legacy/phoenix) and `/api/v1/graphql` + `/api/v1/mcp` +
  `/api/v1/health` (redesign/griffin) on the **same port**.
- Bring up all DB forwards first (`pnpm dev:forward`) so both phoenix-dev and
  griffin-prod are reachable.
- **Deploy-safe:** the mount is gated on `REDESIGN_SURFACE_ENABLED` (default
  **off**). Deployed legacy servers never load `redesign-prod.env`, so the flag
  stays unset, the kernel is never built, and `/api/v1/*` is never registered —
  behavior is identical to before. If the flag is on but the redesign env is
  missing/invalid, the server logs a warning and starts legacy-only.
- `pnpm dev:redesign` still runs the redesign surface standalone (griffin-only)
  if you want it isolated.

## All-in-one DB forwards (both servers) — `scripts/dev-db-forward.sh`

`scripts/redesign/tunnels.sh` above forwards only the **griffin prod** services over
SSH (for the redesign server). When you also want the **legacy** server
(`pnpm dev`, port 3001) and/or prefer kubectl-over-Tailscale to SSH, use the
combined forwarder, which brings up everything both servers need with per-port
auto-reconnect:

```bash
pnpm dev:forward          # launch all forwards, detached in tmux 'dev-db-forward'
pnpm dev:forward:status   # show which forward ports are listening
pnpm dev:forward:stop     # tear the tmux session down
```

| Local port | Source (cluster · ns · service)                       | Consumed by (env)                       |
| ---------- | ----------------------------------------------------- | --------------------------------------- |
| `55432`    | griffin · `transparenta-eu-etl-prod` · `…postgres-rw` | redesign `PROD_DATABASE_URL`            |
| `57700`    | griffin · … · `…meilisearch`                          | redesign `PROD_MEILI_HOST`              |
| `59200`    | griffin · … · `…opensearch`                           | redesign `PROD_OPENSEARCH_URL`          |
| `5432`     | phoenix · `hack-for-facts-dev` · `postgres-db-rw`     | legacy `BUDGET_DATABASE_URL`            |
| `5433`     | phoenix · … · `postgres-userdata-rw`                  | legacy `USER_DATABASE_URL`              |
| `5434`     | phoenix · … · `postgres-ins-rw`                       | legacy `INS_DATABASE_URL`               |
| `16379`    | phoenix · … · `redis`                                 | legacy `REDIS_URL` / `BULLMQ_REDIS_URL` |

Each forward self-reconnects (~4s) if kubectl drops. **Caveat:** the redesign
server crashes if its DB tunnel _hard_-drops and `tsx watch` does not restart it —
relaunch `pnpm dev:redesign` after a hard drop. The legacy server tolerates a blip.
Needs both kubeconfigs (`~/.kube/griffin.yaml`, `~/.kube/phoenix.yaml`) and
Tailscale up. Override paths/namespaces via `GRIFFIN_KUBECONFIG`, `PHOENIX_KUBECONFIG`,
`GRIFFIN_NS`, `PHOENIX_NS` env vars.

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

- `.claude/redesign-prod.env` and every worktree `.env` are gitignored. Credentials
  are fetched on griffin and written via redirect — never printed. Propagate with
  `cp`, never by parsing.
- Port numbers (`localhost:NNNN`) are not secrets.

## Models (per module agent)

- **Opus** (the orchestrator + Claude sub-agents): interface design + implementation + decisions.
- **Codex** `gpt-5.5` xhigh (`codex exec`): test design/implementation + double-check.
- **OpenCode/GLM 5.2** (`opencode run`) + Codex in parallel: review, adversarial review, brainstorming.
