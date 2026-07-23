# `dev` → `main` Review — Navigation Hub

Security-first review of the **138 commits on `dev` not in `main`** (~90k lines, ~20 modules), 2026-07-15.
This hub is the **entry point**. Read top-down: skim the tables here, then open only the issue file(s) you care about — each is self-contained.

> 👉 **For "what should I actually fix and when," read [`PRIORITIZATION.md`](PRIORITIZATION.md)** — it ranks everything by importance × real prod relevance (most of this ships behind OFF-by-default flags, so priority follows the flag-flip gates, not raw severity).

```
docs/reviews/
├── README.md                        ← you are here (index + triage)
├── DEV-TO-MAIN-REVIEW-2026-07-15.md ← the full narrative report (exec summary + all findings + "what's solid")
└── issues/                          ← one self-contained deep-dive file per issue (verified, with fixes)
    ├── _TEMPLATE.md
    ├── H1..H6-*.md                  ← High findings (dedicated deep-dive each)
    └── M-*.md                       ← Medium/Low findings (grouped investigation)
```

**How the review was run:** 3 surface-mapping passes → 10 parallel domain review agents → 10 parallel per-issue deep-dive agents. Every High was re-verified against current code. **Baseline: branch is green** (typecheck ✓, lint ✓, 4494 tests pass). _Read-only — no source was changed._

---

## Merge-blocker board (fix before merge)

| ID                                                      | Sev (deep-dived)                | Issue                                                                                                                                                              | Blocker               | Fix |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | --- |
| [H1](issues/H1-erasure-resend-wh-emails.md)             | **High**                        | GDPR: deleted user's email+subject survive in `resend_wh_emails` for platform emails (≤90d). Green e2e _proves_ the blind spot.                                    | **Yes**               | S   |
| [H2](issues/H2-erasure-false-success-audit.md)          | **High** (Crit when rows exist) | Erasure writes "completed" audit + admin email while skipping the store — and the flag is **off by default**, no self-heal.                                        | **Yes**               | S   |
| [H3](issues/H3-mcp-unthrottled.md)                      | **High**                        | Public `/api/v1/mcp` unthrottled; `get_entity_snapshot` holds ~5-6 pool conns ~7s → single client starves the pool.                                                | **Yes** (standalone)  | S   |
| [H4](issues/H4-trustproxy-ratelimit-bypass.md)          | **High**                        | `trustProxy: true` (prod, both servers) → spoofable `X-Forwarded-For` defeats all 4 IP-keyed limiters; audit IP forgeable. Edge doesn't mitigate.                  | **Yes**               | S   |
| [H6](issues/H6-infra-boundary-violation.md)             | **High** (enforcement)          | The ESLint `boundaries` rule **enforces nothing** (resolver misconfig) — masking 2 _runtime_ `core→kysely` violations. Plus the `infra→notifications/core` import. | **Yes** (enforcement) | M   |
| [M-A6M4](issues/M-A6M4-da-selectivity-gate-mismatch.md) | High _composed with H3_         | Cursor DA gate accepts `cpvDivision`/`uniqueCode` the offset gate rejects (16.6s scans) → pool-exhaustion DoS via MCP.                                             | With H3/H4            | S   |

> **H5 is a High but _not_ a hard blocker** — see below (latent, no live leak). **A1-F1 (CORS) was refuted** → Low. Triage all in the next tables.

---

## All findings by severity (post-deep-dive)

Severity column = the **verified** verdict (⬆ raised / ⬇ lowered / = unchanged / ✗ refuted vs the first-pass report).

### High

| ID                                               | Verdict                   | One-line                                                                                           | Blocker          |
| ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| [H1](issues/H1-erasure-resend-wh-emails.md)      | High =                    | Platform-email PII survives erasure (≤90d); reachable pre-TTL via evidence-lookup + campaign stats | Yes              |
| [H2](issues/H2-erasure-false-success-audit.md)   | High = (Crit conditional) | False "erasure completed" audit+email when store flag off (default); no self-heal                  | Yes              |
| [H3](issues/H3-mcp-unthrottled.md)               | High =                    | Unthrottled public MCP; connection-pool starvation via `get_entity_snapshot`                       | Yes / owner-call |
| [H4](issues/H4-trustproxy-ratelimit-bypass.md)   | High =                    | `trustProxy:true` → XFF spoof defeats every IP-keyed control                                       | Yes              |
| [H5](issues/H5-judicial-leak-audit-blindspot.md) | High = (**latent**)       | Leak-audit blind to fluent `.select()`; worst case an unvetted _company_ name (no person PII)      | Owner-call       |
| [H6](issues/H6-infra-boundary-violation.md)      | ⬆ High (enforcement)      | ESLint boundaries inert repo-wide + `infra→core` import + 2 masked runtime `core→kysely`           | Yes              |

### Medium

| ID                                                            | Verdict            | Domain        | One-line                                                                                   |
| ------------------------------------------------------------- | ------------------ | ------------- | ------------------------------------------------------------------------------------------ |
| [M-A6M4](issues/M-A6M4-da-selectivity-gate-mismatch.md)       | Med = (High w/ H3) | procurement   | Cursor DA gate weaker than offset gate → slow-scan DoS                                     |
| [M-A6M3](issues/M-A6M3-region-canonicalization-regression.md) | Med =              | procurement   | `buyerRegion` lost its allowlist/fold → silent empty "served" answers                      |
| [M-A3F2](issues/M-A3F2-logical-key-unerasable.md)             | Med =              | erasure       | `logical_key`/`target_id` un-erasable; `learning.progress` free-form key is the PII vector |
| [M-A4-3](issues/M-A4-3-rolenormalized-leak.md)                | Med =              | privacy       | `roleNormalized` surfaced for name-withheld persons, no vocab allowlist                    |
| [M-A4-2](issues/M-A4-2-missing-runtime-audit.md)              | Med =              | privacy       | Advertised judicial "runtime SQL-log audit" doesn't exist (H5's missing layer-2)           |
| [M-B3F2](issues/M-B3F2-shared-retention-coupling.md)          | Med =              | notifications | Retention worker blanket-deletes the _shared_ `resend_wh_emails` (no NOT-EXISTS guard)     |
| [M-A5M2](issues/M-A5M2-fallback-search-missing-pins.md)       | Med =              | search        | Dormant `fallbackTextSearch` missing `public`/`deleted_at` pins; e2e asserts it leaks      |
| [M-A2M1](issues/M-A2M1-quota-reconcile-overcharge.md)         | Med =              | agent         | Quota reconcile has no retry → transient Redis error locks user out until UTC midnight     |
| [M-A2M2](issues/M-A2M2-kernel-tools-agent-exposure.md)        | Med = (latent)     | agent         | All 76 kernel tools auto-exposed to agent; first mutating tool would bypass ownership      |
| [M-B2F1](issues/M-B2F1-parliament-unstable-pagination.md)     | Med =              | correctness   | Member speeches/control-items offset pagination lacks a unique tiebreak → skip/dupe        |
| [M-B4-2](issues/M-B4-2-budget-mcp-float-money.md)             | Med =              | correctness   | Budget MCP aggregate sums money as JS float (only money float-sum in any tool)             |

### Low / refuted-down

| ID                                                       | Verdict   | One-line                                                                                                                  |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| [M-A1F1](issues/M-A1F1-cors-vercel-credentials.md)       | ✗⬇ Low    | CORS `*.vercel.app`+credentials **refuted**: prod/dev origins have zero wildcards (glob is a malformed local `.env` only) |
| [M-A5M1](issues/M-A5M1-array-contains-empty-guard.md)    | ⬇ Low     | `contains:[]` is a 500, **not** row-widening — availability nit over public data                                          |
| [M-B1F1](issues/M-B1F1-series-counts-double-count.md)    | ⬇ Low–Med | `procurementSeries` counts.rows double-counts the undated bucket (envelope metadata only)                                 |
| [M-B4-3](issues/M-B4-3-companies-kernel-shell-import.md) | ⬇ Low     | 3 deep-imports of `shared/shell/repo/fold.js` (companies×2 + parliament); encapsulation nit                               |

Low/Nits without a dedicated file (env-gate on standalone, double-auth on agent routes, mount/bypass duplication, `startsWith` boundary, conversation-id oracle, control_type enum, MO `toRelation`, unsubscribe-token expiry, dead budget helpers, doc drift) are listed in [the main report §2 Low/Nit](DEV-TO-MAIN-REVIEW-2026-07-15.md).

---

## Cross-cutting themes (fix these together)

- **Erasure completeness** — [H1](issues/H1-erasure-resend-wh-emails.md) + [H2](issues/H2-erasure-false-success-audit.md) + [M-A3F2](issues/M-A3F2-logical-key-unerasable.md) + [M-B3F2](issues/M-B3F2-shared-retention-coupling.md) all touch the delete path. Fix as one GDPR hardening pass; add e2e rows keyed on the _platform_ path (H1's suite is green with the bug live).
- **Public MCP abuse surface** — [H3](issues/H3-mcp-unthrottled.md) + [H4](issues/H4-trustproxy-ratelimit-bypass.md) + [M-A6M4](issues/M-A6M4-da-selectivity-gate-mismatch.md) compound into a pool-exhaustion DoS. The rate-limiter and the `trustProxy` fix **must land together** or the IP key stays spoofable.
- **Judicial name-gating durability** — [H5](issues/H5-judicial-leak-audit-blindspot.md) + [M-A4-2](issues/M-A4-2-missing-runtime-audit.md) + [M-A4-3](issues/M-A4-3-rolenormalized-leak.md): the "defense by convention" model has audit gaps. Removing `display_name` from the table type + adding the runtime audit closes two at once.
- **Architecture enforcement** — [H6](issues/H6-infra-boundary-violation.md): re-arm the ESLint resolver, then fix the runtime `core→kysely` violations it was hiding. Also fixes [M-B4-3](issues/M-B4-3-companies-kernel-shell-import.md)'s class.

## Behavioral fact (not a defect)

The procurement **spend gate currently abstains on all grains** (value coverage .539/.762/.678) → every money answer on the analysis surface is `null` right now. Expected by design; flagged for API consumers. See [main report §1](DEV-TO-MAIN-REVIEW-2026-07-15.md).

---

_Every issue file follows [`issues/_TEMPLATE.md`](issues/_TEMPLATE.md): verdict table · evidence (file:line) · root cause · blast radius · reproduction · additional context · fix options · related links. Fix-effort sizing (S/M) is per-issue._
