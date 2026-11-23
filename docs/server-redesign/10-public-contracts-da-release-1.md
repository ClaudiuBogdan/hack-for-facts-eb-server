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

- `title`, `description` and the line's `name` and `unit` are restricted until the platform marks them public. The
  per-field flags are `title_public`, `description_public`, `item_name_public` and `item_unit_public`; the owner
  decides field by field. The unit is free text (43,729 distinct values), so it is gated like the names.
- The API reads free text only from the platform's masked columns (SEC-GRANTS-PROC-2211): `title_shown`,
  `item_name_shown` and `item_unit_shown`, and serves each only where its row's flag is also true. The raw `title`,
  `description`, `name` and `unit` columns are never read (the API's grant does not cover them). Purchase
  descriptions are never read at all and are always served withheld.
- Money columns carry at most 2 decimals; the data platform enforces this with a build STOP.
- A field that is not marked public is served as null, with `titleWithheld` / `descriptionWithheld` /
  `nameWithheld` set to `"privacy"`. The SQL never selects the text in that case.
- A field whose `*_shown` column or flag is absent is withheld. `categoryLabel` (the CPV label) is the purchase's
  visible name.

## D6: supplier names (site-wide)

- One source for v3 and the legacy surfaces: the data platform's classification `procurement_v3.supplier_privacy`,
  built by its classifier over every supplier code the platform serves and rewritten in the nightly publish with
  `data_as_of`. The API reads it only through public views (SEC-GRANTS-PROC-2211, owner-approved 2026-11-22):
  - `supplier_disclosure` (`fiscal_code_clean`, `supplier_id`): the disclosed suppliers (public companies). The
    kernel D6 port reads it whole; the rollups join it on `supplier_id`.
  - `da_parties_public` (`source_name`, `party_kind`, `portal_party_id`, `fiscal_code_clean`,
    `fiscal_code_status`, `name_as_written`): every buyer with its code and name (owner, 2026-11-22: buyers are
    shown in full, migration 20261121T090070), and a supplier only when its code is disclosed, with
    `name_as_written` NULL for suppliers. A purchase whose supplier party id is set but has no row here has a
    withheld supplier.
  - `party_public_names` (`fiscal_code_clean`, `registry_name`, `buyer_name_public`, `supplier_name_public`): a
    named supplier's name is its registry name where `supplier_name_public`, looked up by the page's codes only
    (`fiscal_code_clean = any($1)`, never joined or scanned).
- A supplier's name, fiscal code and party id are served only when it has a public party row (and, defensively, a
  valid code) and `supplier_disclosure` is readable in the snapshot. Otherwise it is withheld, so the rule fails
  closed.
- `party_public_names` reads the registry live: a name or privacy change shows on the next read without moving
  `data_as_of` or `registry_as_of`. No answer that carries a supplier name is cached; unfiltered totals grouped by
  supplier are read every time (other unfiltered totals stay cached per `data_as_of`).
- Totals grouped by supplier with no filter, or only a month-aligned finalization range (PROC-AP75), read the
  data platform's `da_rollup_supplier_party_month`: summed per (source_name, supplier party) first, then joined to
  `da_parties_public` per party, grouped as before; the overall line sums the rollup directly. Only while this login
  can read it and `da_release.supplier_party_rollup_for = data_as_of` in the same snapshot; otherwise, and for any
  other filter, the purchases answer as before. On prod (22 Nov, dev API pod, identical answers): unfiltered 60 s
  (a 10 s timeout today) → 2.8 s, 2025 11 s → 1.1 s.
- Unfiltered supplier totals read the all-time table `da_rollup_supplier_party` first (PROC-AP75, the 2 s p95
  gate): one row per party with the four measures and `disclosed`, the D6 named predicate the platform evaluated at
  publish; no codes. Only while `da_release.supplier_party_totals_for = data_as_of` in the same snapshot. `disclosed`
  counts only while `supplier_disclosure` is readable now (else every supplier is withheld); groupCount, the
  withheld and none buckets and the order come from the table; the page's named parties are probed on
  `da_parties_public` (fenced lateral) for their codes, names by code as everywhere. A disclosed page row the view
  does not name is refused as retryable. On prod (identical answers): page 1 2.9 s → 0.28 s (10 runs ≤ 0.29 s),
  the last page 0.5 s. Summed counted values in DA totals print at least cents and
  are never rounded (`13465400.0` → `13465400.00`), so both paths read alike.
- A withheld supplier is `natural_person`, with `name`, `fiscalCode` and `partyId` all null; one person's purchases
  cannot be linked across rows.
- A supplier filter matches only public suppliers, so a sole trader's code cannot be used to list their purchases.
- In totals grouped by supplier, every withheld supplier falls into one `natural_person` group. Purchases that name
  no supplier have their own group (`noSupplier: true`).
- Analysis breakdowns at the DA grain (PROC-B51G): on the v3 grain a `company` supplier bucket carries
  `displayName`, its registry name only where `supplier_name_public`. It is looked up by the answer's company codes
  after the read, never cached, in one snapshot that requires the publication the buckets came from and a readable
  `supplier_disclosure`; a publish or a revoked grant in between refuses the answer retryably ("repeat the
  request"), so no name outlives the D6 state of its bucket. It is null for `natural_person`, for a company whose
  name is not public, and on the ClickHouse D6 path (which refuses DA supplier breakdowns at an explicit DA grain);
  it is absent on other buckets and grains. It is the only name a client may show for a DA supplier bucket (never
  `organizationLabels`, which ignores the flag). A name lookup that fails fails the answer.
- Caching (PROC-VDWQ): every GraphQL answer, GET or POST, that carries a DA supplier name is
  `Cache-Control: no-store`. The resolvers that serve one mark the reply as they do: a release party named as a
  company, a DA supplier bucket's `displayName`, a legacy DA supplier with a name, and a DA records page naming a
  supplier. Answers without one keep their headers. The REST DA routes are `no-store` throughout.
- Buyers are `authority`: the name is always served, the fiscal code only when it is valid.
- The rule lives in `core/da-release.ts` (`isNamedSupplier`). The SQL mirror (`namedSupplierSql` in
  `da-v3-sql.ts`, over the public supplier row `s`) only filters and buckets rows, and the core re-checks every party
  before it is served.
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
- **The privacy check:** `supplier_disclosure` counts as present only when the API's login can read it, so a
  revoked grant withholds everyone. Every legacy read checks the public set again after the data read. If a nightly
  publish withheld a code mid-request, the answer withholds it too (lists and scopes are re-read). The v3 reads
  read the public party view (and the rollups `supplier_disclosure`) in the same snapshot as the data.
- **Server caches:** keyed by publication, with no purge endpoint.
  - The disclosure set, release totals and v3 analysis answers are keyed by `data_as_of`, and also by the privacy
    state (present and readable). The set is reused while `data_as_of` is unchanged, so every write to
    supplier_privacy must move `da_release.data_as_of` in the same transaction. The data platform enforces this with
    the deferred constraint trigger `supplier_privacy_moves_release` (procurement-prod b026b40e2), and refuses
    TRUNCATE, which bypasses row triggers, with BEFORE TRUNCATE statement triggers on supplier_privacy and
    supplier_id_ledger (584139f8). Both are defined in fast-lane `060_da_rollups_tables.sql`; the production
    procurement_v3 migration will carry them too. So no write or TRUNCATE can change the privacy list without moving
    `data_as_of`, short of a superuser disabling triggers (`session_replication_role = replica`) or dropping them.
  - The ClickHouse analysis caches are keyed by build, and D6 is applied on read after them.
  - A publish moves the key; flipping a switch is an environment change, so the pods restart and the in-process
    caches start empty.
- **Fresh final checks:** every check that authorises facts already read asks the disclosure port for a fresh load
  and never joins one that started before the read. When that final check withholds a supplier the request was
  scoped to, the whole scoped page is discarded or re-read (items, totals, facets and cursors), never scrubbed in
  place.
- **Analysis D6 key:** every DA block and records page carries `meta.disclosureKey`: `off`, `unavailable` (everyone
  withheld) or the supplier_privacy publication. Key cached DA analysis by (`buildId`, `disclosureKey`), since the
  analytics build does not move when a nightly publish withholds a supplier. These keys cover codes, counts and
  values, never names: supplier names come from the live registry (`party_public_names`) and can be withdrawn
  without any key moving, so a client never keeps a supplier name beyond the response that carried it. Never cache
  a DA answer whose key is
  `unavailable`, or a release answer with `privacyEnforced` true and `privacyAsOf` null. That is the only state
  that can recur after a named answer (a grant revoked, restored and revoked again), and a page read while access
  was restored can carry it.
- **Every answer that can name a DA supplier carries its key** (`meta.disclosureKey`, client review 10, 19 Nov):
  - analysis: every DA block and records page (above); null on other grains. On the ClickHouse DA grain (v3 off,
    D6 on) the key is the generation's, and an answer whose D6 decision (a supplier scope, a supplier breakdown,
    records) was made under another state is not served under it: a retryable `SERVICE_UNAVAILABLE` (repeat the
    request). Reads that make no D6 decision are unaffected. The scope echo (`canonicalScope`, MCP `query.scope`)
    names a supplier only when the set that lists it public comes from the publication every one of the answer's
    blocks can be keyed by (the request generation and each per-grain source, such as the v3 DA grain); otherwise
    it says `withheld`;
  - release: `ProcurementDaPurchasePage`, `ProcurementDaPurchaseDetail`, `ProcurementDaTotalsAnswer` (GraphQL
    `meta { disclosureKey }`, REST and MCP `meta.disclosureKey`). The key is the snapshot's `dataAsOf` when
    supplier_privacy was readable in it, else `unavailable`. These reads follow the v3 after-read rule: answered only
    if, after the read, the release is unchanged and, when the read could name suppliers, supplier_privacy is still
    readable; otherwise a retryable `SERVICE_UNAVAILABLE` (repeat the request). The status is not settled; it names
    no supplier;
  - legacy: `ProcurementDirectAcquisitionsPage`, `ProcurementDirectAcquisitionDetail` and the supplier-records
    `ProcurementRecordConnection`. The key is the publication of the answer's final, fresh D6 decision (the legacy
    after-read rule), or of the decision that refused or narrowed it up front; `off` while D6 is not enforced;
    `unavailable` when no publication was readable, or when the answer was scrubbed by checks that read different
    states (a publish, or supplier_privacy coming back, between them): such an answer matches neither exactly;
  - the legacy MCP search tool (`search_procurement_direct_acquisitions`) carries `meta.disclosureKey`, chosen as
    for the legacy reads above;
  - every key follows the monotonic rule below.
- **v3 analysis cache:** entries are keyed by build. One statement probes the build and the supplier_privacy grant, so
  a publish cannot fall between them. Every v3 read, cached or not, is answered only if its build is still current
  after the read and, when the read could name suppliers, supplier_privacy is still readable; otherwise the request
  fails as `SERVICE_UNAVAILABLE` ("republished … repeat the request"), never with rows and a key from a publication
  the server already knows is stale. A fill that fails this check is not
  kept. Identical concurrent misses share one read.
- **MCP final check:** `aggregate_procurement` runs a fresh D6 check after the whole answer is built. If it withholds
  the scoped supplier, or comes from another publication than the answer's DA keys, the answer is re-read once (the
  whole-page rule) and echoed as `withheld`. The re-read starts after the check, so its own D6 decisions read a
  publication at least as new: it names the supplier only if that publication lists it public (the check itself may
  have found supplier_privacy unreadable). A supplier public at the check, under the answer's own key, is echoed and
  served as read.
- **Monotonic keys (client contract, root, 19 Nov):** `privacyAsOf` and a dated `disclosureKey` are publication
  timestamps and only move forward. A client keeps the newest it has seen, per surface. It never caches a response
  whose key is older than that, and never re-keys its cache to an older key. The network can deliver an older
  response after a newer one (a request that began before a publish, or a GraphQL operation whose status field
  resolved early), so the server cannot guarantee this order by itself. Inside one pod the server never serves an
  older publication than it already served (an older read withholds everyone and logs), and status reads
  `privacyAsOf` last. A disclosure load is shared only with calls that arrived before it read. Across pods: the
  serving API reads from the primary only, not from read replicas (owner decision, 20 Nov), so no replica freshness
  rule is needed (server issue #80, closed).
- **Legacy detail:** the item's catalogue code is withheld too (typed by the source, outside the loader's scan).
- **Status:** `procurementDaRelease` serves `privacyEnforced` and `privacyAsOf` (the supplier_privacy publication).
  Clients key their caches by (`privacyEnforced`, `privacyAsOf`, `dataAsOf`). `privacyAsOf` is null both when D6 is
  off and when it is on but the table is unreadable, so `privacyEnforced` is part of the key.
- **ClickHouse DA grain under D6 (v3 off or rolled back):** the legacy facts can't group by the supplier rule, so at
  the DA grain routing refuses title search (`q`), supplier geography, supplier breakdowns, supplier concentration and
  distinct suppliers. An unscoped fan-out leaves DA out instead.
- **Boot:** the server refuses `PROCUREMENT_DA_V3_ENABLED=true` without `PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED=true`.
- **Analysis:**
  - v3 DA blocks report `meta.valueBasis: "counted"` and a `finalization_day` date basis;
  - the v3 analysis cache reuses or stores an answer only while the build is current and supplier_privacy is
    readable, checked before the lookup and after the fill;
  - if ClickHouse cannot be read, only the non-DA grains abstain;
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
2. `PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED=true` on the API. Hard gate (root, 22 Nov, DA-009 / PROC-B51G): the API
   serving `displayName` on DA breakdown buckets, and the client naming DA supplier buckets from it alone, are both
   deployed first, as is `no-store` on GraphQL answers that name a DA supplier (PROC-VDWQ).
3. The client build that fails closed on `displayKind` is deployed.
4. Later, after root's production-output audit: `PROCUREMENT_DA_V3_ENABLED=true`.

While the D6 switch is off, legacy DA parties carry `displayKind: null`. A fail-closed client deployed before step 2
therefore shows no DA supplier name at all, companies included (acceptable for a short window on dev only).
Production follows the same order.

## Accepted residuals (root, 18 Nov)

- **Echo across a publish.** A nightly publish that lands between echoing the caller's own scope (`canonicalScope`,
  MCP `query.scope`) and the data read can echo that caller's own supplier code once. Root accepts this: the caller
  supplied the code, so the echo tells them nothing new. The data itself is re-checked after the read.
- **DA fact read failure.** If a procurement_v3 fact read fails after the release pointer has resolved, the whole
  request fails instead of abstaining only the DA block. Root accepts this: it fails closed, as an error rather than
  a leak. (A v3 publication that cannot be read at all abstains the DA grain only.)
- **ClickHouse read failure on a warm generation.** If ClickHouse fails a read after its generation resolved from
  cache, a mixed-grain request fails instead of keeping the healthy v3 DA block. This is the same class as the item
  above: an error, never a leak (this was already the behaviour before release 1). An unreadable generation at the
  start abstains the other grains only.
- **DA supplier rankings during a v3 rollback** are refused, not approximated (see above). The client shows them as
  "unavailable", never as a blank or an error.

## Analysis over publish-time rollups (root, 18 Nov)

Live Postgres is fine for buyer pages but not for supplier or home analytics: 19 of 82 statements took over 5 s, and
two timed out. procurement-prod therefore builds rollups in procurement_v3, in the data_as_of transaction. They are
upserted per key and never deleted (an emptied bucket goes to zero). No rollup holds a fiscal code (root, 18 Nov): a
supplier is `supplier_ref`, the stable, never-reused `supplier_privacy.supplier_id` of a public code. 0 means
withheld and NULL means no supplier. A flip to restricted leaves the old rows zeroed under an unlinkable number.

**The tables.** Every row carries `purchases`, `counted_purchases`, `counted_value` and `symbolic_purchases` by month
(NULL month = undated):

| Table                                | Keys                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `da_rollup_county_month`             | county_code, region                                                                |
| `da_rollup_cpv_month`                | cpv8                                                                               |
| `da_rollup_authority_month`          | authority_cui                                                                      |
| `da_rollup_county_cpv_month`         | county_code, region, cpv8                                                          |
| `da_rollup_authority_cpv_month`      | authority_cui, cpv8 (a buyer's CPV breakdowns; owner, 23 Nov)                      |
| `da_rollup_supplier_month`           | supplier_ref                                                                       |
| `da_rollup_supplier_cpv_month`       | supplier_ref, cpv8                                                                 |
| `da_rollup_authority_supplier_month` | authority_cui, supplier_ref, plus the authority's county_code and region           |
| `da_rollup_distinct`                 | bucket_kind, bucket: distinct_authorities, distinct_public_suppliers, has_withheld |

`da_release` adds the quality columns rows, dated, counted, accepted, with_cpv, with_geo, money, money_dated and
money_geo.

**How the reader uses them** (`da-v3-analysis-source.ts`):

- **One compiler, two forms.** The compiler emits either row-level SQL over `da_purchases` (live) or sum-of-measures
  SQL over the smallest rollup whose keys cover the scope and the dimension. Absent tables are read live, so nothing
  depends on them. A present table is used as soon as the login can read it, filled or not (a login with
  `pg_read_all_data` reads it from the migration on), so a new rollup is registered and deployed only after its fill
  is verified for the serving `data_as_of`; later publishes keep facts, rollups and the release pointer in one
  transaction (`da_rollup_authority_cpv_month`, 23 Nov).
- **No rollup covers:**
  - SIRUTA scopes or breakdowns;
  - counted-value bounds;
  - record pages (the page rows; their total uses a rollup);
  - combinations no table holds (e.g. authority × supplier × CPV).
- **Distinct counts:**
  - for a window-only scope with a month or year bucket aligned to the window, they come from `da_rollup_distinct`,
    where the supplier count is public suppliers plus one if any supplier is withheld (as live);
  - other distinct counts use `count(distinct)` over the covering rollup.
- **Zero rows never count.** Every rollup read filters `purchases > 0`, so a zeroed row never contributes a key, a
  month or a count.
- **D6 again on read.** supplier_ref is joined to `supplier_disclosure` on supplier_id. The code comes from there,
  only while the supplier is disclosed; otherwise the supplier is served as natural_person. A supplier scope looks up
  the disclosed code's id once, so the read uses the rollup's supplier_ref index.
- **Quality** comes from the da_release columns when all nine are readable and non-null, and is measured live
  otherwise. with_geo and money_geo count purchases whose buyer resolves to a public territory (SIRUTA), with or
  without a county, as live does.
- **Buyer geography** is pinned to the publication: `da_buyer_geography` (authority_cui, territorial_siruta_code,
  county_code, region, copied_at) is built from the kernel join in the publish transaction. When it is readable,
  the live reads join it too, so stats and records place a buyer the same way. Without it, live reads join
  today's kernel tables, and a geography-scoped records page counts its total live so the page agrees with
  itself.
- **Distinct suppliers** (window-only) trust da_rollup_distinct, which cannot be re-checked per key on read. It is
  built in the same transaction as supplier_privacy, and the build stops on a restricted key in a non-zero row,
  so a valid publication cannot over-count. An invalid one could add one to a count, but never serves a code.
- **Tests.** The e2e suite builds the rollups from a varied seed with the agreed rules, then requires every
  stats, series, distinct, breakdown, concentration and records answer to equal the live answer. That includes
  zeroed rows under new keys and months, and a restricted code. Mutating either guard fails the suite.
- **Fiscal-code form.** procurement_v3 codes have no leading zeros, while legacy rows and clients may keep them
  (procurement-prod measured this on June 2025). Every code a client sends to a v3 surface is compared without
  leading zeros, and the public-supplier set accepts either form, so a legacy key still matches its public company.
  Zeros drop only while the code is at most 10 digits, a CUI's length. A longer padded string (`0000014399840`) is
  no company code and matches nothing. Every narrowed public set compares the same way (`FiscalCodeSet`). Served
  keys are the platform's form. procurement-prod measured the legacy supplier keys on 19 Nov (35.3M rows): no code
  falls outside `^[0-9]{1,10}$`, so the rule withholds no public company. 1,419 rows (145 codes) are padded within
  10 digits and still match. No CHECK constraint enforces the shape; the loader's transform and this rule do. The
  data-platform serving contract states the same rule (docs f0dbc4fc).
- **Query shapes for the live reads** (procurement-prod's workshop timings, 18–19 Nov):
  - parties come from the security-barrier view `da_parties_public`. A plain join into it is not pushed into the view,
    so it builds the whole view per statement (procurement-prod, 22 Nov: a list page of 100 took 1.5 s). Point reads
    (release list, detail, lookup; v3 records pages) probe each row's buyer and supplier through a lateral subquery
    fenced with `offset 0` (22 ms; a lookup 0.23 ms); whole-table aggregates (totals, quality) keep the plain join.
    A records page without a geography scope is chosen from `da_purchases` alone, ordered and limited, and only its
    rows are probed (a supplier with 514k purchases: 4.7 s, was 10.9 s);
  - a rollup never joins a party view to its rows (PROC-C4HN). A supplier scope matches `supplier_ref` against the id
    `supplier_disclosure` holds for the code; totals and the unknown bucket read the rollup alone. A supplier-keyed
    aggregate (breakdown, concentration, distinct suppliers) sums the scope's rollup rows per `supplier_ref` (and
    bucket) first, then meets the view: one plain hash join for the whole release's unbucketed sums, a fenced
    lateral probe per sum for a scoped or bucketed read. DA v3 reads run with JIT off: the join estimates through
    the barrier views are thousands of times too high, so short reads paid about 220 ms compiling. On prod (22 Nov,
    dev API pod, answers identical to c648184c in 28 of 28 reads): supplier breakdown, all years 6.4 s → 1.2 s,
    2025 1.6 s → 0.4 s; concentration, all years 4.9 s → 1.1 s, 2025 1.2 s → 0.45 s; distinct suppliers by quarter,
    2025 1.1 s → 0.7 s. Scoped reads (an authority, CPV 45) stay at 50–500 ms. Whole-release distincts by quarter
    (a window on quarter boundaries) read `da_rollup_distinct`'s quarter rows when the publication has them
    (PROC-YP8P): all years 7.0 s → 36 ms, identical; a publication without them counts from the facts;
  - a supplier filter is the party-id match alone: the view holds a supplier row only for a disclosed code, and the
    subquery requires a valid status and an equal, non-null code on the same unique party key, so no row probes `s`
    to filter;
  - a buyer or supplier scope filters purchases by `(source_name, party id) in (select … from da_parties_public where
party_kind = … and fiscal_code_status = 'valid' and fiscal_code_clean = $1)`, never on the joined party row
    (buyer CPV breakdowns went from 4–5 s to 0.5 s);
  - records by value page in two phases: first the counted rows with a value (`order by counted_value, purchase_id`,
    served by the `where counted` index), then the rest by id, carrying the offset across. The order is identical
    to `case when counted then counted_value end … nulls last, purchase_id`, and the e2e pages both ways to prove
    it (the largest purchases of a year went from 8.7 s to under 1 ms).
  - every other nulls-last order pages the same way (PROC-AP75): the release list by `finalization_day` or
    `counted_value` and the records date orders. Rows with a key come first, ordered by an index; then rows without
    one, by id; the offset carries across. The keyed-row count, needed only when a page reads none, is capped at the
    offset. A single `desc nulls last` (or `is null` expression) order sorted all 22.6M purchases: on prod (22 Nov)
    the release list by date desc and by value timed out at 10 s and records by date took about 9.7 s. In two
    phases they take 32–490 ms with identical rows; the e2e pages every sort across the boundary against one
    ORDER BY.
  - The indexes these rely on: `da_purchases (counted_value desc, purchase_id desc) where counted`,
    `da_purchases (finalization_day)`,
    `da_parties (source_name, party_kind, portal_party_id)` and `da_parties (party_kind, fiscal_code_clean)`.
- **Gate for the flag.** Before `PROCUREMENT_DA_V3_ENABLED` goes on, the generated statements are re-timed at
  workshop scale, with a target p95 of at most 2 s per page statement.

## Follow-up (after the dev push; none is a leak)

From the narrow check of c0603d3c (gpt-6.2-sol xhigh, rollout 01a1eea5). Root ruled (18 Nov) that errors, latency
and over-withholding go here rather than into another round:

- **Over-withholding after recovery:** an absent-source load that finishes after a successful fresh load replaces it,
  and the empty set is reused for the 60 s absent TTL. Keep the newest observation, and let final checks bypass the
  negative TTL.
- **Load amplification:** concurrent fresh checks each read the full public set for a cold publication. Share the
  full-set read once the publication and readability are verified, and restore the same-set fast path in the legacy
  intersection.
- **v3 cache ownership:**
  - a retired build's lookup can clear the current build's pending fill, which duplicates work;
  - a retired fill can evict a current entry.

  Read the build and the privilege in one statement, and recheck ownership after the last await.

- **v3 fill across privacy states:** a fill read while supplier_privacy was unreadable can be joined or kept after
  access returns, which over-withholds until the next publish. Carry the snapshot's privacy state and require it on
  join and store.
- **disclosureKey precision:** resolved 19 Nov. Every served key is the state the answer's D6 decision was made
  under (above).
- **Warm ClickHouse failure** fails a mixed request (residual above). Make source-read failures abstain per grain.

From the rollup timings (procurement-prod, 5 runs of the b4037b6e page set on the workshop build, 19 Nov). Root ruled
neither blocks the dev push:

- **Cold cache after publish:** the first run after a cold buffer cache takes 6.5 s for SUPPLIER buyerCounty [1/3]
  and 4.0 s for cpvDivision [1/3]. Warm, they take 0.27 s and 0.08 s. Every nightly publish leaves the cache cold.
  Add a warm-up pass after publish: run the page set once, or `pg_prewarm` the rollup tables and their indexes.
  Measure it with 5 runs that start cold.
- **Uncounted-rows fallback on value sorts:** the second phase reads the scope's uncounted rows by `purchase_id`.
  That scan takes up to 3.9 s for the year's 124k rows. Both surfaces stop at row 10,000, so the second phase runs
  only for scopes with fewer than 10,000 valued rows. It cannot run on the home, buyer or large-supplier pages. If a
  small scope with many uncounted rows needs it, add a partial index on `(purchase_id desc) where not counted`
  (procurement-prod).

## Legacy switch (SEC-GRANTS-PROC-2211)

The owner-approved grant gives the API's login no legacy relation (`procurement.*` records, `analysis_generations`,
`etl.load_runs`, `core.organizations`, the legacy ClickHouse facts), except the public CPV labels
(`procurement.cpv_divisions`, `procurement.cpv_codes`). `PROCUREMENT_LEGACY_ENABLED` (default `true`; only `true` or
`false` are accepted) retires the legacy reads before the login loses its broad rights:

- `false`: legacy records and entity-360 procurement presence answer ServiceUnavailable without a query. The legacy
  analysis grains (every grain the DA v3 reader does not answer) read nothing legacy: with DA v3 off they answer
  ServiceUnavailable without a query; with DA v3 on, a request still resolves the DA generation (procurement_v3
  only) and each legacy grain's block abstains with "this grain is unavailable", as when the analytics build
  cannot be read, so a mixed request keeps its DA block. Only the MCP tools `resolve_procurement_filter` and,
  while DA v3 is on, `aggregate_procurement` stay registered. The empty-scope cache is not warmed.
- Unaffected: the CPV reference routes, DA release 1, the v3 DA grain and totals v2.
- A read the grant does not cover (Postgres 42501 on a DA read, ClickHouse 497 on a money build) answers
  ServiceUnavailable, never a database error. The DA v3 geography fallback (kernel `core.*` and `companies_v2`
  tables) is outside the grant; it runs only when `da_buyer_geography` is not readable, which the grant prevents.
- The grants are additive while the login keeps its broad read rights (`pg_read_all_data`); the API's login shares
  one pool with every kernel module, so the narrow login (PRJ-54YB) needs every module's inventory first. Set the
  flag to `false` when the login loses its broad rights, not before (root's GO).

### The legacy DA list (retired on Chronos dev, owner 23 Nov)

`PROCUREMENT_LEGACY_DA_LIST_ENABLED` (default `true`; only `true` or `false` are accepted) retires the legacy
direct-acquisition list alone: GraphQL `procurementDirectAcquisitions` answers ServiceUnavailable ("use
procurementDaPurchases") without a query, and the MCP tool `search_procurement_direct_acquisitions` is not registered.
The list names buyers from the raw authority name, so a buyer the release masks stayed named there (PROC-KR9T); the
release routes (`procurementDa*`) replace it. The list is refused before the resolver validates its arguments, so every
schema-valid request gets the same answer (one GraphQL itself rejects, such as `page: "0"`, is still a 400). The legacy DA detail, every other legacy read and the release are unaffected. It is
`false` on Chronos dev only. The ConfigMap is not hash-named, so the flag takes effect only when the Deployment rolls
to an image that reads it (the CI pin after the feature commit), synced as ConfigMap plus Deployment together.
Rollback is the revert, its CI pin and the same ConfigMap plus Deployment sync; a ConfigMap-only sync leaves running
pods on the old value.

## Pending (data platform)

- **Schema name:** `procurement_v3` is pending the owner's migration. It is named once, in `DA_RELEASE_SCHEMA`.
- **Pending columns:** `listed_now`, `da_items.superseded_at` and the `*_shown` text columns with their flags are
  probed per request, and `supplier_disclosure` by privilege, so the reader works before and after they land.
  `da_parties_public` and `party_public_names` are required: without them a read answers ServiceUnavailable.
- **Decided (owner, 18 Nov):** D6 holds site-wide. The legacy DA surfaces apply the same `supplier_privacy` rule
  behind its own switch (done). The analysis API's DA grain moves to v3: live Postgres first, a
  ClickHouse projection later. Supplier geography is dropped for DA.
