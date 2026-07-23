# Review: `dev` → `main` — 2026-07-15

> **Start at [`README.md`](README.md)** — the navigation hub with the merge-blocker board and per-issue deep-dive files (`issues/`). Every finding below was subsequently re-verified by a dedicated deep-dive agent; **post-verification revisions:** A1-F1 CORS **refuted → Low** (prod origins have no wildcards); A5-M1 → Low (500, not widening); B4-#3 → Low; B1-F1 → Low–Med; **H6 escalated** (the ESLint boundary rule is inert repo-wide, masking runtime `core→kysely` violations); H2 strengthened (store flag is off by default); H5 nuanced (latent; worst case a company name, not person PII). This document is the original first-pass narrative; the hub carries the authoritative verdicts.

Full security-first review of the **138 commits on `dev` not yet in `main`** (~90k added lines across ~20 modules: redesign kernel, AI agent, notification platform, GDPR user-data store + Clerk erasure, INS requests, judicial privacy surface, parliament/procurement/budget/companies).

**Method:** 3 surface-mapping passes + 10 parallel read-only review agents (6 security-domain, 4 code/design/docs), then a synthesis pass that deduped and re-confirmed every High finding against current code. No files were changed.

**Baseline (branch is green):** `pnpm typecheck` ✓ · `pnpm lint` ✓ (zero warnings) · `pnpm test` ✓ — **4494 passed / 190 skipped, 392 test files**.

---

## 1. Executive summary & risk verdict

The branch is **high quality and defense-minded**. The hardest security surfaces — SQL/filter injection, agent tenant isolation, GraphQL query guards, erasure idempotency, judicial name-gating on the happy path — are genuinely well-built and well-tested. **No exploitable auth bypass, no injection, no cross-tenant read** was found. Several seeded concerns were actively **refuted** (auth bypass is fail-safe; the `audit_events` empty-array bug is fixed; the procurement "F1 verdict-flip time-bomb" is neutralized on the new surface).

The real risk concentrates in **two GDPR erasure gaps** and **availability/abuse of the public MCP surface**.

### Merge-blocker candidates (recommend fixing before merge)

| #   | Severity | Finding                                                                                                                                                                     | Confidence                   |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| H1  | **High** | GDPR erasure miss — deleted user's raw email + subject survive in `resend_wh_emails` for platform-sent emails (up to 90 days)                                               | CONFIRMED                    |
| H2  | **High** | Erasure "success" audit + admin "completed" email written even when the User Data Store is never erased (config-drift path)                                                 | CONFIRMED mechanism          |
| H3  | **High** | Public `/api/v1/mcp` has no per-tool rate-limit/auth; expensive tools reachable unthrottled (no limiter at all on the standalone server)                                    | CONFIRMED                    |
| H4  | **High** | Rate-limit bypass — `trustProxy: true` makes the per-IP buckets defeatable with a spoofed `X-Forwarded-For`                                                                 | CONFIRMED                    |
| H5  | **High** | Judicial leak-audit is blind to Kysely fluent `.select()` args; `display_name` is declared on the table type, so a future fluent select would leak names AND pass the audit | CONFIRMED mechanism (latent) |
| H6  | **High** | Architecture boundary violation — `infra/` imports a feature module's `core` (`notifications/core/ports`)                                                                   | CONFIRMED                    |

None is a live remote-exploit of protected data; H1/H2 are the most consequential (privacy/compliance), H3/H4 are abuse/DoS, H5 is a durability gap in a privacy guarantee, H6 is layering debt. A reasonable path is to fix H1–H4 pre-merge and schedule H5/H6 + the Mediums as fast follow-ups.

### One big behavioral fact (not a defect)

The procurement spend gate **currently ABSTAINS on all three grains** (value coverage .539/.762/.678), so **every money answer on the analysis surface is `null` right now**, regardless of scope. Expected by design, but surface owners and API consumers should know.

---

## 2. Findings by severity

### HIGH

**H1 — GDPR erasure miss: platform-email PII survives in `resend_wh_emails`** · CONFIRMED
`src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts:867-875` (id collection), `:708-730` (nulls `notification_deliveries.provider_ref`), `:543-586` (`updateResendWebhookEvents`). PII source: `resend_wh_emails.to_addresses TEXT[]` (`src/infra/database/user/schema.sql:396`).
The `resendEmailIds` set that drives redaction of `resend_wh_emails` is built **only** from `resend_email_id` columns (legacy `notificationsoutbox` + `institutionemailthreads`). It is **never** populated from `notification_deliveries.provider_ref` — yet that column is nulled in the same transaction. So for any email sent via the **new notification platform**, the `resend_wh_emails` row keeps the deleted user's raw email + real subject until the 90-day retention TTL sweeps it.
_Scenario:_ platform sends email → Resend `email.delivered` webhook stores `to_addresses=[user email]` → user deletes account → anonymizer sweeps, nulls `provider_ref`, but the webhook-email row is untouched → PII persists ≤90 days. Contradicts `docs/USER-DATA-ANONYMIZATION.md:51` which promises redaction.
_Fix:_ collect `provider_ref` from `notification_deliveries` + `notification_delivery_attempts` for the deleted user's ids **before** nulling, and feed those email_ids into `updateResendWebhookEvents`.

**H2 — Erasure audit reports success while the User Data Store is never erased** · CONFIRMED mechanism
`user-data-anonymizer.ts:1088-1095` treats `userDataStoreEraser === undefined` as `ok({records:0,events:0,receipts:0})`, then writes the SUCCESS audit row and fires the admin "erasure completed" email. The eraser is wired **only inside `if (shouldInitializeUserDataStore)`** = `config.userDataStore.enabled` (`build-app.ts:1260-1273`), but the store tables are created **unconditionally** by migration.
_Scenario:_ store enabled → user writes a `funky.interaction` record → ops flip `userDataStore.enabled=false` (rows remain) → Clerk `user.deleted` → legacy sweep runs, store eraser skipped, **audit + admin notify report SUCCESS**, but `user_data_records/events/receipts` survive with payload intact.
_Fix:_ decouple erasure capability from the write-enable flag — always wire the eraser when `userDb` exists; or, when the eraser is absent, probe for residual owner rows and fail/flag the audit instead of writing success.

**H3 — Public MCP surface has no per-tool throttle; expensive tools reachable unauthenticated** · CONFIRMED
`src/app/build-redesign-app.ts:435` (`POST /api/v1/mcp`, no auth by design, no limiter). The kernel `RateLimiter` is consulted in exactly one place — `shared/shell/graphql/resolvers.ts:100` (`searchEntities`) — and nowhere in the MCP dispatcher. Expensive tools on the surface: `get_entity_snapshot` (eager `flowsIn`+`flowsOut` over the ~19GB flow graph + a ~7s `documentCount` scan), `aggregate_procurement`, `search_procurement_direct_acquisitions`. The **standalone** `redesign-api.ts` registers **no `@fastify/rate-limit` at all**; the legacy mount has only a coarse per-request global limiter (a 7s snapshot costs the same token as `initialize`).
_Fix:_ wrap MCP tool handlers/dispatcher with the per-key `RateLimiter`; register a limiter in `buildRedesignApp`.

**H4 — Rate-limit bypass via spoofable `X-Forwarded-For`** · CONFIRMED
`build-redesign-app.ts:152` hardcodes `trustProxy: true`; `api.ts:169` defaults `config.server.trustProxy ?? true`. With boolean `true`, `proxy-addr` trusts the entire XFF chain and returns the client-claimed leftmost IP, which is the key for both the kernel `searchEntities:${ip}` limiter and `@fastify/rate-limit`. An attacker rotating `X-Forwarded-For` gets a fresh bucket per request. Fully exploitable on a directly-exposed standalone server.
_Fix:_ set `trustProxy` to the known proxy hop count / trusted CIDR, not `true`.

**H5 — Judicial leak-audit is blind to Kysely fluent `.select()` args** · CONFIRMED mechanism (latent)
`tests/unit/judicial/leak-audit.test.ts:58-59` strips **all** quoted string literals globally before checking that `display_name` appears only in the gated repo. Kysely's fluent builder passes column names as **string args**, so `.select(['k.display_name'])` is invisible to the audit. And `display_name` **is declared on the table type** (`src/modules/judicial/shell/db/schema.ts:114` — the comment itself notes it's declared "so that method can select it"), so a fluent select **compiles** (the compile-error guard only fires for columns omitted from the type: `solution`, `solution_summary`, `candidate_company_name`, `raw_text`, `span_*`).
_Scenario:_ a future `party-search-repo.ts` doing `.select(['k.name_key_id','k.display_name']).where('k.display_name','ilike',pattern)` returns raw person names with **no publishable EXISTS gate**, compiles cleanly, and **passes the leak-audit**. Both structural guards bypassed for the single most sensitive gated column. Compounded by **MED (A4-2):** the second "runtime SQL-log audit" that the comments advertise (`party-dictionary-repo.ts:13-15`) **does not exist** — the two-layer defense is really one layer.
_Fix:_ parse `.select([...])` string args into the audit residue; or remove `display_name` from the table type and force all reads through one typed helper; or actually implement the runtime SELECT-column audit.

**H6 — `infra/` imports a feature module's `core`** · CONFIRMED
`src/infra/unsubscribe/token.ts:12` (and re-export at `:14`) imports `UnsubscribeTokenSigner` from `@/modules/notifications/core/ports.js`. Per CLAUDE.md's dependency table, `infra` may import `common` only — never `core`/`shell`. This inverts the layering (infra now compile-depends on a feature). Type-only, so no runtime coupling, but it's a real ESLint-slipped boundary violation that voids the "infra knows nothing about features" guarantee.
_Fix:_ define `UnsubscribeTokenSigner` in `infra` (or `common`) and have `notifications` depend on it, or move the signer into `notifications/shell`.

### MEDIUM

- **A1-F1 — CORS `*`→`.*` glob + `credentials:true`.** `src/infra/plugins/cors.ts:33-38,149,178`; `.env` `ALLOWED_ORIGINS` includes `https://*.vercel.app`. An attacker deploying `evil-abc.vercel.app` gets its origin reflected with `Allow-Credentials: true`. Bounded (primary auth is Bearer, not cookies), but any cookie-backed surface is exposed. _Fix:_ map `*`→`[^.]*`, reject degenerate globs, never wildcard a shared platform domain with credentials.
- **A2-M1 — Quota reconcile failure over-charges the user for the rest of the UTC day.** `agent/shell/rest/routes.ts:108-136` + `quota/quota-store.ts:82-100`. A transient Redis error in `onFinish` reconcile leaves the quota key pinned at full budget → 429 until the 48h TTL. Self-heals next day. _Fix:_ bounded retry on reconcile error.
- **A2-M2 — Kernel MCP tools auto-exposed to the agent with no per-tool gate (latent).** `agent/shell/tools/kernel-tools.ts:12-24`. All 48 tools are read-only/public today (safe), but any future mutating/user-scoped tool would be handed to every authenticated agent user with no ownership check. _Fix:_ add an `agentSafe`/`readonly` marker or explicit allowlist.
- **A3-F2 — `logical_key`/`target_id` survive erasure; `logical_key` is structurally un-erasable.** `user-data/shell/repo/kysely-user-data-erasure-repo.ts:44-86` never touches them, and `logical_key` is in the append-only trigger's immutable-column list (migration `:115`). It is client-controlled free-form (e.g. `learning.progress` `^(?!internal:)\S+$`), so a client keying by email/name persists that string forever. _Fix:_ reject/hash PII-shaped `logical_key` at write time.
- **A4-MED-3 — `roleNormalized` surfaced verbatim for name-withheld persons.** `judicial/core/usecases.ts:143-150` projects `roleNormalized` for every party including withheld person rows, with no server-side vocabulary allowlist. A loader value like `role_normalized='Reprezentant legal Ion Popescu'` would surface a name for an otherwise-gated person. _Fix:_ validate `role_normalized` against the known vocab server-side (drop/null unknowns).
- **A5-MED-1 — Array `contains: []` has no empty-array guard.** `shared/core/filters/derive.ts:309-329` (vs the `in` guard at `:282`). `{tags:{contains:[]}}` is reachable (reference `tags` is a live public filter) → `pe.tags @> to_jsonb(array[])` → either match-all widening or a 500. Over public data only. _Fix:_ guard the array `contains` path with `empty → sql\`false\``.
- **A5-MED-2 — `fallbackTextSearch` missing `visibility='public'` + `deleted_at is null` pins (dormant).** `shared/shell/repo/search-repo.ts:34-69` would return restricted + soft-deleted docs of any type. No live caller today, but it's on the public `SearchRepo` port. _Fix:_ add the pins + entity allowlist, or delete the dead method.
- **A6-M3 — `buyerRegion` region canonicalization regression.** `procurement/core/analysis-scope.ts:134-149` parses `buyerRegion` via `readString` only (any string) — the deleted MCP usecase had an allowlist + NFKD-fold. `buyerRegion:'cluj'` or `'atlantis'` silently match 0 rollup rows while the envelope reports `answerability='served'` → misleading "no spend." _Fix:_ restore the allowlist + fold, reject unknowns.
- **A6-M4 — Cursor vs offset DA selectivity gates disagree.** Offset gate (`procurement/core/search.ts:179-210`) rejects standalone `cpvDivision/cpvCode/uniqueCode` (16.6s/8s scans); the cursor gate (`filter-helpers.ts:177-246`, `DA_SELECTIVE_FIELDS`) accepts them — the path MCP `search_procurement_direct_acquisitions` uses. `cpvDivision:{in:['03']}` with no date bound can keyset-walk millions of rows. Compounds H3. _Fix:_ align the cursor gate with the offset gate, or require a date window alongside standalone CPV.
- **B1-F1 — Series/distinct `counts.rows` double-counts the undated bucket under a bounded window.** `procurement/core/analysis-usecases.ts:470-475` & `:424-429` sum over every row including the `null` bucket, while `statsFor` uses `FILTER(datedPred)`. Same scope returns `counts.rows=100` from `procurementStats` but `107` from `procurementSeries` (the 7 undated counted twice). Envelope metadata only — but tri-surface agents reason over `counts.rows`. _Fix:_ sum dated rows only.
- **B2-F1 — Unstable offset pagination on member speeches & control items.** `parliament/shell/repo/parliament-repo.ts:1543` (`order by s.spoken_at desc`) and `:1519` (`order by c.item_date desc`), offset-paginated with no unique tiebreak. Ties on a shared date straddling a page boundary get skipped/duplicated. The sibling `listMemberInitiatives` (`:1954`) was explicitly fixed for exactly this ("audit bug") but the fix wasn't propagated. _Fix:_ add `.orderBy('s.speech_key','desc')` / `.orderBy('c.item_key','desc')`.
- **B3-F2 — Platform retention worker purges the shared `resend_wh_emails` table.** `notification-platform/shell/retention/apply-retention.ts:51-60` deletes all rows >90d regardless of owner; the table is also used by legacy delivery + `institutionemailthreads` for reconciliation. _Fix:_ scope the delete or move shared-table retention to a shared owner.
- **B4-#2 — Budget MCP aggregate sums money as a JS float.** `budget/shell/mcp/tools.ts:270` `acc + Number(r.amount)` → emitted as a money field at `:290`. Item-level amounts stay strings (precise); only the rolled-up total is float-summed → silent precision loss above 2^53 cents. Violates the No-Float rule + budget DESIGN.md. _Fix:_ sum with `decimal.js` / bigint.
- **B4-#3 — `companies` reaches into the shared kernel's shell internals.** `companies/shell/repo/filter-helpers.ts:20` + `companies-repo.ts:37` import `foldDiacritics` from `@/modules/shared/shell/repo/fold.js`; budget/pnrr/primarii import it from the public `@/modules/shared/index.js` (re-exported precisely "so modules don't reach into shell/repo"). Divergent one-off. _Fix:_ import from the public index.

### LOW / NIT

- **A1-F2** redesign prod-gating reads raw `process.env.NODE_ENV` (safe for `api.ts`-booted path — `parseEnv` throws on a bad value; residual risk only for a non-`api.ts` standalone entrypoint). _Fix:_ thread `config.server.isProduction` in.
- **A1-F3** double auth on `/api/v1/agent/*` (global middleware + plugin) — no double-send/bypass; invalid-token returns the legacy body shape. _Fix:_ bypass agent paths in the global hook or drop the plugin's duplicate middleware.
- **A1-F4** mount-condition (`build-app.ts:1118`) and bypass-recompute (`:1230-1231`) are duplicated byte-identical expressions — fail-safe (bypass only ever sets `ANONYMOUS_SESSION`), so divergence yields at worst a spurious 401/404, never a bypass. _Fix:_ hoist to one const.
- **A1-F5** `startsWith` allowlist entries without a trailing boundary (`build-app.ts:474-476,519`) — currently safe (subtrees independently protected / slated for removal). _Fix:_ exact-path sets or `prefix + '/'`.
- **A2-L1** conversation-id existence oracle (23505→`CONVERSATION_NOT_FOUND` vs fresh-id 200) — ~zero exploitability (high-entropy ids). **A2-L2** turn spanning UTC midnight loses reconciliation. **A2-Nit** stale comment at `prepare-chat.ts:99-101`.
- **A4-LOW-4** `resolveJudicialFilters` switch has no default → an invalid `dim` (SDL `String!`) throws a 500 via `unwrap()`. _Fix:_ default → `invalidInput`, or make `dim` an SDL enum.
- **A5-nits** `CAST_RE` allows spaces; `surfaces.ts` field-name interpolated into SDL unescaped — trusted-constant-only today.
- **B1-F2** concentration `supplierCount` includes undated-only suppliers (same root as B1-F1; HHI "N of M" caveat softens).
- **B2-F2** raw `control_type` into a strict GraphQL enum can throw on vocab drift (`mappers.ts:300`). **B2-F3** MO `toRelation` defaults unknowns to the substantive `'rectifica'` instead of a sentinel (`legal/mo/mappers.ts:50-51`).
- **B3-F3** unsubscribe token has no expiry/scope (`infra/unsubscribe/token.ts:42-45`) — crypto is sound; low impact.
- **B4-#4** dead helpers in `budget/shell/repo/mappers.ts:30-37` (incl. a `toFloat`). **B4-#5** doc drift: `companies` schema renamed to `companies_v2.*` in code but docs say `companies.*`; foundation §10 module return-shape is stale (no module ships a `restPlugin`).

---

## 3. What's already solid (verified, not assumed)

- **Injection defenses hold.** Every user value is a bound Kysely parameter on every path; the only raw interpolation (`sql.raw(column.cast)`) is gated by `IDENTIFIER_RE`/`CAST_RE` over verified static specs. Meili filters always pin `visibility="public"` and JSON-quote values. Fail-closed `in:[]→FALSE` / territory-empty→FALSE / reference-disjoint→[] all confirmed.
- **Agent tenant isolation is airtight.** Every repo op is `user_id`-scoped; `appendMessages` re-checks ownership inside the transaction so a mid-stream delete/recreate can't redirect a response to another tenant. Quota reserve/reconcile is atomic (Lua) with reconciliation on every finish/abort/error/disconnect path. The prompt-injection boundary (single user message, server-rebuilt history, byte caps, dup-id rejection) is correct.
- **Auth bypass is fail-safe by design** — it only ever assigns `ANONYMOUS_SESSION`, never grants access; protected routes still enforce their own `requireAuth`/permission guards. GraphQL hardening (depth/field/alias caps, prod introspection off, error redaction, batching disabled) is consistent across both surfaces.
- **Erasure design is thoughtful:** deterministic `deleted-user:sha256(id)` makes Clerk replays idempotent/self-healing; the success audit is deliberately written **last** so partial failures never report completion (the `audit_events` empty-array bug is genuinely fixed); the append-only trigger + maintenance-gated redaction path are correctly enforced; svix signature verification, raw-body handling, retry-on-500, and PII log-hashing are all correct; the INS gate elegantly refuses to store anything it can't later erase.
- **Judicial happy path is leak-resistant:** type-level name-free contract (SDL AST test enforces it), per-row + dictionary double gate, fail-closed on unrecognized classifier version, correct ILIKE escaping, `companyName` never echoes the query. The static leak-audit **does run in CI and gates deploy** (the gap is H5's blind spot, not absence).
- **Procurement analysis is correctness-solid:** awarded-only enforced end-to-end, no float touches money, generation isolation sound, the four xhigh defects genuinely fixed and pinned by live-prod golden tests, and the F1 verdict-flip "time-bomb" is structurally neutralized (gate reads `verdict.classes.*`, never recomputes from coverage; cache keys on immutable `buildId`).
- **Notification platform:** no SSRF surface (inbound-only Resend webhook; outbound is the fixed Resend API), retry idempotency sound (stable `providerIdempotencyKey` + claim-token state machine), digest scoping clean, admin reveal authz-gated + audited, no email header-injection surface.
- **No merge markers, no core-purity violations, money-as-string end-to-end, consistent keyset pagination** across the data modules.

---

## 4. Appendix — coverage map

| Agent | Scope                                                                                                                           | Result                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A1    | Auth, surface mount/gate, CORS (`api.ts`, `build-app.ts`, `build-redesign-app.ts`, `cors.ts`, `auth/**`, `graphql/security.ts`) | H6-adjacent CORS Medium; auth bypass refuted as fail-safe |
| A2    | AI agent module (`modules/agent/**`)                                                                                            | No Critical/High; isolation/quota/prompt-boundary solid   |
| A3    | user-data + clerk-webhooks + INS erasure                                                                                        | H2; happy-path erasure verified sound                     |
| A4    | Judicial privacy (`modules/judicial/**`)                                                                                        | H5 + audit-gap Medium; happy path solid                   |
| A5    | Kernel filters / injection / fail-closed + search                                                                               | No Critical/High; injection defenses confirmed            |
| A6    | MCP exposure, rate-limit, procurement gates                                                                                     | H3, H4 + 2 Medium; capability gate sound                  |
| B1    | Procurement analysis/serving correctness                                                                                        | No Critical/High; 1 metadata Medium; F1 neutralized       |
| B2    | Parliament + legal + reference correctness                                                                                      | 1 Medium (pagination) + 2 Low                             |
| B3    | Notification platform + email templates                                                                                         | H1 + 2 lower; no SSRF                                     |
| B4    | budget/companies/pnrr/primarii + infra + arch + docs                                                                            | H6 + money-float Medium + doc drift                       |

**Commit inventory:** 138 commits, `git log main..dev`. Every changed `src/` module is covered above; design docs (`docs/server-redesign/**`, `docs/*DESIGN*.md`, `docs/architecture/**`, `docs/NOTIFICATION-PLATFORM-*.md`, `docs/AGENT-MODULE-SPEC.md`) were reviewed for correctness/drift by the owning agent (drift captured in B1 doc-note, B4-#5, H1 doc-drift, A4-MED-2).

_Report is read-only; nothing in the working tree was modified. Every High finding was re-confirmed against current code during synthesis (H1/H2/H4/H5/H6 file:line verified directly; H3 verified via the single-`.consume()`-callsite grep)._
