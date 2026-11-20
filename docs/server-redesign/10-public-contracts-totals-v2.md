# Public contracts: totals v2 (design note)

**Status:** planned. The owner approved the simple shape on 20 Nov 2026 (recorded by procurement-prod in ea0e1dfb4). No code until procurement-prod's money-fact schema and label table land.

## Why

The owner (20 Nov): "I will not force a total in the API layer. That is something we can define from the client. The important part is to have the flexibility of filtering by different procurement, different statuses to have a total value for those filters."

Today the spend gate decides whether a total **may be shown**, and abstains otherwise. Totals v2 **sums what the filters ask**. Each answer also explains, with counts, what went in and what was left out.

**No stored rules.** There are no rule ids, rule versions or rule dictionary. A total is defined by its filters alone:

- The API composes the explanation from the filters it actually applied.
- Profiles (presets) live in the client and expand to filters. The URL keeps the expanded filters.

## Data (procurement-prod)

- **One money-fact table** in ClickHouse, covering direct acquisitions (DA), contract awards (CA) and notices.
  - One row per record per `value_kind`, latest version only.
  - A check that no record appears twice under one `value_kind`.
- **Each row carries** the original currency, the amount in lei, and the VAT basis as published (with VAT, without VAT, or unknown).
- **Contract-award contracts** are counted once across notice versions, keyed on contract number plus conclusion day.
  - A head that is not yet confirmed is included and flagged.
  - A ceiling taken from a list value is flagged.
- **A small label table:** a RO/EN name and a one-line meaning for each status, value kind and procurement kind. The API reads its labels from it and never writes them.

## Defaults (owner, 20 Nov)

| Filter      | Default                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status      | Awarded only                                                                                                                         |
| VAT         | Summed as published, with no conversion. The answer shows the mix (with VAT, without, unknown). VAT basis is also a filter.          |
| Currency    | Totals in lei, plus subtotals per original currency on request                                                                       |
| Title (`q`) | A totals filter. Titles are gated by the free-text rule, so a `q` total counts only titles the API may serve (PROC-37DX, PROC-R87F). |
| Joint wins  | Counted once in market totals. The per-firm split is deferred (PROC-4JSX).                                                           |

**Supplier-scoped totals:** joint contracts are left out of a firm's sum, and the answer reports exclusion `association_unattributed` with its count ("N joint contracts, value not attributed"). There is no split rule.

## v1 scope (kept small)

One batch read, totals only. Breakdown, series, concentration and value-sorted records come later as separate steps, under the client rules below.

### Request

`procurementTotals(requests: [ProcurementTotalRequest!]!)` takes at most 8 requests per call. MCP serves the same as `aggregate_procurement` with shape `totals`.

| Field               | Meaning                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                | A client key, echoed back.                                                                                                                 |
| `filters`           | See the list below.                                                                                                                        |
| `valueKinds`        | `awarded`, `reported`, `estimate`, `framework_ceiling`, `calloff`, `modification_delta`, …: one total per kind, never summed across kinds. |
| `currencySubtotals` | Boolean; adds a subtotal per original currency.                                                                                            |

**Filters:**

- procurement kind, contract kind, status keys;
- date range and date basis;
- buyer; supplier (D6-aware: a withheld supplier matches nothing);
- CPV levels; county or SIRUTA;
- VAT basis;
- title `q`.

### Answer, per request

- **Echo:** `id`, `factBuild`, and `disclosureKey` on DA rows (D6 unchanged).
- **`filtersApplied`:** the resolved, canonical filters, including the defaults that were applied.
- **`included` and `excluded`:** every status, value kind and procurement kind in or out, as `{key, labelRo, labelEn, meaningRo, meaningEn}` from the label table.
- **`totals`:** one entry per value kind, `{valueKind, sumLei, recordCount, withValueCount, vatMix: {withVat, withoutVat, unknown}, currencies?: [{currency, sum, count}]}`. Money is decimal strings.
- **`exclusions`:** a list of `{key, labelRo, labelEn, count, valueLei | null}`.
  - Keys: `no_value`, `undated`, `withheld_d6`, `withheld_gate`, `association_duplicate`, `association_unattributed`, and `unconfirmed_head` / `list_value_ceiling` when a filter leaves them out.
  - Rows that are included but flagged (unconfirmed heads, list-value ceilings) are reported as `flags` with counts.
- **`explanation`:** `{textRo, textEn}`, composed by the API from `filtersApplied`, the labels, the exclusions and the flags. The client prints it verbatim.
- **`allowed`:** `{measures, orders}` for these filters, taking over the role of `moneyVerdicts`.
- **Failures:** a missing fact table or label table answers `ServiceUnavailable`, failing closed and never a guessed total. An unknown filter key or value answers `InvalidInput` naming the field.

### Rules that do not change

- D6 and the privacy gates stay. They are not quality gates.
- Quality no longer abstains. Whatever the filters leave out is listed in `exclusions`, with counts.

### Tests (on real dev data as well as fixtures; reported with the first deploy)

1. **Invariant:** for the same filters, per `valueKind`, the included records plus every exclusion equal the population.
2. **Equality:** a firm's total equals its supplier-breakdown row under the same filters, sum and count. This applies once the breakdown v2 step exists. Until then, v1 checks the firm's total against the legacy supplier breakdown's attributed figures, reported as a comparison and not asserted.

### Load

One read per distinct filter set (`GROUP BY value_kind`), through the per-pod cap of 3 ClickHouse reads. A busy pod answers a retryable 503 with `Retry-After`, as now.

## Rules the later steps must follow (client, 20 Nov)

1. **`association_unattributed` applies to every per-firm sum,** not only the firm's own total:
   - the supplier ranking (breakdown by supplier, which replaces `valueWithheldAssociationSum`);
   - top-1/top-5 concentration;
   - the supplier profile.
     A firm's ranking value equals its page value.
2. **Every money read returns the explanation** (included and excluded, with counts): breakdowns and series as well as the headline totals.
3. **Records sorted by value use the same defaults** (awarded only, the VAT and currency notes), so the list and the total describe the same set.

## Existing callers

- `procurementStats`, `procurementSeries`, `procurementBreakdown`, `procurementRecords` and `moneyVerdicts` stay unchanged on the legacy facts until the client has moved.
- Old fields are marked `@deprecated` once the client confirms. They are deleted only after that, with the owner's sign-off.

| Today                                                   | v2                                                    |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `recordCount`, `withValueCount`                         | The same names, on each total                         |
| `valueAwardedSum`                                       | `totals[awarded].sumLei`                              |
| `avgValueAwarded`                                       | Derived (decimal: sum ÷ withValue)                    |
| `undatedInScope`                                        | `exclusions[undated]`                                 |
| `moneyVerdicts`                                         | `allowed`, plus the exclusions                        |
| Breakdown `shareOfScope`, `valueWithheldAssociationSum` | Breakdown v2 (`exclusions[association_unattributed]`) |
| Series, top-1/top-5 concentration                       | Their v2 steps, under the same filters                |

## Rollout

- Behind `PROCUREMENT_TOTALS_V2`, default off.
- The fact table and the label table are probed per request, so nothing depends on them existing.
- Review by Sol at xhigh; pre-push and pre-sync notices to root.
