# Procurement serving reconciliation

> Updated 2026-07-13. The remediation contract in
> [`docs/server-redesign/10-public-contracts-api-remediation-plan.md`](../../../docs/server-redesign/10-public-contracts-api-remediation-plan.md)
> supersedes the old-MV aggregate catalog.

## Retained record surface

Search, detail, supplier-record, CPV discovery, duplicate references, and TED
references read the canonical `procurement.procedures`, `contracts`,
`direct_acquisitions`, `contract_modifications`, `cpv_divisions`, and reference
tables. These paths do not depend on the legacy aggregate repository or its stale
quality matview.

Money remains a decimal string. The raw `currency` column never reaches the wire:
the mapper exposes a sanitized ISO-like token plus `isRon` and `valueSuspect`.
Direct-acquisition list requests retain their selective-filter guard.

## Generation-stamped analysis surface

The analysis server reads only the active generation and its five stamped rollups:

- `analysis_rollup_edge_monthly`
- `analysis_rollup_authority_dims_monthly`
- `analysis_rollup_supplier_cpv_monthly`
- `analysis_rollup_cpv_code_monthly`
- `analysis_rollup_region_cpv_monthly`

The cross-repo contract is
`procurement-analysis-combinations-v2.json` (554 exhaustive rows, including a
measure dimension for series and compound supplier-fixed concentration
rejections), SHA-256
`9f552ef40b548e0812eedb9d0009e60e6577a037ae7d477f328f557593f3bdf9`.
Local bytes are verified at boot. Analysis requests return `ServiceUnavailable`
when the active generation's `matrix_hash` differs; record APIs remain available.

The six GraphQL operations are `procurementStats`, `procurementSeries`,
`procurementBreakdown`, `procurementConcentration`, `procurementShare`, and
`procurementFacets`. MCP exposes the same four analysis shapes through
`aggregate_procurement`; share and facets remain GraphQL composition operations.
Every result uses `served | degraded | abstained`, a typed reason when not served,
the generation build ID, and `canonicalScope`.

## Removed legacy aggregate surface

The old `ProcurementAggregateRepo`, old-MV gate, and `Entity.procurement`
contributor are removed. The deprecated MCP names are not registered:

- `rank_procurement_suppliers`
- `rank_procurement_authorities`
- `get_procurement_concentration`
- `get_procurement_authority_cpv_spend`
- `find_same_day_da_candidates`
- `get_procurement_grain_quality`

The matching legacy GraphQL analyst fields and detail `gate` fields are also
absent. Repeated-pair, same-day, regional ranking, and Entity-360 procurement
features can return only after they are rebuilt on generation-stamped projections.

The separately mounted legacy `/mcp` registry no longer registers
`query_procurement_filters`; its stale aggregate repository, schemas, usecase,
and tests are deleted. The remaining `/mcp` tools are budget-only.

## Deferred catalog gaps

Supplier geography awaits the company-registry resolution. Unknown-dimension
selectors, canonical procedure-type keys, unbounded DA distinct series, and the
removed analyst features are explicitly wave 2 rather than silently routed to old
materialized views.
