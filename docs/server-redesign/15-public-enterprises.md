# 15 — Public enterprises

> Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md).
> Module: `src/modules/public-enterprises/`. Flag: `PUBLIC_ENTERPRISES_ENABLED`
> (default `false`).

## 1. Summary & data status

The core of the Romanian public-enterprise registry: who is a public enterprise now
(AMEPIP company-year and form registries, the S1001 list), which authority controls
it as each source reports (S1001, JSON-APT), and the AMEPIP indicator cells.

The scraper owns the data. The server reads only the five read views of scraper
migration `20261006T180000__public_enterprises_public_read_views` in
`public_enterprises`. About 1,742 anchors are stored, including historical ones; up
to 15 observations, 3 edges and 258 indicator cells per enterprise.

Financials stay in the companies module (`company(cui) { financials }`). Out of scope:
state-aid money, REST, search projection, client pages and any national ownership
claim.

## 2. Schema → domain model

| View                            | Model (`core/types.ts`)                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_source_snapshots`       | `PublicEnterpriseSource`: always three lanes (`amepip`, `s1001`, `json_apt`); a lane without a current public snapshot is `unavailable` with null fields |
| `public_registry_observations`  | `PublicEnterpriseRegistryObservation` (names and statuses as reported)                                                                                   |
| `public_authority_edges`        | `PublicEnterpriseAuthorityEdge` (`authorityName` as reported; not an identity)                                                                           |
| `public_enterprise_memberships` | `cui`, `isCurrentMember`, `currentFamilies`                                                                                                              |
| `public_amepip_indicators`      | `PublicEnterpriseIndicator`: `numericValue` exact decimal text; `rawValue` the original cell (`''` ≠ null); `textValue` served null                      |

The views already apply privacy (every joined row public), currency (current accepted
snapshot) and primary-only membership (JSON-APT never makes a member). Organization
names come from the kernel `IdentityRepo.findManyByCui`; a withheld or absent identity
is `organization: null` and the record stays.

Not served: base tables, loader projections (`universe_sources`, `current_status`,
first/last seen), `attrs`, metadata and the derived dictionary classification
(`kpi_family`, `value_type`, `is_absolute_financial`).

## 3. Repo interface (ports)

`PublicEnterpriseRepository` (`core/ports.ts`), each `Result<T, ApiError>`, one
read-only repeatable-read transaction, `statement_timeout` 5 s:

- `sources()`; `profile(cui)` (null when not an anchor); `list({ filter, page, pageSize })`;
  `indicators({ cui, filter, first, after })`.

Disabled: every method returns `ServiceUnavailable` without a query. A missing view
(`42P01`) is `ServiceUnavailable`. No new index (measured bounds above).

## 4. Usecases

`listPublicEnterpriseSources`, `getPublicEnterpriseProfile`, `listPublicEnterprises`,
`listPublicEnterpriseIndicators` and `searchPublicEnterprises` (MCP discovery). CUIs are
`^[0-9]{2,10}$`. No contributor is registered yet (no entity-360 slice).

## 5. REST endpoints

None (GraphQL and MCP only).

## 6. GraphQL

```graphql
extend type Query {
  publicEnterprise(cui: CUI!): PublicEnterpriseProfile # null = not an anchor
  publicEnterprises(
    filter: PublicEnterprisesFilter
    page: Int = 1
    pageSize: Int = 20
  ): PublicEnterprisePage!
  publicEnterpriseSources: [PublicEnterpriseSource!]!
}
```

`PublicEnterpriseProfile.indicators(filter: PublicEnterpriseIndicatorsFilter, first: Int = 100, after: String)`
is a connection with `snapshotId`. Enums: `PublicEnterpriseFamily`
(`amepip_company_year amepip_form_group s1001 json_apt`), `PublicEnterpriseSourceFamily`
(`amepip s1001 json_apt`), `PublicEnterpriseLaneStatus` (`available partial unavailable`),
`PublicEnterpriseValueKind` (`number boolean text empty`). Dates: `observedAt` is the
platform's capture time, not a publication date.

## 7. Filters

| Spec       | Field                               | Op                                              | Column                                   |
| ---------- | ----------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| list       | `cuis`                              | in                                              | `m.cui`                                  |
| list       | `families`                          | in (overlap)                                    | `m.current_families`                     |
| list       | `currentOnly`                       | eq, default true; false adds historical anchors | repo                                     |
| list       | `authorityCuis`, `authorityLevels`  | in, on the same current public edge             | repo (EXISTS)                            |
| indicators | `years`, `kpiCodes`, `sourceSheets` | in                                              | `v.year`, `v.kpi_code`, `v.source_sheet` |

List: offset (`page`, `pageSize` ≤ 100), numeric CUI order, exact `total` (cheap).
Indicators: kernel cursor envelope, order `(year, source_sheet, version, indicator_key)`
compared in C collation, `first` ≤ 100. The `fhash` pins the CUI, the canonical
filters and the current AMEPIP snapshot: another CUI, filter set or source revision
fails with the kernel `InvalidInput` "cursor/filter mismatch; restart pagination".

## 8. MCP tools

- `search_public_enterprises { q?, filter?, page?, pageSize? }`: `q` is a CUI or a
  name resolved by the kernel identity (bounded to 50 matches), intersected with the
  anchors through the list filter.
- `get_public_enterprise_profile { cui }`.
- `list_public_enterprise_indicators { cui, filter?, first?, after? }`.

Standard output `{ ok, kind, query, item|items, meta, summary }`; no `link` until the
client has a public-enterprise route. Registered only when the flag is on.

## 9. Search integration

None. `q` uses the existing kernel identity search; no new document type.

## 10. Sync/freshness impact on serving

Data changes with the scraper's `load-prod-v2` runs. A new AMEPIP snapshot changes
indicators and invalidates in-flight indicator cursors.

## 11. Wiring

`makePublicEnterprisesModule({ db, identityRepo, enabled })` in
`build-redesign-app.ts` (both entrypoints, in the shared defaults). The flag is read in
`redesign-env.ts` and passed through `redesign-api.ts`, `api.ts`, `build-app.ts` and
`build-plan.ts`. Chronos dev: `k8s/overlays/chronos-dev/configmap-patch.yaml` ships it
`'false'`; it is turned on only after the views are applied and the load qualified.

## 12. Testing

- Unit (`tests/unit/public-enterprises/`): exact decimals, `''` versus null, null
  `textValue`, source availability, bounds and not-found, kept rows without identity,
  bounded name search, GraphQL/MCP equivalence, the kernel cursor (full tuple; CUI,
  filter and snapshot mismatch), disabled with no query.
- Contract (`pnpm test:public-enterprises-contract`, see its README): the real scraper
  DDL, a view-only reader, literal rows, multi-page traversal, stale cursors, privacy
  withdrawal, historical anchors and GraphQL/MCP equivalence.

## 13. Open questions / risks

- A client route for MCP links and pages.
- An entity-360 contributor and a search projection are later work.
- Enabling needs the reader role to read the five views (already covered on
  Chronos dev by `pg_read_all_data`).
