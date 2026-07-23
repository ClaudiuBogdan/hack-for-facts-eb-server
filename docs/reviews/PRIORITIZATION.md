# Prioritization — what's _actually_ important, and when to fix it

Companion to [`README.md`](README.md). This ranks the findings by **importance × relevance**, where relevance is grounded in what is _actually enabled in production_, not just raw severity.

## The key reframing: this PR ships code behind OFF-by-default flags

Prod (`argocd/applications/prod.yaml`) runs **`main`** from `k8s/overlays/prod`. Per the committed prod secrets/manifests:

| Flag                            | Prod value                   | Consequence                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDESIGN_SURFACE_ENABLED`      | **unset → false**            | The **entire redesign kernel is dormant** — `/api/v1/graphql`, `/api/v1/mcp`, the agent, and every reviewed data module (parliament, procurement, judicial, budget, companies, kernel filters, search) are **not mounted**. Confirmed: `build-app.ts` registers none of these; they live only in `build-redesign-app`. |
| `USER_DATA_STORE_ENABLED`       | **unset → false**            | User Data Store not built; no store rows exist → nothing to erase.                                                                                                                                                                                                                                                     |
| `NOTIFICATION_PLATFORM_ENABLED` | **unset → false**            | Platform sends no emails → no `resend_wh_emails` rows via the platform path.                                                                                                                                                                                                                                           |
| `MCP_ENABLED`                   | **`true`**                   | The **legacy** `/mcp` surface is live.                                                                                                                                                                                                                                                                                 |
| `MCP_AUTH_REQUIRED`             | **`false`**                  | …and it is **public/unauthenticated** in prod.                                                                                                                                                                                                                                                                         |
| `TRUST_PROXY`                   | unset → **true**             | `request.ip` is client-spoofable (both servers).                                                                                                                                                                                                                                                                       |
| `ALLOWED_ORIGINS`               | exact `transparenta.eu` only | **No wildcards** → the CORS finding (A1-F1) does not apply in prod.                                                                                                                                                                                                                                                    |

**So almost nothing in this branch is exploitable in prod today** — it ships disabled. The right question is not "how severe?" but **"which flag turns it on, and what must be fixed before that flip."** Priority follows the activation gates.

> ⚠️ _These states are read from the committed manifests at this checkout; confirm against the live cluster before relying on them._

---

## Priority tiers

### P0 — Live in prod **right now** (fix independent of the merge)

| ID                                                                  | Why it's live                                                                                                                                                                                            | Importance                                                | Effort |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| [H4](issues/H4-trustproxy-ratelimit-bypass.md) — `trustProxy: true` | The legacy `/mcp` is **public** (`MCP_AUTH_REQUIRED=false`) and its only abuse control is an IP-keyed rate-limiter that `trustProxy:true` makes **spoofable**. Also makes logged `request.ip` forgeable. | **High relevance** — the one genuinely live abuse surface | **S**  |

> **Ops decision worth surfacing here:** `MCP_AUTH_REQUIRED=false` making `/mcp` public is the _bigger_ lever than the proxy bug. If public MCP is intended, H4 must be fixed; if not, flipping auth back on is a one-line config change that also blunts H4. **This is your call, not a code fix.**

### P1 — Blocks flipping `REDESIGN_SURFACE_ENABLED` (the headline capability this branch ships)

The moment this flag flips, the whole kernel becomes a **public, unauthenticated** surface. Fix before flip:

| ID                                                                                               | Sev            | Importance                                                          | Effort |
| ------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------- | ------ |
| [H3](issues/H3-mcp-unthrottled.md) unthrottled MCP + pool starvation                             | High           | **Top** — single client can DoS the DB via `get_entity_snapshot`    | S      |
| [H4](issues/H4-trustproxy-ratelimit-bypass.md) (also required here)                              | High           | Any IP-key defense is void without it                               | S      |
| [M-A6M4](issues/M-A6M4-da-selectivity-gate-mismatch.md) DA gate mismatch                         | Med→High w/ H3 | Slow-scan DoS path through MCP                                      | S      |
| [M-A6M3](issues/M-A6M3-region-canonicalization-regression.md) region regression                  | Med            | Silent wrong "no data" answers on served data                       | S      |
| [H5](issues/H5-judicial-leak-audit-blindspot.md) judicial audit blind spot                       | High (latent)  | This is the moment judicial data goes public; close the guard first | S      |
| [M-A5M2](issues/M-A5M2-fallback-search-missing-pins.md) fallback search pins                     | Med (dormant)  | Delete dead method or pin, before a future wiring leaks             | S      |
| [M-A2M1](issues/M-A2M1-quota-reconcile-overcharge.md) quota reconcile                            | Med            | Agent mounts with the kernel; user lockout                          | S      |
| [M-A2M2](issues/M-A2M2-kernel-tools-agent-exposure.md) kernel-tool exposure                      | Med (latent)   | Add the `agentSafe` guard-rail before the tool set grows            | S      |
| [M-A5M1](issues/M-A5M1-array-contains-empty-guard.md) `contains:[]` 500                          | Low            | Cheap robustness fix                                                | S      |
| [M-A4-3](issues/M-A4-3-rolenormalized-leak.md), [M-A4-2](issues/M-A4-2-missing-runtime-audit.md) | Med            | Judicial privacy hardening — bundle with H5                         | S–M    |

### P2 — Blocks flipping `USER_DATA_STORE_ENABLED` (GDPR, irreversible exposure)

| ID                                                                          | Sev  | Importance                                                   | Effort |
| --------------------------------------------------------------------------- | ---- | ------------------------------------------------------------ | ------ |
| [H2](issues/H2-erasure-false-success-audit.md) false-success erasure audit  | High | Compliance: reports deletion done while data survives        | S      |
| [M-A3F2](issues/M-A3F2-logical-key-unerasable.md) `logical_key` un-erasable | Med  | Fix _before_ real PII is written — post-hoc it's un-erasable | M      |

### P3 — Blocks flipping `NOTIFICATION_PLATFORM_ENABLED` (GDPR)

| ID                                                                              | Sev  | Importance                                                      | Effort |
| ------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- | ------ |
| [H1](issues/H1-erasure-resend-wh-emails.md) platform-email PII survives erasure | High | Compliance; the green e2e hides it — add the platform-path test | S      |
| [M-B3F2](issues/M-B3F2-shared-retention-coupling.md) shared retention delete    | Med  | Data-loss on the shared table                                   | M      |

### P4 — Codebase health / correctness (do soon; not gated by a prod flip)

| ID                                                                              | Sev                | Note                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [H6](issues/H6-infra-boundary-violation.md) ESLint boundaries inert             | High (enforcement) | **No runtime exploit**, but the repo's advertised architecture guarantees are currently unenforced, masking 2 runtime `core→kysely` violations. Fixing re-arms CI (goes red → fix the masked violations together). Do before more code piles on the broken guarantee. |
| [M-B2F1](issues/M-B2F1-parliament-unstable-pagination.md) parliament pagination | Med                | Correctness on the redesign parliament surface (dormant with P1). If any of these lists is _also_ exposed on the live legacy GraphQL, it rises to P0-correctness — **worth confirming**.                                                                              |
| [M-B4-2](issues/M-B4-2-budget-mcp-float-money.md) budget float money            | Med                | Redesign-gated (P1-adjacent); cheap correctness fix.                                                                                                                                                                                                                  |
| [M-B1F1](issues/M-B1F1-series-counts-double-count.md) series metadata           | Low–Med            | Envelope-metadata only; redesign-gated.                                                                                                                                                                                                                               |
| [M-B4-3](issues/M-B4-3-companies-kernel-shell-import.md) deep imports           | Low                | Fold into the H6 ESLint-rule fix.                                                                                                                                                                                                                                     |

### Refuted / non-issues in prod

- [M-A1F1](issues/M-A1F1-cors-vercel-credentials.md) CORS `*.vercel.app` — **does not apply**: prod `ALLOWED_ORIGINS` has no wildcards. Keep the `*`→`[^.]*` hardening as cheap defense-in-depth only.

---

## Recommended sequencing

1. **Now (P0):** Decide `MCP_AUTH_REQUIRED` (keep `/mcp` public or not) and ship the `trustProxy` fix (H4). One small PR, independent of the merge.
2. **Merge the branch** — it's dormant behind flags, so merging is low-risk _as long as the flags stay off_. Land H6's ESLint re-arm around the same time so new code can't add boundary violations.
3. **Before flipping `REDESIGN_SURFACE_ENABLED`:** the P1 bundle — the MCP-abuse trio (H3 + H4 + M-A6M4) as one PR, plus the judicial guard (H5 + M-A4-2/3) and the smaller kernel/agent fixes.
4. **Before flipping `USER_DATA_STORE_ENABLED`:** the P2 GDPR pass (H2 + M-A3F2).
5. **Before flipping `NOTIFICATION_PLATFORM_ENABLED`:** the P3 GDPR pass (H1 + M-B3F2).

## The two calls that are yours (not code fixes)

1. **Is `/mcp` meant to be public in prod (`MCP_AUTH_REQUIRED=false`)?** If not, that config flip is the highest-leverage, lowest-effort mitigation and reduces H3/H4 urgency.
2. **What's your flag-flip roadmap?** If the redesign surface / user-data store / notification platform won't be enabled soon, their blockers are "fix before enable," not "fix before merge" — you can merge now and fix in sequence.

## One behavioral fact to remember when you do flip redesign on

Procurement **spend answers are all `null`** right now (gate abstains at .539/.762/.678 coverage). Not a bug — but don't mistake it for one after enabling the surface.
