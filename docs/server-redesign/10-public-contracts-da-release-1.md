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

## D6: supplier names

- A supplier is named (`displayKind: company`, with name, fiscal code and party id) only when `supplier_kind =
'company'` and its fiscal code is valid. Until the loader adds `supplier_kind`, a valid fiscal code is the
  contract's fallback.
- Every other supplier is `natural_person`, with `name`, `fiscalCode` and `partyId` all null. No party id is served
  either, so one person's purchases cannot be linked across rows.
- A supplier filter matches only named suppliers, so a sole trader's code cannot be used to list their purchases.
- In totals grouped by supplier, every withheld supplier falls into one `natural_person` group. Purchases that name
  no supplier have their own group (`noSupplier: true`).
- Buyers are `authority`: the name is always served, the fiscal code only when it is valid.
- The rule lives in `core/da-release.ts` (`isNamedSupplier`). The SQL mirror (`namedSupplier` in the repo) only
  filters and buckets rows, and the core re-checks every party before it is served.
  `tests/integration/procurement/da-release-surfaces.test.ts` fails if any surface serves a withheld name.

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

## Pending (data platform)

- **Schema name:** `procurement_v3` is pending the owner's migration. It is named once, in `DA_RELEASE_SCHEMA`.
- **Pending columns:** `supplier_kind`, `listed_now`, `da_items.superseded_at` and the three free-text flags are
  probed per request, so the reader works before and after they land.
- **Open (root/owner):** the legacy DA surface still serves supplier names. A v3 `code` looked up there can name a
  supplier that v3 withholds. This must be settled before the flag goes on.
