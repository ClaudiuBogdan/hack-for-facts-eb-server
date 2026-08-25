/**
 * Companies module — GraphQL SDL slice (plan §6). All types `Company*`-prefixed
 * (§14.8); extends root `Query` + `type Entity`. The `CompaniesFilter` input is
 * GENERATED from the §7 spec via the kernel `toGraphQLInput(spec)` so REST/GraphQL/
 * MCP never drift. Kernel scalars (`CUI`, `Money`, `Date`, `BigInt`, `SIRUTA`,
 * `JSON`, `PageInfo`, `Entity`) are referenced, never redefined.
 *
 * Lists are connection-only (cursor); the company list is keyset-paginated by the
 * active sort. `totalCount` is BOUNDED (≤10,000) + `totalEstimated` (§14.4) — a
 * large unfiltered list never `COUNT(*)`s 3.99M rows.
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { companiesFilterSpec } from '../../core/filters.js';

const filterInput = toGraphQLInput(companiesFilterSpec);

const objectsAndQuery = /* GraphQL */ `
  enum CompanySort {
    NAME
    REGISTRATION_DATE
    CUI
  }
  enum CompanyResolveDim {
    NAME
    REGNUM
    CAEN
    COUNTY
  }
  enum CompanyMatchConfidence {
    SAFE
    UNMATCHED
  }
  enum CompanyGroupBy {
    COUNTY
    STATUS
    CAEN_DIVISION
  }

  type CompanyStatus {
    code: String!
    label: String!
  }
  type CompanyStatusFlag {
    code: String!
    label: String
  }

  type CompanyTerritory {
    sirutaCode: SIRUTA
    uatName: String
    countyName: String
    matchConfidence: CompanyMatchConfidence!
  }

  "address.county = display county from the registry source; deliberately distinct from CompanyTerritory.countyName (SIRUTA-matched)."
  type CompanyAddress {
    display: String!
    county: String
    locality: String
  }

  type CompanyFiscal {
    vatPayer: Boolean
    "= is_inactive. The ONLY fiscal-inactivity boolean. NOT operating-active; is_active (its exact complement) is intentionally dropped (§13-R1)."
    declaredFiscallyInactive: Boolean
    mainCaenCode: String
    registeredName: String
    asOf: Date
  }

  type CompanyCaenActivity {
    code: String!
    rev: String!
    label: String
    source: String!
  }
  "Restricted in companies_v2; public profile returns an empty list until an authorized surface is added."
  type CompanyRepresentative {
    name: String!
    role: String!
  }
  type CompanyEuBranch {
    branchName: String
    country: String
    euid: String
    fiscalCode: String
  }

  type CompanyFinancialYear {
    year: Int!
    "Publisher of this statement year: 'anaf' (FY2019+) or 'mfp' (FY2008–2018 bulk). The seam is CHECK-enforced at 2019 — clients should mark it when charting across it."
    sourceSystem: String!
    turnover: Money
    netProfit: Money
    netLoss: Money
    "bigint as string — source outliers overflow int4; never a JS number."
    employees: BigInt
    "The 20 typed metrics."
    summary: JSON!
    "Nullable in v2 profiles; canonical statement lines live in companies_v2.financial_indicators."
    lines: JSON
  }

  "A warn-only data-quality flag on one (cui, year) statement. Advisory: qualifies a figure, never suppresses one."
  type CompanyFinancialQualityFlag {
    year: Int!
    flagCode: String!
    metricName: String!
    "'info' | 'review' | 'warning' today; open domain (kept String so a new upstream class cannot break an advisory surface)."
    severity: String!
    numericValue: Money
    thresholdValue: Money
  }

  """
  Flags + the MEASURED corpus-wide assessment coverage. Absence semantics are
  load-bearing: no flag for a year INSIDE [assessedYearFrom, assessedYearTo]
  means checked-and-clean; a year OUTSIDE the range was never assessed (today
  FY2008-2018: the quality lane last ran 2026-06-30, before the MFP backfill
  landed). Render out-of-range years as "not yet assessed", never as clean.
  """
  type CompanyFinancialQualityAssessment {
    assessedYearFrom: Int
    assessedYearTo: Int
    "Watermark of the last quality-lane run (max created_at, date)."
    assessedAt: Date
    flags: [CompanyFinancialQualityFlag!]!
  }

  type CompanyFinancialTrajectory {
    fromYear: Int
    toYear: Int
    turnoverDelta: Money
    netResultDelta: Money
    employeesDelta: BigInt
  }

  type CompanyFinancials {
    years: [CompanyFinancialYear!]!
    latest: CompanyFinancialYear
    trajectory: CompanyFinancialTrajectory
  }

  type CompanyAsOf {
    onrc: Date
    anaf: Date
  }

  "Public money RECEIVED (company = payee). Kernel FlowsRepo (grain-gated). Never mixes registry + flow grains."
  type CompanyPublicMoney {
    totalRon: Money!
    flowCount: Int!
    "Per-(year, flowType) breakdown; year is populated (flow_year)."
    byYear: [CompanyPublicMoneyYear!]!
    "Per-flowType rollup (year-agnostic)."
    byFlowType: [CompanyPublicMoneyFlowType!]!
    topPayers: [CompanyPublicMoneyPayer!]!
  }
  type CompanyPublicMoneyYear {
    year: Int
    flowType: String!
    totalRon: Money!
    count: Int!
  }
  type CompanyPublicMoneyFlowType {
    flowType: String!
    totalRon: Money!
    count: Int!
  }
  type CompanyPublicMoneyPayer {
    cui: CUI
    name: String
    totalRon: Money!
    count: Int!
  }

  type Company {
    cui: CUI!
    orgId: BigInt!
    name: String!
    legalForm: String
    codInmatriculare: String
    registrationDate: Date
    registrationDatePresent: Boolean!
    headlineStatus: CompanyStatus
    statusFlags: [CompanyStatusFlag!]!
    territory: CompanyTerritory
    address: CompanyAddress!
    fiscal: CompanyFiscal
    caenActivities: [CompanyCaenActivity!]!
    "Public representative names are withheld until the v2 restricted person data has an access-gated API path."
    representatives: [CompanyRepresentative!]!
    financials: [CompanyFinancialYear!]!
    "Warn-only quality flags + measured assessment coverage; lazily resolved."
    financialQualityAssessment: CompanyFinancialQualityAssessment!
    euBranches: [CompanyEuBranch!]!
    "Public money received (payee), via the kernel FlowsRepo. Null when none."
    publicMoney: CompanyPublicMoney
    asOf: CompanyAsOf!
  }

  "Lean per-entity company summary (Entity.company / entity-360). NOT the full Company list/profile shape — it carries only the cross-source slice the contributor returns."
  type CompanyEntitySummary {
    cui: CUI!
    name: String!
    legalForm: String
    headlineStatus: CompanyStatus
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    registrationDate: Date
    registrationDatePresent: Boolean!
    territory: CompanyTerritory
    latestFinancial: CompanyFinancialYear
    asOf: CompanyAsOf!
  }

  type CompanyResolveHit {
    dim: CompanyResolveDim!
    value: String!
    label: String!
    cui: CUI
    confidence: Float
  }
  type CompanyCaenHit {
    code: String!
    rev: String!
    label: String
  }

  type CompanyGroupCount {
    key: String!
    label: String
    count: Int!
  }
  type CompanyCoverage {
    territoryMatched: Int
    territoryUnmatched: Int
    note: String!
  }
  type CompanyCountyProfile {
    groupBy: CompanyGroupBy!
    groups: [CompanyGroupCount!]!
    denominator: Int!
    coverage: CompanyCoverage!
  }

  "Landing aggregate for the /companies hub. SERVED FROM CACHE (6h TTL, stale-while-revalidate): the three underlying scans cost ~30s together, so this is never computed on a request path. computedAt is the instant the legs actually ran, which may be hours old."
  type CompanyHubStats {
    "Every company on the CUI spine."
    totalCompanies: Int!
    "Companies in ONRC lifecycle status 1048 (funcțiune)."
    activeCompanies: Int!
    "Full status breakdown, count-desc."
    statusMix: [CompanyGroupCount!]!
    "Top 10 counties among ACTIVE companies, count-desc. Excludes the (none) bucket — companies with no registry county; see coverage."
    topCounties: [CompanyGroupCount!]!
    "CAEN division breakdown among ACTIVE companies, count-desc. Every key is exactly 2 digits; the empty-code bucket is excluded."
    caenDivisions: [CompanyGroupCount!]!
    "Territory coverage of the ACTIVE population."
    coverage: CompanyCoverage!
    "ISO-8601 instant the legs were computed."
    computedAt: String!
  }

  "A lean company list row (the connection node). NOT the full Company profile — list pages never fan out the 8 per-CUI tables. Fetch the full Company via company(cui)."
  type CompanyListItem {
    cui: CUI!
    orgId: BigInt!
    name: String!
    legalForm: String
    headlineStatus: CompanyStatus
    "Display county from the company registry source."
    county: String
    vatPayer: Boolean
    declaredFiscallyInactive: Boolean
    registrationDate: Date
    registrationDatePresent: Boolean!
  }

  type CompanyEdge {
    node: CompanyListItem!
    cursor: String!
  }
  "totalCount is bounded ≤10,000; totalEstimated flags the cap (§14.4)."
  type CompanyConnection {
    edges: [CompanyEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
    totalEstimated: Boolean!
  }

  extend type Query {
    "Full company profile by CUI (registry + fiscal + financials + caen + reps + flags + public money)."
    company(cui: CUI!): Company
    "Filterable company list. q (name) resolves via Meili first, then hydrates by CUI; connection-only. Nullable: an error isolates to this field instead of nulling the whole response (audit H2)."
    companies(
      filter: CompaniesFilter
      q: String
      sort: CompanySort = NAME
      first: Int = 20
      after: String
    ): CompanyConnection
    "Full financials series + computed latest + trajectory."
    companyFinancials(cui: CUI!): CompanyFinancials
    "Resolve free text to a filter value: name→CUI (Meili), regnum→CUI list, caen-label→code, county→canonical. Nullable for per-field error isolation (audit H2)."
    companyResolve(dim: CompanyResolveDim!, q: String!, limit: Int = 10): [CompanyResolveHit!]
    "Count-ranked county/status/CAEN-division profile. groupBy=COUNTY requires a selective filter. Nullable for per-field error isolation (audit H2)."
    companyCountyProfile(
      filter: CompaniesFilter
      groupBy: CompanyGroupBy = COUNTY
    ): CompanyCountyProfile
    "Cached landing aggregate for the /companies hub (totals, status mix, top counties, CAEN divisions). Nullable for per-field error isolation (audit H2)."
    companyHubStats: CompanyHubStats
  }

  extend type Entity {
    "Company summary for this entity by CUI (link-not-merge; via the cross-source contributor). Lean slice, not the full Company profile."
    company: CompanyEntitySummary
  }
`;

export const companiesTypeDefs = `${objectsAndQuery}\n\n${filterInput}`;
