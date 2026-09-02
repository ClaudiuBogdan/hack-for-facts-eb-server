# Golden Master harness

End-to-end replay of GraphQL documents against a running server. Two
orthogonal switches:

| Switch              | Values                                                         | Meaning                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Execution mode**  | `TEST_GM_API_URL=<url>` or `TEST_GM_DATABASE_URL=<pg url>`     | HTTP POSTs to a running endpoint, or an in-process Fastify app over a database (`app.inject`)                                                                            |
| **Comparison mode** | `TEST_GM_BASELINE_URL` unset → **snapshot**; set → **cutover** | Compare `data` against the stored `snapshots/**.snap.json`, or compare the full envelope of the target (`TEST_GM_API_URL`) against the baseline (`TEST_GM_BASELINE_URL`) |

Cutover mode is API-mode only: DB mode builds the app with
`redesignSurface.enabled: false`, so it has no second endpoint. A half-configured
environment (`TEST_GM_BASELINE_URL` without `TEST_GM_API_URL`, or combined with
`TEST_GM_DATABASE_URL`) throws at startup instead of silently running in
snapshot mode, and so does a baseline/target pair that canonicalizes to the
same endpoint (host case, default port, trailing slash, fragment, userinfo —
`endpoint.ts`).

## Scripts

| Script                  | What it does                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:gm`          | Snapshot mode, the 12 hand-written specs (the corpus spec is excluded: it has no stored snapshots). Default `TEST_GM_API_URL=http://localhost:3001/graphql`        |
| `pnpm test:gm:update`   | Same, rewriting the stored snapshots                                                                                                                               |
| `pnpm test:gm:cutover`  | **The cutover gate**: the client-document corpus only, baseline `http://localhost:3000/graphql` → target `http://localhost:3000/api/v1/graphql`                    |
| `pnpm test:gm:extended` | Non-gating diagnostic: the 12 hand-written specs in cutover mode (they exercise legacy roots the client never sends — `entity`, `uat`, `reports`, `insCompare`, …) |
| `pnpm gm:corpus`        | Regenerate `corpus/client-documents.json` from the client repo (`scripts/gm/gen-client-corpus.mts`)                                                                |
| `pnpm gm:corpus:check`  | Fail when the committed corpus drifts from the client tree (documents, variables, sources, or the pinned client commit)                                            |

Every URL default is an environment fallback (`${TEST_GM_API_URL:-…}`), so
`TEST_GM_BASELINE_URL=… TEST_GM_API_URL=… pnpm test:gm:cutover` overrides them.

Optional environment:

| Variable                   | Default                                                      | Purpose                                                                                                    |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `TEST_GM_REPORT_DIR`       | `tests/golden-master/reports/` (gitignored)                  | Where cutover reports are written                                                                          |
| `TEST_GM_RUN_ID`           | timestamp + random nonce (`global-setup.ts`)                 | Sub-directory of the report dir for this run. Run ids are **single-use**: an existing directory is refused |
| `TEST_GM_INCLUDE_DEAD`     | unset                                                        | `true` runs the corpus entries marked `dead` (otherwise `it.skip` with a visible reason)                   |
| `TEST_GM_STRICT_ALLOWLIST` | `true`                                                       | `false` downgrades a stale allowlist entry from a run failure to a warning                                 |
| `TEST_GM_ALLOWLIST_PATH`   | `tests/golden-master/parity-allowlist.json`                  | Another allowlist file (offline fixtures, dry runs)                                                        |
| `GM_CLIENT_REPO`           | `../hack-for-facts-eb-client` (sibling of the main checkout) | Client repo the corpus generator reads (`--client <path>` also works)                                      |

## Bringing up both endpoints for `pnpm test:gm:cutover`

`pnpm dev` (`src/api.ts` → `app/build-app.ts`) serves the legacy `/graphql` and,
when the redesign surface flag is on, ALSO mounts the kernel at
`/api/v1/graphql` on the same port (`build-app.ts` `REDESIGN_SURFACE_ROUTE_PATHS`,
the `registerRedesignSurface` child scope). Exact requirements:

1. **Legacy side** — the Phoenix dev DB port-forwards (`pnpm dev:forward`) and
   the legacy `.env` (names in `.env.example`; never print it).
2. **Redesign side** — set `REDESIGN_SURFACE_ENABLED=true` (a `Type.Boolean`
   parsed from the literal string `true`, `src/infra/config/env.ts`) AND provide
   the redesign kernel env, which `pnpm dev` loads from
   `.claude/redesign-prod.env` if present (`--env-file-if-exists`). The only
   hard requirement in `src/infra/config/redesign-env.ts` is `PROD_DATABASE_URL`
   (Chronos `transparenta_prod`, read-only, over Tailscale); `PROD_MEILI_*`,
   `PROD_OPENSEARCH_*`, `PROD_SYNTHETIC_*` degrade to "aux service down". If the
   redesign env is missing or invalid, `src/api.ts` logs a warning and starts
   the legacy API only — `/api/v1/graphql` then answers Fastify's JSON 404 body,
   which the harness refuses as **not a GraphQL envelope**: every cutover case
   fails with a `transport-error` defect (never "both sides agree").
3. `PORT` defaults to `3000` (`env.ts`), which is what `test:gm:cutover` targets.
   The older `test:gm` script points at `3001`; override `TEST_GM_API_URL` to
   match your local `PORT`.

Then:

```bash
pnpm dev                 # one process, two GraphQL endpoints on :3000
pnpm test:gm:cutover     # in a second shell — the gate
pnpm test:gm:extended    # optional: the 12 legacy specs, diagnostic only
```

Vitest flags are forwarded as-is (no `--`): `pnpm test:gm:cutover -t entity-search`
runs one case, but the run still FAILS — the teardown reconciles the executed
cases against `planned.json` (63 planned, 1 executed) and sets the process exit
code. Filters are for debugging a case, never for producing a green gate.

`/api/v1/graphql` is exempt from the legacy global auth preHandler
(`REDESIGN_SURFACE_ROUTE_PATHS`), and the harness sends no `Authorization`
header, so both endpoints are exercised anonymously — the same footing as the
client's `skipAuth` INS calls and its anonymous visitors.

Design §6 also asks for the replay against `INTERNAL_API_URL` (the SSR base).
The harness has one target per run; locally both bases are the same process.
When they diverge, run `pnpm test:gm:cutover` a second time with
`TEST_GM_API_URL` set to the internal base.

## Transport rules (`client.ts`, `envelope.ts`)

Both sides are fetched with `redirect: 'manual'` (any 3xx is a failure — a
redirect would compare some other endpoint), an `AbortSignal.timeout` derived
from the case timeout (`fetchTimeoutForCase`: half the case timeout minus a
margin, because the two sides are fetched sequentially), and the body is parsed
**losslessly**: every numeric token keeps its wire text (`LosslessNumber`), so
`9007199254740992` and `9007199254740993` stay different and `1e999` is
rejected. A body is an envelope only if it is a JSON object with `data`
(object or null) and/or `errors` (array of `{ message }`) and nothing else;
anything else (Fastify 404, HTML, non-JSON) is a `transport-error`. The final
response URL is recorded per side in the case report.

## What the cutover run compares (`compare.ts`)

Per document+variables, the full envelope `{ status, data, errors }` of the
baseline (expected) and the target (actual):

| Check                                                                                                  | Classification        |
| ------------------------------------------------------------------------------------------------------ | --------------------- |
| HTTP status differs                                                                                    | `contract-break`      |
| `errors[]` present on one side only, different count, different message (sequence) or different `path` | `contract-break`      |
| Key missing on the target (aliases are literal: `fn_c` must come back as `fn_c`)                       | `contract-break`      |
| Type change (object / array / scalar)                                                                  | `contract-break`      |
| **Any value present on the baseline that is null or absent on the target** (`null-loss`, any type)     | `contract-break`      |
| `__typename` differs                                                                                   | `contract-break`      |
| Anything under a `pageInfo` object differs, extra keys included (`totalCount` named explicitly)        | `contract-break`      |
| Same elements in a different order (`array-order`; arrays are sequences)                               | `contract-break`      |
| Same shape, different scalar / null → value / array length                                             | `data-parity`         |
| Numbers unequal exactly but equal at 2 decimal places (exact decimal comparison, `decimal.js`)         | `rounding`            |
| Extra key on the target outside `pageInfo`                                                             | warning (never fails) |

Every element of every array is classified and every difference reaches the
allowlist and the verdict. Only the written **report** is bounded: per list and
per innermost array at most 25 records are listed; the rest are tallied in one
`array-diff-truncated` marker that carries the strongest unlisted class and the
unlisted kinds. `counts` counts every difference; `hidden` counts what the file
does not list.

## Verdict (`cutover.ts`)

A case **fails** on any case defect, any `contract-break`, or any `data-parity`
difference not pinned by the allowlist. It is `pass-with-warnings` when it has
allowlisted differences, `rounding` differences, extra-key warnings, or a
`baseline-empty` warning (every list-bearing root field empty on the baseline —
the pair proves nothing about the data). It is `pass` only when nothing at all
differs.

Case defects (always fail, regardless of differences):

| Defect                        | When                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport-error`             | a side did not answer with a GraphQL envelope: refused, timeout, redirect, non-JSON, Fastify 404 body, non-finite number                                 |
| `no-data`                     | a `live` / `dead` case where a side did not answer `200` + non-null `data` + no `errors` (two identical 503s or `data: null` pairs are NOT a pass)       |
| `baseline-error`              | a `live` / `dead` case whose **baseline** returns `errors[]` — identical errors on both sides are not equivalence; the corpus or its variables are wrong |
| `baseline-unexpectedly-valid` | an `invalid-today` case the baseline now accepts (stale status)                                                                                          |

## Reports

Each case writes `<report dir>/<runId>/cases/<id>.<doc8>-<vars8>.json` as soon
as it is compared (vitest isolates module state per spec file, so nothing is
accumulated in memory). The corpus spec registers the cases it will execute in
`<runId>/planned.json` at collection time; the `globalSetup` teardown assembles
`summary.json` + `summary.md`, **reconciles executed against planned** (a `-t`
filtered run or a case killed by vitest before it wrote its file fails the
run), lists stale allowlist entries, and when the run is not OK sets
`process.exitCode = 1` and throws (vitest 4 alone would log a teardown error
and still exit 0 when every test passed). Every
case file carries both sides' HTTP status, final URL, duration, root shape
(array lengths / `totalCount` per root field — the evidence of how much a pass
compared), `leavesCompared`, and the fingerprints a reviewer needs for an
allowlist entry.

The run directory is created exclusively in `global-setup.ts`; a reused
`TEST_GM_RUN_ID` is refused, so a summary can never merge two runs' files.

## The parity allowlist (`parity-allowlist.json`)

The legacy `/graphql` reads Phoenix and the kernel `/api/v1/graphql` reads
Chronos (design 13 §5–§6), so value drift between the two databases is
expected and must be **explained per root**, not pinned per value. Three entry
kinds, all narrow; `contract-break` differences (missing key, type change,
`null-loss`, `__typename`, `pageInfo`, array **order**, errors, status) can
never be allowlisted by any kind; `rounding` differences (equal at 2 dp) are
listed with the exact values but never block.

| Kind         | Fields                                                                                                                                                                                                                           | Covers                                                                                       | Use for                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pinned`     | `key` (case), exact `path`, `kind` ∈ `value-change` / `null-change` / `array-length` / `total-count-change` (the last one only per case, with the exact numbers), `before`+`after` **or** `beforeSha256`+`afterSha256`, `reason` | exactly one difference of one case, with those values                                        | one-offs                                                                                                                  |
| `systematic` | `deltaId`, `root`, `pathPattern`, `kind: "value-change"`, `predicate` (`{ratio:{min,max}}` — the range must not contain 1 — or `{relativeTolerance}` or `{absoluteTolerance}`), `reason`, optional `caseKeys`                    | numeric `value-change` differences under the pattern whose actual/expected satisfy the bound | a documented systematic delta (per-capita denominator fix, float-vs-decimal trailing digits); survives the next data load |
| `drift`      | `deltaId`, `root`, `pathPattern`, `kind` ∈ `value-drift` (covers `value-change` + `null-change` on scalars) / `array-cardinality` (covers `array-length`), `explanation`, optional `caseKeys`                                    | every matching difference, no value predicate                                                | the F0 Phoenix-vs-Chronos data drift, explained per root                                                                  |

```json
{
  "entries": [
    {
      "type": "pinned",
      "key": "<sha256(document)>:<sha256(canonical variables)>",
      "path": "$.data.entities.nodes[0].name",
      "kind": "value-change",
      "before": "MUNICIPIUL CLUJ-NAPOCA",
      "after": "Municipiul Cluj-Napoca",
      "reason": "entities re-backed by Meilisearch; display casing only"
    },
    {
      "type": "systematic",
      "deltaId": "per-capita-denominator-2026-09",
      "root": "entityAnalytics",
      "pathPattern": "nodes[*].per_capita_amount",
      "kind": "value-change",
      "predicate": { "ratio": { "min": 1.85, "max": 1.95 } },
      "reason": "kernel divides by the resident population, legacy by the domicile population"
    },
    {
      "type": "drift",
      "deltaId": "f0-aggregated-line-items",
      "root": "aggregatedLineItems",
      "pathPattern": "nodes[*].amount",
      "kind": "value-drift",
      "explanation": "Chronos carries the 2025-Q4 re-statements Phoenix lacks (design 13 §5 step 2)"
    }
  ]
}
```

`pathPattern` is relative to `$.data.<root>`: `[*]` matches any index, `*`
any one key, an empty pattern the root itself. Arrays are compared as
sequences; the same elements in a different order are ONE `array-order`
contract-break (no kind covers it). An array that is both reordered and
drifted surfaces as element-wise `value-change` differences, which a `drift`
entry would cover — check the `Largest relative difference` column before
accepting such an entry.

Every case file records, per matching entry, the match count and the largest
relative difference (`|a−e| / max(|e|,|a|)`) with its path; `summary.md`
aggregates them per entry ("Allowlisted differences by entry": delta id,
cases, matches, largest relative difference and where). An entry of ANY kind
that matches no difference in a run is **stale** and fails the run
(`TEST_GM_STRICT_ALLOWLIST=false` downgrades it to a warning), so the
allowlist can only shrink as parity improves. `TEST_GM_ALLOWLIST_PATH` points
a run at another file (offline fixtures, dry runs).

## The client-document corpus

`corpus/client-documents.json` is **generated** by
`scripts/gm/gen-client-corpus.mts` from the client repo and holds every legacy
document the client sends (51 distinct documents; some appear with more than
one variables set, e.g. both `lang` encodings and both `@include(if:)`
toggles). Documents are located by anchor (the one template literal containing
`query <OperationName>`), so `source` is computed, never hand-maintained; the
INS documents come from `ins-queries.ts` with fragments interpolated. Variables
come from the client's own builders — `prepareFilterForServer`,
`buildEntityIncomeExpenseChartState` (series ids, default year range),
`defaultMapFilters`, `defaultEntityAnalyticsFilter`, `buildCommitmentsFilter`,
the challenge-page period builders, the INS filter builders — loaded through
`scripts/gm/client-module-hooks.mts` (path alias, Lingui macro shim, Vite meta
substitution). `meta.clientCommit` pins the client commit; `pnpm gm:corpus:check`
fails on any drift, the pin included.

| Field             | Meaning                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | kebab-case case id, unique                                                                                                                                         |
| `document`        | exact GraphQL text as the client sends it                                                                                                                          |
| `variables`       | one realistic variables object from the client's builders (JSON round-tripped like the transport, so `undefined` members are absent)                               |
| `source`          | client `file:start-end` of the document, computed                                                                                                                  |
| `status`          | `live`, `dead` (no consumer; skipped unless `TEST_GM_INCLUDE_DEAD=true`), `invalid-today` (fails validation on today's SDL; the error envelope is the expectation) |
| `variablesSource` | the builder / hook / route the variables came from                                                                                                                 |
| `timeoutMs`       | per-case vitest timeout for the large `limit` cases                                                                                                                |

`corpus.ts` validates the file on load: TypeBox shape (`meta` included), unique
ids and keys, `graphql.parse`, exactly one operation, every supplied variable
declared, every non-null declared variable supplied. `tests/unit/golden-master`
additionally validates every document against the legacy schema built offline
from the same 18 SDL constants `build-app.ts` uses: exactly the four
`invalid-today` documents fail, with the inventory's messages.

## Existing specs in cutover mode (`pnpm test:gm:extended`)

The 12 hand-written spec files need no edits: in cutover mode
`client.query()` runs the document against both endpoints, compares, writes the
case report (keyed by the vitest test name) and throws on a blocking
difference before returning the target data; `toMatchNormalizedSnapshot` then
short-circuits, because the stored snapshots were recorded against a different
database and cannot be the oracle for the cutover. Their reports carry no
`planned.json` (an "unplanned run" in the summary). Snapshot mode is stricter
than before in two small ways: `query()` throws on `data: null` and on a
non-envelope body.

## Unit tests

`tests/unit/golden-master/` covers the lossless envelope parser, endpoint
canonicalization, the classifier (including the hidden-class escalation), the
key-set diff with aliases, the allowlist (pinning, staleness), the verdict
(two-404 pair, `data: null` pair, extra keys), the corpus loader (including the
real corpus file and the offline SDL validation) and the report summary
(reconciliation, stale entries). They run with `pnpm test` and need no server.
