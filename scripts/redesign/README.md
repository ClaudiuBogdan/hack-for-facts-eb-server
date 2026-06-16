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
