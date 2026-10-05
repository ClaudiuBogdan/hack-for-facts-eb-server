# National budget API (budget module)

Seven read-only GraphQL roots and seven equivalent MCP tools serve the national
approved budget laws and the MF execution bulletins. The contract is the
reviewed v3 design (`schema.graphql`) plus one additive field,
`BudgetApprovedTotalCell.authorityCode`. Series reuse the existing common
`DataPoint` and `DataSeries` types.

Status: implemented and qualified on an isolated PostgreSQL 18 fixture using
real migration DDL and a checksum-verified production-row snapshot.
Source-backed GraphQL/MCP outputs were compared with native SQL and the audited
series view. All 47 qualification checks and 194 focused tests passed. Live
availability and client connectivity are verified separately for each
deployed environment.

| GraphQL root                    | MCP tool                               | Reads                                                           |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `budgetNationalCatalog`         | `get_budget_national_catalog`          | editions/slots/forms, named totals, coverage, 52 catalog items  |
| `budgetApprovedTotals`          | `get_budget_approved_totals`           | named law totals per edition/fund/slot/credit type (≤100 cells) |
| `budgetApprovedSeries`          | `get_budget_approved_series`           | one named total on one axis as the common `DataSeries`          |
| `budgetApprovedRecords`         | `list_budget_approved_records`         | faithful flat law records, native thousand lei                  |
| `budgetExecutionReleases`       | `get_budget_execution_releases`        | months, current selection, bounded revision chains              |
| `budgetExecutionObservations`   | `list_budget_execution_observations`   | printed observations per selection occurrence                   |
| `budgetNationalExecutionSeries` | `get_budget_national_execution_series` | audited national BGC series, five grids                         |

## Behaviour

- **Transactions.** Each root runs as one read-only repeatable-read transaction and builds its whole payload eagerly; no field resolver reads.
- **One budget per root.** A read budget of 5 s (15 s for the national series), measured from the request. A successful result is always produced within it.
  - Kysely enters the transaction only after pool checkout **and** BEGIN. From then on, one guard runs before and after every awaited step, so no setup or source statement starts once the budget is spent. The guard trips when the read was abandoned or less than 1 ms remains.
  - **Inherited limit.** The first statement reads the connection's inherited `transaction_timeout` in milliseconds from `pg_settings`. A missing or malformed setting fails closed with `SERVICE_UNAVAILABLE`.
    - A positive inherited limit is a stricter cap that is kept, never extended. It is anchored at the read start, so checkout and setup time count against it.
    - The effective read deadline is min(start + budget, start + inherited). The effective server backstop is min(start + budget + 1 s, start + inherited); the 1 s grace never goes past the inherited limit. Zero means no inherited cap.
  - **Backstop reset and re-arm.** In PostgreSQL 18 a positive `SET` only arms an inactive transaction timer, and `0` disables an active one. So the port sends `SET LOCAL transaction_timeout = 0`, then the strictly positive time left to the effective backstop. This replaces whatever timer BEGIN armed.
    - No source statement starts before the positive value is acknowledged.
    - When the backstop passes, the session is terminated, and the kernel pool evicts that client on release.
    - COMMIT/ROLLBACK restores the inherited value. No session, pool, role or database setting is changed.
  - Every source statement then runs with `statement_timeout` = the remaining budget, so PostgreSQL cancels it server-side and the connection stays usable.
  - Work or a COMMIT that finishes at or after the effective read deadline is `GATEWAY_TIMEOUT`. Late work is rolled back instead of committed. A timed-out read never populates the cache.
  - A cancelled or terminated statement (57014 / 25P04), or any failure once the effective read deadline has passed, is `GATEWAY_TIMEOUT`. This includes a generic "connection terminated" after an inherited cap.
  - A generic connection failure before that deadline, including at COMMIT/ROLLBACK, stays a database error. A source error keeps its own mapping even when the following ROLLBACK fails.
  - Errors: spent budget → `GATEWAY_TIMEOUT`; missing relation or grant, an unknown stored literal, a missing/malformed `transaction_timeout` setting, or a view row missing inside coverage → `SERVICE_UNAVAILABLE`.
- **Timeout allowance.** The time until a caller receives `GATEWAY_TIMEOUT` is longer than the read budget.
  - If checkout and BEGIN have not both completed by the deadline (a queued pool waiter or a stalled BEGIN), the caller gets `GATEWAY_TIMEOUT` at the deadline, labelled checkout/transaction start. A late transaction start runs no SQL and is rolled back and released by the driver.
  - Otherwise the port waits for the transaction to settle until the absolute time effective backstop + 250 ms: at most 6.25 s, or 16.25 s for the series, and less under a stricter inherited limit. If that time has already passed when the inherited limit is discovered, the port stops waiting at once; the margin is never renewed.
  - Returning `GATEWAY_TIMEOUT` only ends the caller's wait. It does not prove the backend stopped or the connection was reclaimed.
  - An abandoned read is logged at once, and its eventual settlement, if any, is logged separately. Logging is best-effort and never changes the response.
- **Dates.** `DateStyle` is pinned to ISO for each national transaction, right after the backstop is armed and before any source statement, so every date is `YYYY-MM-DD` whatever the session default.
- **Snapshots.** The approved and execution lanes have separate snapshot tokens.
  - Cursors bind the canonical filters and the lane snapshot. A pinned `interpretationId` or explicit selection IDs give immutable cursors instead.
  - A moved lane, or a stale `expectedSnapshot`, fails with `INVALID_INPUT` plus `extensions.reason = SNAPSHOT_CHANGED` and `extensions.currentSnapshot`. MCP puts both in `meta`.
- **Cache.** A plain request may be answered from a cache keyed by canonical arguments and the lane snapshot. Freshness is measured from when the read STARTED: a snapshot is reused for at most 30 s after its read began, a read that took longer is not reused, and an older read never replaces a newer one.
  - Explicit `expectedSnapshot` requests and cursor continuations always read the current lane.
  - A cursor continuation's response is never stored. A first-page or non-paged response whose `expectedSnapshot` passed is stored like a plain request. Errors are never stored.
  - At most 64 responses are retained (oldest evicted first). A response is stored only if its complete public payload is at most 256 KiB of UTF-8 JSON (262,144 bytes). A larger payload is simply not stored: the response is unchanged and no stored entry is evicted. Both limits can be configured lower, never higher.
  - The cache is per process and is never a source replay.
- **MCP inputs.** The six query tools publish structural JSON schemas: field names, required members, enum vocabularies, list bounds, the common `ReportPeriodInput` and every `@oneOf` choice as alternatives. The server's core validator stays the semantic authority (label formats, cross-field rules, UUID case), exactly as for GraphQL. As in GraphQL, a single value is accepted where a list is expected and treated as a one-element list. Each description includes a complete example.
- **Values.** Amounts are exact decimal strings (`toFixed()`, equal to `trim_scale(x)::text`); there are no floats.
  - Law amounts are native thousand lei. Totals and series may be converted to `RON` by exact ×1000.
  - Records are always native thousand lei.
- **Law rules.**
  - Each named total is one reviewed descriptor match: never a sum, and never amount matching.
  - Candidate records are read with all their stored slots before the target slot is chosen.
  - A form with more than one loaded interpretation makes all its results `AMBIGUOUS`.
  - Requested authority codes are echoed even when unavailable. No name or CUI is invented.
- **Execution rules.**
  - Facts come from the flat `semantic_key`.
  - BLANK/UNRESOLVED/NONFINANCIAL cells need exactly one resolved selection, and only cells whose sealed classification is a JSON object are returned.
  - Only BGC observations map to catalog items; Sinteza's equal headline stays unmapped.
  - Series `periodStart`/`periodEnd` are the interval the value covers (YTD and full year from 1 January), separate from the display date.
  - Unavailable periods keep the view's raw lowercase reason and have no `DataPoint`.

## Limitations

- **Law source links.** `document.url` is `null` (SOURCE LINK PENDING) until a reviewed, data-owned URL relation exists.
- **Release families.** Without a family contract, a release's families are its loaded inputs, all `PRESENT`. Absence is never inferred.
- **Evidence.** Single-selection reads return every stored locator coordinate (`kind`, `sheet`, `cell`, `page`, `table`, `row`, `column`; zero is a real coordinate, absent is null). Multi-selection FACT reads carry no locator or label evidence; their `sourceState` is `number`, which the release seal guarantees for facts.
- **Classified blanks** keep their sealed unit (e.g. `RON`) with a null value.
- **Not provided.** No normalization, plan/execution rate, component-derived flow, hierarchy, arbitrary aggregate or cross-edition authority identity.
- **Deadline limits.** This is a shared-kernel limitation, documented rather than solved here. When checkout, BEGIN, the setting read, a SET, COMMIT/ROLLBACK or the socket itself never settles, the port cannot cancel a queued pool waiter, destroy the checked-out client or make that step settle. It holds only an abandoned pending transaction and its log entries. Before the reset, setup is protected by the inherited timer, if there is one. Between the reset to `0` and the acknowledged positive value, only the pool's session `statement_timeout` and the client guard apply. If the connection dies before the setting is read, the port has neither the setting nor a SQLSTATE, and a failure before the read budget ends stays a database error. The kernel pool sets no TCP keep-alive and no client query timeout. Ordinary PostgreSQL cancellation, rollback and release, and the cleanup of late transaction starts, are the guarantees in scope.
- **Large responses are not cached.** A full 12-item MONTH/YTD national series (about 2.18 MB) exceeds the size limit, so every repeat runs its one batched view query again within the 15 s budget. The limits bound retained serialised payloads to 16 MiB. They do not bound heap or RSS, and they do not limit responses being built concurrently.
- **Operational qualification still pending.** The real-DDL checks include shortened deadline budgets and warm requests, including two concurrent fixture requests. Query-plan analysis, cold latency, production concurrency and p95 remain unproven. Snapshot-based API parity does not replace source financial-admission checks or live deployment validation.
