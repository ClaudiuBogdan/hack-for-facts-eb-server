# Direct acquisitions, release 1: API surface

Status: built 2026-11-18, off by default (`PROCUREMENT_DA_V3_ENABLED`). It sits beside the legacy
`ProcurementDirectAcquisition` surface, which it does not change. Retiring the legacy surface is a later step for root
and the owner.

The source of truth for field meanings is the data platform's serving contract:
`docs/domains/public-contracts/reference/DIRECT_ACQUISITION_SERVING_CONTRACT.md` (scrapper repo). This page records
only what the API adds or decides.

## What is served per purchase

- `reportedValue`: the closing value as the portal published it. It is never summed, and its currency and VAT
  basis are confirmed only when the purchase is counted.
- `counted` and `notCountedReason` (`code`, `labelEn`, `labelRo`). The API holds the reason labels (contract map).
- `countedValue`: the only summable value; null when not counted. `valueCorrected` and `correctedValue` mark an
  approved correction.
- `reviewRule` (`rule`, `effect`, `descriptionEn`, `descriptionRo`): the rule's public sentence, read from
  `da_value_rules`.
- `symbolicPrice`, `listedNow`, days and decision times, title, description, category, buyer and supplier.
- Detail adds the current item lines (`superseded_at` is null). `reportedLineValue` is quantity × unit price in exact decimal arithmetic and is never
  summed.

## Free text (decision 2026-11-10)

- `title`, `description` and line `name` are restricted until the loader marks them public. The per-field flags are
  `title_public`, `description_public` and `item_name_public`; the owner decides field by field.
- A field that is not marked public is served as null, with `titleWithheld` / `descriptionWithheld` /
  `nameWithheld` set to `"privacy"`. The SQL never selects the text in that case.
- In release 1 all three fields are withheld until the flags exist. `categoryLabel` (the CPV label) is the
  purchase's visible name.

## D6: supplier names (site-wide)

- One source for v3 and the legacy surfaces: `procurement_v3.supplier_privacy` (`fiscal_code_clean`, `public`), built
  by the data platform's classifier over every supplier code the platform serves and rewritten in the nightly
  publish with `data_as_of`. A supplier's name, fiscal code and party id are served only when its code is there with
  `public = true` (and, defensively, valid). Absent code or absent table: withheld, so the rule fails closed.
- A withheld supplier is `natural_person`, with `name`, `fiscalCode` and `partyId` all null; one person's purchases
  cannot be linked across rows.
- A supplier filter matches only public suppliers, so a sole trader's code cannot be used to list their purchases.
- In totals grouped by supplier, every withheld supplier falls into one `natural_person` group. Purchases that name
  no supplier have their own group (`noSupplier: true`).
- Buyers are `authority`: the name is always served, the fiscal code only when it is valid.
- The rule lives in `core/da-release.ts` (`isNamedSupplier`). The SQL mirror (`namedSupplier`, joining
  `supplier_privacy` as `sv`) only filters and buckets rows, and the core re-checks every party before it is served.
  `tests/integration/procurement/da-release-surfaces.test.ts` fails if any surface serves a withheld name, and it
  covers the absent-table case too.

## Consistency

- One read-only `REPEATABLE READ` transaction per request covers `dataAsOf` (read first), the list, the detail and
  the totals.
- Every answer carries `dataAsOf` (UTC, microseconds) and `countedValueBasis` ("RON excluding VAT", the basis of
  counted values only).
- In GraphQL, each top-level field is its own snapshot. An operation that combines several fields compares their
  `dataAsOf` values and refetches if they differ. REST and MCP calls are one snapshot each.
- Release 1 has no revision pinning. If revisions come back, the filter belongs in `snapshot`
  (`shell/repo/da-release-repo.ts`).
- Unfiltered totals are cached in process per `dataAsOf`. The nightly publish writes rows and `data_as_of` in one
  transaction. Filtered totals run live.
- A row that breaks the contract's invariants is refused (500) rather than served:
  - counted ⇔ `counted_value` present ⇔ no reason;
  - a correction ⇒ counted and a rule;
  - the rule must be in `da_value_rules`;
  - enums hold only the contract's values.

## Surfaces

- **GraphQL:**
  - `procurementDaRelease { enabled dataAsOf }`
  - `procurementDaPurchases(filter, page, pageSize)`
  - `procurementDaPurchase(purchaseId)`
  - `procurementDaTotals(filter, groupBy: buyer|supplier|cpvDivision|month|year, page, pageSize)`
- **REST** (`/api/v1/procurement/da`): `GET /status`, `/purchases`, `/purchases/lookup?purchaseId=`, `/totals`.
- **MCP** (only when enabled): `list_procurement_da_purchases`, `get_procurement_da_purchase`,
  `aggregate_procurement_da_totals`.

Filters: `buyerFiscalCode`, `supplierFiscalCode`, `cpvDivision`, `finalizationFrom`, `finalizationTo`, `outcomes`,
`counted`, `code`, `nativeId`. `code` resolves a legacy link's `uniqueCode` to `purchaseId`.

Lists are ordered by finalization day, newest first, and stop at row 10,000. A page may start below that row, and its
last rows are clamped to it. The count is exact up to 10,000; beyond it, `totalCapped` is true. MCP never echoes a
supplier fiscal code back.

With the flag off:

- the SDL and REST routes are still served;
- `enabled` is false;
- data reads answer `SERVICE_UNAVAILABLE` (GraphQL) or 503 `ServiceUnavailable` (REST);
- no MCP tool is registered.

## Switches, caches and the privacy publication

- **Two independent switches:**
  - `PROCUREMENT_DA_V3_ENABLED` serves the v3 data and the analysis DA grain from procurement_v3;
  - `PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED` (D6 site-wide, plus the DA free-text gate) covers every DA surface,
    legacy and ClickHouse included.
    Turn D6 on once supplier_privacy is loaded and keep it on through any v3 rollback, so a rollback never re-exposes a
    name (root, 18 Nov). With D6 off, legacy DA supplier parties carry `displayKind: null`.
- **ClickHouse DA grain while D6 is on:**
  - a supplier scope on a withheld code matches nothing;
  - top supplier buckets with a withheld code merge into one `natural_person` bucket;
  - records serve no withheld code or name, and no title.
- **The privacy check:** `supplier_privacy` counts as present only when the API's login can read it, so a revoked
  grant withholds everyone. Every legacy read checks the public set again after the data read. If a nightly publish
  withheld a code mid-request, the answer withholds it too (lists and scopes are re-read). The v3 reads join
  supplier_privacy in the same snapshot as the data.
- **Server caches:** keyed by publication, with no purge endpoint.
  - The disclosure set, release totals and v3 analysis answers are keyed by `data_as_of`, and also by the privacy
    state (present and readable).
  - The ClickHouse analysis caches are keyed by build, and D6 is applied on read after them.
  - A publish moves the key; flipping a switch is an environment change, so the pods restart and the in-process
    caches start empty.
- **Status:** `procurementDaRelease` serves `privacyEnforced` and `privacyAsOf` (the supplier_privacy publication).
  Clients key their caches by (`dataAsOf`, `privacyAsOf`).
- **Analysis:**
  - DA supplier buckets carry `displayKind` (`company` | `natural_person`);
  - a withheld supplier code is echoed as `withheld` in `canonicalScope` and in MCP `query.scope`;
  - a build pin needs an explicit grain while DA publishes separately;
  - an unreadable v3 publication makes only the DA grain abstain.
- **Kernel:**
  - entity-360's procurement presence has no DA supplier leg for a withheld code;
  - the document count and the document list exclude DA documents in SQL;
  - outgoing top counterparties carry no DA money.

## Rollout order (root, 18 Nov), on every environment

1. procurement_v3 (with `supplier_privacy`) is migrated and loaded.
2. `PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED=true` on the API.
3. The client build that fails closed on `displayKind` is deployed.
4. Later, after root's production-output audit: `PROCUREMENT_DA_V3_ENABLED=true`.

While the D6 switch is off, legacy DA parties carry `displayKind: null`. A fail-closed client deployed before step 2
therefore shows no DA supplier name at all, companies included (acceptable for a short window on dev only).
Production follows the same order.

## Pending (data platform)

- **Schema name:** `procurement_v3` is pending the owner's migration. It is named once, in `DA_RELEASE_SCHEMA`.
- **Pending columns:** `listed_now`, `da_items.superseded_at`, the three free-text flags and the `supplier_privacy`
  table are probed per request, so the reader works before and after they land.
- **Decided (owner, 18 Nov):** D6 holds site-wide. The legacy DA surfaces apply the same `supplier_privacy` rule
  behind its own switch (done). The analysis API's DA grain moves to v3: live Postgres first, a
  ClickHouse projection later. Supplier geography is dropped for DA.
