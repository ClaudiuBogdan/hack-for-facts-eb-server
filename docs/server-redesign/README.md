# Server Redesign — Module-per-Source over a Shared Kernel

Plans for a from-scratch rebuild of the server's data-source modules on the `dev`
branch, served from the production database `transparenta_prod` (griffin,
`transparenta-eu-etl-prod`). It supersedes the monolithic `unified` exploration
module (preserved on `feat/unified-explorer`) with **one module per data source
over a shared kernel**, each exposing **REST + GraphQL + MCP**.

Authored 2026-06-16 by an orchestrated fleet: one planning subagent per data
source (each grounded in the live prod schema + scrapper migrations + per-source
NOTES, each adversarially self-reviewed), over a single binding foundation
contract, then reconciled in a cross-plan consistency pass.

## How to read these docs (order matters)

1. **[`00-foundation-shared-kernel.md`](00-foundation-shared-kernel.md)** — the
   **binding contract**. Topology, kernel contracts (identity/territory/flows/
   search/ask), error model, pagination, the filter-spec pipeline, scalar table,
   cursor envelope, grain gate, structural privacy, GraphQL federation, MCP
   conventions, wiring, testing, the §12 plan template, and the §14/§15 amendments.
   Read this first; every source plan conforms to it.
2. **This README** — the cross-plan **reconciliation log** (binding resolutions),
   the **dependency matrix**, **scrapper prerequisites**, and **open decisions for
   the user**. Read second.
3. **`01`–`12`** — the per-source module plans. Each follows the §12 template
   (13 sections): summary/data-status, schema→model, repo ports, usecases, REST,
   GraphQL, filters, MCP, search, sync/freshness, wiring, testing, risks.

The live prod schema each plan is grounded in is in
[`_prod-schema/`](_prod-schema/) (`schema.table<TAB>column<TAB>type`, budget
partition children excluded).

## Module index

Decisions locked by the user (2026-06-16): plans in the server repo; **one plan
per data source**; **module-per-source + shared kernel**; **full REST + GraphQL +
MCP** per module.

| # | Source | Prod schema | Status | Plan |
|---|--------|-------------|--------|------|
| — | **shared kernel** | `core`, `flows`, `search` | foundation | [`00`](00-foundation-shared-kernel.md) |
| 01 | reference (ins + mfin + public-entities) | `core` | live (hub overlaps kernel) | [`01`](01-reference.md) |
| 02 | budget (budget-official + anaf-extranet) | `budget`, `budget_staging` | live (heavy/partitioned) | [`02`](02-budget.md) |
| 03 | private-companies | `companies` | live (3.98M CUI spine) | [`03`](03-private-companies.md) |
| 04 | parliament | `parliament` | live | [`04`](04-parliament.md) |
| 05 | portal-legislativ | `legal` (acts) | live — **owns `legal` module skeleton** | [`05`](05-portal-legislativ.md) |
| 06 | monitorul-oficial | `legal` (mo_*) | live — **extends `legal` skeleton** | [`06`](06-monitorul-oficial.md) |
| 07 | pnrr | `pnrr` | live (most complete prior art) | [`07`](07-pnrr.md) |
| 08 | judicial-cases | `justice` | live — **privacy-critical** | [`08`](08-judicial-cases.md) |
| 09 | ngos | `ngo` (absent) | **forward-looking** — ships disabled | [`09`](09-ngos.md) |
| 10 | public-contracts | `procurement` | live (17M+ rows, heavy) | [`10`](10-public-contracts.md) |
| 11 | primarii-transparency | `primarii_transparency` | live (DDL recent; some tables empty) | [`11`](11-primarii-transparency.md) |
| 12 | wikipedia-local-politics | `local_politics` (absent) | **forward-looking** — raw-only, non-authoritative | [`12`](12-wikipedia-local-politics.md) |

**v1-deliverable now:** 01–08, 10, 11 (10 modules, grounded in live data). **Not
v1 (ship feature-flag-disabled, gated on a scrapper data slice):** 09 (ngos), 12
(wikipedia-local-politics).

## Architecture in one paragraph

`src/modules/shared/` is the kernel: the CUI identity hub (`core.organizations`),
the SIRUTA territory hub (`core.territories`), the money-flow graph
(`flows.money_flows`), hybrid search (Meili + OpenSearch + `search.documents`,
semantic per-domain-gated), the cross-source `ask`/entity-360 usecases over a
**source-contributor registry**, the shared error/pagination/cursor/scalar
contracts, the **filter-spec pipeline** (one `CollectionFilterSpec` → derives REST
TypeBox + GraphQL input + compiles to parameterized SQL + a canonical filter hash
shared by cache key, cursor, and tri-surface equivalence), and the shared clients/
middleware. Each `src/modules/<source>/` is hexagonal (`core/` ports+usecases pure;
`shell/` Kysely repo + REST + GraphQL slice + MCP tools), depends only on the
kernel, never on another source module, and is **read-only** over the serving DB.
GraphQL is in-process schema-stitched (each module extends root `Query` and the
`Entity` join type via its contributor); REST is `/api/v1/<domain>/`; MCP tools
wrap the same usecases.

---

## Reconciliation log (BINDING resolutions)

The consistency pass found the 13 plans **highly coherent** — every plan consumes
the kernel filter pipeline, contributor registry, cursor encoder, and scalar table
without inventing its own. These are the resolved cross-plan items (all folded into
`00` §14/§15; recorded here as the canonical decision log):

| # | Item | Resolution |
|---|------|------------|
| R1 | **doc_type names** were stale in the contract | Corrected to live: MO = `mo_act` (not `mo_publication`); portal sections = `portal_section`; **no `pnrr_payment` doc_type** (per-payment docs excluded); PNRR uses entity/announcement/acquisition/contractor/measure. Full list in `00` §4.5. |
| R2 | **GraphQL namespacing vs kernel base types** | §14.8 "always prefix" applies to *module-owned* types only. Kernel `shared/core` types (`Entity`, `Organization`, `Territory`, `MoneyFlow`, `Document`, `PageInfo`, scalars) are reused un-prefixed and never re-declared. (`LegalAct` is portal-owned → stays `Legal*`.) |
| R3 | **`SourcePresence`/`EntityProfileSlice` shape** unspecified (every contributor assumed a different one) | Canonical **open** shapes specified in `00` §4.4: common fields + a per-source `attrs`/`data` payload. Old fixed boolean record retired. GraphQL `Entity.<source>` resolvers call the same `contributor.profileSlice` (tri-surface parity). |
| R4 | **Search capability** can't be one global boolean | Per-domain `SearchCapabilities` slots (`00` §14.5): `legal` semantic is LIVE (HNSW exists); `judicial` is policy-OFF even if pgvector lands (person-leak audit pending); all others OFF (no vector column). |
| R5 | **CUI→territory** needed but `TerritoryRepo` is SIRUTA-keyed | New kernel `IdentityRepo.territoryForCui(cui)` (`00` §15.3). Until it ships, the CUI-only modules' (11, 12) geo filters are capability-gated, not silently wrong. |
| R6 | **`act_id → LegalAct` cross-module resolution** (04 + 08 need it; §2 forbids importing the legal module) | Kernel owns a `LegalActByIdLoader` port; the `legal` module (05) provides the implementation (`findActsByIds`) and registers it; it tolerates dangling `target_act_id` (returns `null` + status, never errors). `00` §15.4. |
| R7 | **legal module 05↔06** field-set + contributor-count mismatch | ONE `makeLegalModule` (portal-owned skeleton + `LegalAct` base + `LegalRepoBase` + shared `act_type`/`issuer`/`domain`/`year` filters); MO contributes `makeMonitorulSurface`. MO extends `LegalAct` with the **gazette field set** (`gazettePublications`/`gazetteStatusEvents`/`gazetteInEdges`) — portal permits the multi-field extension. Module registers exactly **one** contributor (`monitorul-oficial`); portal registers none in v1. Fixed in both plans + `00` §9. |
| R8 | **Money nullability** | `Money` is nullable where the column is (PNRR amounts, procurement values) — GraphQL uses `Money` not `Money!` there. `00` §15.5. |
| R9 | **Array-typed filter fields** | Compile to membership (`@>`/overlap), not trigram substring (reference `tags`, legal `domains`). `00` §15.6. |
| R10 | **Name folding** | `unaccent` is NOT installed and C-locale `lower()` doesn't fold RO diacritics, and `core.organizations.name` has no trigram index → kernel name search is Meili-primary with a bounded pg fallback folded in TS. `00` §15.7. |
| R11 | **Grain gate (§14.6)** | Verified COMPLIANT across budget/procurement/pnrr/companies — source-native top-N/HHI/concentration come from each source's own rollups; only the unified entity-360 flow summary uses `flows.money_flows`; no plan mixes grains in one number. |

---

## Cross-plan dependency matrix

| Plan | Depends on | For |
|------|-----------|-----|
| all 01–12 | kernel `IdentityRepo` (§4.1) | CUI resolution / `Entity` join / name→CUI |
| 01,02,03,07,08,10,11,12 | kernel `TerritoryRepo` (§4.2) + `territoryForCui` (R5) | SIRUTA/county/region/population filters |
| 02,03,07,10 | kernel `FlowsRepo` (§4.3) | cross-source flow summary / public-money-as-payee (grain gate) |
| all | kernel filter pipeline + cursor encoder (§14.2/§14.3) | derive REST/GraphQL/MCP filters + pagination + `fhash` |
| all w/ contributor | kernel `SourceContributor` registry + open `SourcePresence`/`EntityProfileSlice` (R3) | entity-360 fan-out |
| **04 → 05**, **08 → 05** | `LegalActByIdLoader` (kernel port, 05 impl — R6) | bill↔law / case-legal-ref resolution, dangling-tolerant |
| **06 → 05** | legal skeleton: `makeLegalModule`, `LegalAct`, `LegalRepoBase`, shared filters (R7) | MO extends, never redefines |
| **05 ← 06** | `mo_act_publications.act_id` FK (authoritative join, not the typed `mo_part/number/date` columns) | `LegalAct` gazette extension |
| 02,10 → 01 | reference's `public_entity` + `territory` resolve dimensions | buyer-institution / territory filter resolution (don't fork) |
| 07 → 03 | companies registry present | `hubs=[companies]` on PNRR entity links |
| 12 → 11 (via kernel) | UAT-360 by CUI+SIRUTA | composed in kernel usecase, never module import |
| 09 → 03 + scrapper | `kind='ngo'` overlay + `ngo.*` schema | NGO native surface (BLOCKED) |
| all → scrapper `search` lane | `search.documents` population | search integration (server reads only) |

**Critical path:** the kernel `SourcePresence` shape (R3) blocks every contributor;
`LegalActByIdLoader` (R6) blocks 04 + 08; the 05 legal skeleton blocks 06;
`territoryForCui` (R5) blocks 11/12 geo.

---

## Scrapper-side prerequisites (server is read-only)

**Blocking (module/feature can't ship):**

1. `ngo.*` serving schema + `kind='ngo'` link — gates **all of module 09**.
2. `local_politics.*` serving schema + promotion slice — gates **all of module 12**.
3. `unaccent` not installed in `transparenta_prod` — resolve via loader-normalized
   columns (or kernel TS-side folding); affects 03 county filter + kernel name search.
4. kernel `territoryForCui` resolver (kernel/contract task, R5) — gates 11/12 geo.

**Non-blocking (module ships degraded / capability-gated):**

5. `core.organization_identifiers(org_id)` index (PK is `(scheme,value)`) — regnum
   lookup seq-scans 8.07M; 01 stays cursor+capped+cached until added.
6. `legal.acts(status, in_degree desc, act_id)` index — **recommended pre-launch**
   (05 R1 default sort is guaranteed day-one, not earned-if-slow).
7. `search.documents` projection population for deferred doc_types (`budget_*`,
   `company`, `judicial_case` [must carry the publishable gate — cross-repo privacy
   invariant], `local_politics_council`).
8. budget `flows.money_flows` projection (none yet) — budget entity-360 is
   summary-only for v1 (acceptable).
9. earned composite indexes (MO issue/publication, companies county+turnover,
   parliament control_items) — deferred per the no-speculative-index rule.
10. `etl.load_runs`/`system_control` serving-role grant for loader-version
    watermarks — else all modules stay TTL-only (documented interim).
11. `bgc_official_facts`/`quarterly_allocations` empty (budget extract defect) —
    budget-official endpoints capability-gated.

---

## Open decisions for the user

**P1 — change kernel/schema shape (resolve before coding):** all five are folded
into `00` as recommendations; confirm or redirect.

1. `SourcePresence`/`EntityProfileSlice` open shape (R3) — confirm (blocks every contributor).
2. Per-domain `SearchCapabilities` slots (R4) — confirm (blocks legal semantic + judicial posture).
3. Kernel `territoryForCui` (R5) — approve adding it.
4. §14.8 kernel-base-type prefix exemption (R2) — ratify.
5. **NGO kind-collision strategy** — a CUI can be both `company` and `ngo`; a blind
   `kind='ngo'` upsert overwrites company-kind (merge-by-mutation, forbidden).
   Recommend NGO-ness as an additive identifier / `attrs.is_ngo` flag, not a `kind`
   overwrite. *Needs your call before the scrapper ngo migration.*
6. **Promote non-authoritative Wikipedia data to serving at all?** (module 12) — or
   keep raw-only / a flagged client overlay. If no, 12 is descoped.

**P2 — product/precision (per source):** judicial publication fork + person-name
display + `solution` exposure (08, all default to redaction — need product/legal
sign-off); parliament cohesion cap (500 votes) + `comun` chamber handling (04);
procurement DA bare-walk window cap + contract spend-ranking suppression (10);
companies "no global top-by-turnover" for v1 (03); reference website/contacts
projection + INS scope (01); primarii↔wikipedia overlap handling (11).

**P3 — infra (recommend, not blocking):** add the two pre-launch indexes (legal
`in_degree`, organization_identifiers `org_id`); verify `etl.load_runs` grant.

---

## Status & next steps

- ✅ All 13 plans written, self-reviewed, cross-plan reconciled, foundation amended.
- ▶ **Next:** user decisions P1 (and P2 where relevant), then implement the kernel
  first (`shared/`), then the v1 modules (01–08, 10, 11) one slice at a time
  (repo → REST → GraphQL → MCP → tests), then the two forward-looking modules once
  their scrapper data lands.
- These are planning documents only; no server code was written. The plans live on
  `dev` (uncommitted) — commit when reviewed.
