# Public contracts: totals v2 (design note)

Status: planned, 20 Nov 2026. No code until procurement-prod's money-fact schema and rule dictionary land.

## Why

The owner (20 Nov): "I will not force a total in the API layer. That is something we can define from the client. The important part is to have the flexibility of filtering by different procurement, different statuses to have a total value for those filters."

Today the spend gate decides whether a total **may be shown**, and abstains otherwise. Totals v2 **sums what the filters ask** and returns an explanation of what went in and what was left out.

## Data (procurement-prod)

- One ClickHouse money-fact table across direct acquisitions (DA), CA and notices.
- One row per record per `value_kind`, latest version only.
- Each row carries the original currency, lei and the VAT basis.
- A versioned rule dictionary: named filter definitions, each with RO and EN explanations.
- A check that no record appears twice under one `value_kind`.

## v1 scope (kept small)

v1 is one batch read, totals only. Breakdown, series, concentration and value-sorted records come later as separate steps, over the same rules. Profiles join v1 only if the client's first page needs them; explicit filters come first.

### Request

`procurementTotals(requests: [ProcurementTotalRequest!]!)` takes at most 8 requests per call. MCP serves the same as `aggregate_procurement` with shape `totals`.

| Field        | Meaning                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | A client key, echoed back.                                                                                                                                              |
| `filters`    | Procurement kind, contract kind, status keys, date range and date basis, buyer, supplier (D6-aware: a withheld supplier matches nothing), CPV levels, county or SIRUTA. |
| `valueKinds` | `awarded`, `reported`, `estimate`, `framework_ceiling`, `calloff`, `modification_delta`, …: one total per kind, never summed across kinds.                              |
| `rule`       | `{id, version}`, optional; the dictionary default otherwise.                                                                                                            |

### Answer, per request

- **Echo:** `id`, `rule {id, version}`, `factBuild`, and `disclosureKey` on DA rows (D6 unchanged).
- **`filtersApplied`:** the resolved, canonical filters, including the default status set.
- **`statusesIncluded`:** a list of `{key, labelRo, labelEn}`.
- **`totals`:** one `{valueKind, sumLei, recordCount, withValueCount}` per value kind. `sumLei` is a decimal string.
- **`exclusions`:** a list of `{key, labelRo, labelEn, count, valueLei | null}`.
  - Keys: `no_value`, `undated`, `withheld_d6`, `withheld_quality`, `association_duplicate`, plus any key the dictionary declares.
- **`explanation`:** `{textRo, textEn}`, read from the dictionary. The API never writes this text.
- **`allowed`:** `{measures, orders}` for these filters and this rule. This replaces the role of `moneyVerdicts`.
- **Failures:**
  - An unknown rule or version answers `InvalidInput` naming the field.
  - A missing fact table or dictionary answers `ServiceUnavailable`, failing closed.

### Rules that do not change

- D6 and the privacy gates stay. They are not quality gates.
- Quality no longer abstains. What the rule leaves out is listed in `exclusions`, with counts.
- Association money is counted once. Per-firm attribution applies only on supplier-scoped totals, as the owner decides.

### Invariant (tested on real dev data, not only fixtures)

For the same filters, per `valueKind`: the included records plus every exclusion equal the population. This is reported with the first deploy.

### Load

One read per distinct filter set (`GROUP BY value_kind`), through the per-pod cap of 3 ClickHouse reads. A busy pod answers a retryable 503 with `Retry-After`, as now.

## Existing callers

- `procurementStats`, `procurementSeries`, `procurementBreakdown`, `procurementRecords` and `moneyVerdicts` stay unchanged on the legacy facts until the client has moved.
- Old fields are marked `@deprecated` once the client confirms. They are deleted only after that, with the owner's sign-off.

| Today                                                   | v2                                                 |
| ------------------------------------------------------- | -------------------------------------------------- |
| `recordCount`, `withValueCount`                         | The same names, on each total                      |
| `valueAwardedSum`                                       | `totals[awarded].sumLei`                           |
| `avgValueAwarded`                                       | Derived (decimal: sum ÷ withValue)                 |
| `undatedInScope`                                        | `exclusions[undated]`                              |
| `moneyVerdicts`                                         | `allowed`, plus the exclusions                     |
| Breakdown `shareOfScope`, `valueWithheldAssociationSum` | Breakdown v2 (`exclusions[association_duplicate]`) |
| Series, top-1/top-5 concentration                       | Their v2 steps, over the same rule                 |

## Rollout

- Behind `PROCUREMENT_TOTALS_V2`, default off.
- The fact table and the dictionary are probed per request, so nothing depends on them existing.
- Review by Sol at xhigh; pre-push and pre-sync notices to root.

## Open for the owner (through procurement-prod)

- The default status set.
- Association attribution.
- The default VAT basis.
- Original-currency subtotals, or lei only.
- Whether `q` is a totals filter. Titles are rule-gated, so a `q` total counts only public titles.
