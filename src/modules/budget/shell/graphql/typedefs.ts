/**
 * Budget module — GraphQL SDL slice (plan §6). All types `Budget*`/`Commitment*`-
 * prefixed (§14.8); extends root `Query` + `type Entity`. Filter inputs are
 * GENERATED from the §7 specs via the kernel `toGraphQLInput(spec)` so the
 * surfaces never drift. Clean enums (mapped to partition literals at the repo).
 *
 * Fact lists are Relay connections (cursor, no COUNT on 126M rows). Rankings are
 * bounded top-N lists with `estimatedTotal` (not cursor — top-N by definition).
 * Capability-gated lists (reports/official/dimensions) return a `*Gated` wrapper
 * carrying `caveats` so an empty upstream load never 404s.
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import {
  budgetApprovedFactFilterSpec,
  budgetCommitmentFactFilterSpec,
  budgetFactFilterSpec,
  budgetRankingFilterSpec,
  budgetReportFilterSpec,
} from '../../core/filters.js';

const filterInputs = [
  budgetFactFilterSpec,
  budgetCommitmentFactFilterSpec,
  budgetRankingFilterSpec,
  budgetReportFilterSpec,
  budgetApprovedFactFilterSpec,
]
  .map((spec) => toGraphQLInput(spec))
  .join('\n\n');

const objectsAndQuery = /* GraphQL */ `
  enum BudgetReportType {
    EXECUTION_DETAILED
    EXECUTION_AGG_PRINCIPAL
    EXECUTION_AGG_SECONDARY
  }
  enum BudgetCommitmentReportType {
    COMMITMENT_AGG_PRINCIPAL
    COMMITMENT_AGG_SECONDARY
    COMMITMENT_DETAILED
  }
  enum BudgetAccountCategory {
    INCOME
    EXPENSE
  }
  enum BudgetFrequency {
    MONTH
    QUARTER
    YEAR
  }
  enum BudgetNormalization {
    TOTAL
    TOTAL_EURO
    PER_CAPITA
    PER_CAPITA_EURO
    PERCENT_GDP
  }
  enum BudgetRankingMetric {
    INCOME
    EXPENSE
    BALANCE
  }
  enum BudgetEntityRankingSort {
    AMOUNT
    PER_CAPITA
    ENTITY_NAME
    ENTITY_TYPE
    POPULATION
    COUNTY
  }
  "Commitment metrics present at every MV frequency (the safe common subset)."
  enum BudgetCommitmentMetric {
    credite_angajament
    receptii_totale
    plati_trezor
    plati_non_trezor
  }
  enum BudgetLineItemSortKey {
    LINE_ORDER
    AMOUNT_DESC
    AMOUNT_ASC
  }
  enum BudgetResolveDim {
    entity
    territory
    functional
    economic
  }

  "A commitment metric family (ytd / monthly / quarterly cumulative + the latest snapshot)."
  type BudgetCommitmentMetricValue {
    ytd: Money
    monthly: Money
    quarterly: Money
    latest: Money
  }

  "A single execution line item (the pruned fact grain; year+reportType+accountCategory required to fetch)."
  type BudgetExecutionLineItem {
    executionLineItemId: ID!
    reportId: ID!
    reportingYear: Int!
    reportingMonth: Int!
    quarter: Int
    entityCui: CUI!
    mainCreditorCui: CUI
    reportType: BudgetReportType!
    accountCategory: BudgetAccountCategory!
    budgetSectorId: Int!
    expenseType: String
    functionalCode: String!
    functionalName: String
    economicCode: String
    economicName: String
    fundingSource: String
    fundingSourceId: Int!
    programCode: String
    ytdAmount: Money!
    monthlyAmount: Money!
    quarterlyAmount: Money
    isMonthly: Boolean!
    isQuarterly: Boolean!
    isYearly: Boolean!
    anomaly: String
    "Lazy cross-source entity by CUI (via the kernel DataLoader)."
    entity: Entity
  }

  "A commitment (angajamente) line item. Never summed with execution facts (grain gate)."
  type BudgetCommitmentLineItem {
    commitmentLineItemId: ID!
    reportId: ID!
    reportingYear: Int!
    reportingMonth: Int!
    quarter: Int
    entityCui: CUI!
    mainCreditorCui: CUI
    reportType: BudgetCommitmentReportType!
    budgetSectorId: Int!
    functionalCode: String!
    functionalName: String
    economicCode: String
    economicName: String
    fundingSource: String
    fundingSourceId: Int!
    crediteAngajament: BudgetCommitmentMetricValue!
    limitaCreditAngajament: BudgetCommitmentMetricValue!
    crediteBugetare: BudgetCommitmentMetricValue!
    crediteAngajamentInitiale: BudgetCommitmentMetricValue!
    crediteBugetareInitiale: BudgetCommitmentMetricValue!
    crediteAngajamentDefinitive: BudgetCommitmentMetricValue!
    crediteBugetareDefinitive: BudgetCommitmentMetricValue!
    crediteAngajamentDisponibile: BudgetCommitmentMetricValue!
    crediteBugetareDisponibile: BudgetCommitmentMetricValue!
    receptiiTotale: BudgetCommitmentMetricValue!
    platiTrezor: BudgetCommitmentMetricValue!
    platiNonTrezor: BudgetCommitmentMetricValue!
    receptiiNeplatite: BudgetCommitmentMetricValue!
    isMonthly: Boolean!
    isQuarterly: Boolean!
    isYearly: Boolean!
    anomaly: String
    entity: Entity
  }

  "Entity×period execution summary (from the MVs; balance = income − expense)."
  type BudgetEntitySummary {
    entityCui: CUI!
    mainCreditorCui: CUI
    reportType: BudgetReportType!
    year: Int!
    month: Int
    quarter: Int
    totalIncome: Money!
    totalExpense: Money!
    budgetBalance: Money!
  }

  "Entity×period commitment summary (from the MVs; monthly grain carries a reduced metric set)."
  type BudgetCommitmentSummary {
    entityCui: CUI!
    mainCreditorCui: CUI
    reportType: BudgetCommitmentReportType!
    year: Int!
    month: Int
    quarter: Int
    crediteAngajament: Money
    limitaCreditAngajament: Money
    crediteBugetare: Money
    crediteAngajamentInitiale: Money
    crediteBugetareInitiale: Money
    crediteAngajamentDefinitive: Money
    crediteBugetareDefinitive: Money
    crediteAngajamentDisponibile: Money
    crediteBugetareDisponibile: Money
    receptiiTotale: Money
    platiTrezor: Money
    platiNonTrezor: Money
    receptiiNeplatite: Money
  }

  "A normalized time-series point (amount already normalized per the requested mode)."
  type BudgetSeriesPoint {
    year: Int!
    month: Int
    quarter: Int
    periodLabel: String!
    amount: Money!
  }

  "A ranked entity (MV path + normalization factor applied to MV sums)."
  type BudgetRankedEntity {
    entityCui: CUI!
    entityName: String
    reportType: BudgetReportType!
    year: Int!
    amount: Money!
    perCapita: Money
    population: Int
    countyCode: String
    countyName: String
    entityType: String
    territoryId: Int
    entity: Entity
  }

  type BudgetEntityRankingPageInfo {
    totalCount: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  type BudgetEntityRankingPage {
    nodes: [BudgetRankedEntity!]!
    pageInfo: BudgetEntityRankingPageInfo!
  }

  type BudgetRankedCommitmentEntity {
    entityCui: CUI!
    entityName: String
    reportType: BudgetCommitmentReportType!
    year: Int!
    amount: Money!
    entity: Entity
  }

  "A classification aggregate row (economicCode null is a real bucket — un-coerced)."
  type BudgetAggregatedRow {
    functionalCode: String!
    functionalName: String
    economicCode: String
    economicName: String
    amount: Money!
    lineCount: Int!
  }

  type BudgetCountyHeatmapPoint {
    countyCode: String!
    countyName: String
    countyEntityCui: CUI
    year: Int!
    amount: Money!
    perCapita: Money
    population: Int
    entityCount: Int!
  }

  type BudgetUatHeatmapPoint {
    territoryId: Int!
    entityCui: CUI!
    uatName: String!
    sirutaCode: SIRUTA
    countyCode: String
    countyName: String
    region: String
    year: Int!
    amount: Money!
    perCapita: Money
    population: Int
  }

  type BudgetReport {
    reportId: ID!
    entityCui: CUI!
    entityName: String
    reportType: String!
    mainCreditorCui: CUI
    reportDate: Date
    reportingYear: Int!
    reportingPeriod: String!
    budgetSectorId: Int
    fileSource: String
    downloadLinks: [String!]!
    entity: Entity
  }

  type BudgetClassification {
    code: String!
    name: String
  }
  "Kernel budget-sector catalog entry (the legacy BudgetSector type keeps its name on the legacy root, design 13 §3)."
  type BudgetSectorCatalogEntry {
    sectorId: Int!
    sectorDescription: String
  }
  type BudgetFundingSource {
    sourceId: Int!
    sourceCode: String
    sourceDescription: String
  }

  type BudgetApprovedFact {
    factId: ID!
    budgetYear: Int!
    measureYear: Int
    budgetComponent: String
    functionalCode: String
    economicCode: String
    programCode: String
    label: String
    measureKind: String
    amountValue: Money
    unit: String
  }

  type BudgetVsExecutionRow {
    componentKey: String
    section: String
    lineItemKey: String
    lineItemLabel: String
    periodYear: Int
    budgetYear: Int
    executionAmountRon: Money
    approvedAmountRon: Money
    deltaAmount: Money
    comparisonBasis: String
  }

  "A name→value discovery hit (the Entity Resolution Gate output)."
  type BudgetResolveMatch {
    dim: BudgetResolveDim!
    value: String!
    label: String!
    hint: String
    score: Float
    ambiguous: Boolean!
  }

  "Freshness: latest loaded year + latest COMPLETE year (12 months) for safe defaults."
  type BudgetAsOf {
    latestLoadedYear: Int!
    latestCompleteYear: Int!
    refreshedAt: DateTime
  }

  # ── Relay connections (same cursor as the kernel; no COUNT) ──
  type BudgetExecutionLineItemConnection {
    edges: [BudgetExecutionLineItemEdge!]!
    pageInfo: PageInfo!
  }
  type BudgetExecutionLineItemEdge {
    node: BudgetExecutionLineItem!
    cursor: String!
  }
  type BudgetCommitmentLineItemConnection {
    edges: [BudgetCommitmentLineItemEdge!]!
    pageInfo: PageInfo!
  }
  type BudgetCommitmentLineItemEdge {
    node: BudgetCommitmentLineItem!
    cursor: String!
  }

  # ── capability-gated offset lists (carry caveats, never 404) ──
  type BudgetReportGated {
    items: [BudgetReport!]!
    total: Int
    estimated: Boolean!
    caveats: [String!]!
  }
  type BudgetClassificationGated {
    items: [BudgetClassification!]!
    total: Int
    estimated: Boolean!
    caveats: [String!]!
  }
  type BudgetApprovedFactGated {
    items: [BudgetApprovedFact!]!
    total: Int
    estimated: Boolean!
    caveats: [String!]!
  }
  type BudgetVsExecutionGated {
    items: [BudgetVsExecutionRow!]!
    total: Int
    estimated: Boolean!
    caveats: [String!]!
  }

  "Latest-year income/expense/balance + top expense categories (entity-360 slice)."
  type BudgetTopCategory {
    functionalCode: String!
    functionalName: String
    amount: Money!
  }
  type BudgetEntityProfile {
    presence: Boolean!
    latestYear: Int
    latestCompleteYear: Int
    reportType: BudgetReportType
    totalIncome: Money
    totalExpense: Money
    budgetBalance: Money
    topExpenseCategories: [BudgetTopCategory!]!
    refreshedAt: DateTime
  }

  extend type Query {
    "One execution line item (the pruning triple is required to fetch a partitioned row)."
    budgetExecutionLineItem(
      year: Int!
      reportType: BudgetReportType!
      accountCategory: BudgetAccountCategory!
      id: ID!
    ): BudgetExecutionLineItem
    "Execution facts (fact path). Needs the pruning triple — defaults to latest-complete year / EXECUTION_DETAILED / EXPENSE."
    budgetExecutionLineItems(
      filter: BudgetFactFilter
      sort: BudgetLineItemSortKey = LINE_ORDER
      first: Int = 20
      after: String
    ): BudgetExecutionLineItemConnection!
    "Commitment facts (fact path; pruning pair year+reportType). \`metric\` chooses the sort metric for AMOUNT_*."
    budgetCommitmentLineItems(
      filter: BudgetCommitmentFactFilter
      metric: BudgetCommitmentMetric = plati_trezor
      sort: BudgetLineItemSortKey = LINE_ORDER
      first: Int = 20
      after: String
    ): BudgetCommitmentLineItemConnection!
    "Entity execution summary by CUI (MV path; defaults to latest-complete year)."
    budgetEntitySummary(
      cui: CUI!
      year: Int
      yearFrom: Int
      yearTo: Int
      frequency: BudgetFrequency = YEAR
      reportType: BudgetReportType
    ): [BudgetEntitySummary!]!
    "Entity commitment summary by CUI (MV path)."
    budgetCommitmentSummary(
      cui: CUI!
      year: Int
      yearFrom: Int
      yearTo: Int
      frequency: BudgetFrequency = YEAR
      reportType: BudgetCommitmentReportType
    ): [BudgetCommitmentSummary!]!
    "Execution time series (MV path; \`metric\` selects income/expense/balance; normalization applied per-point)."
    budgetTimeseries(
      cui: CUI!
      reportType: BudgetReportType!
      metric: BudgetRankingMetric!
      frequency: BudgetFrequency!
      yearFrom: Int
      yearTo: Int
      normalization: BudgetNormalization = TOTAL
    ): [BudgetSeriesPoint!]!
    "National/aggregate execution time series (MV path; no implicit entity scope)."
    budgetAggregateTimeseries(
      reportType: BudgetReportType!
      metric: BudgetRankingMetric!
      frequency: BudgetFrequency!
      yearFrom: Int!
      yearTo: Int!
      normalization: BudgetNormalization = TOTAL
      isUat: Boolean
    ): [BudgetSeriesPoint!]!
    "Commitment time series (MV path)."
    budgetCommitmentTimeseries(
      cui: CUI!
      reportType: BudgetCommitmentReportType!
      metric: BudgetCommitmentMetric!
      frequency: BudgetFrequency!
      yearFrom: Int
      yearTo: Int
    ): [BudgetSeriesPoint!]!
    "Bounded top-N entity ranking (MV path + normalization factor)."
    budgetEntityRanking(
      filter: BudgetRankingFilter
      metric: BudgetRankingMetric = EXPENSE
      normalization: BudgetNormalization = TOTAL
      ascending: Boolean = false
      sort: BudgetEntityRankingSort
      limit: Int = 50
    ): [BudgetRankedEntity!]!
    "Offset-paged entity ranking for bounded analytics tables and CSV export."
    budgetEntityRankingPage(
      filter: BudgetRankingFilter
      metric: BudgetRankingMetric = EXPENSE
      normalization: BudgetNormalization = TOTAL
      ascending: Boolean = false
      sort: BudgetEntityRankingSort
      limit: Int = 50
      offset: Int = 0
    ): BudgetEntityRankingPage!
    "Bounded top-N commitment ranking (MV path)."
    budgetCommitmentRanking(
      year: Int!
      reportType: BudgetCommitmentReportType!
      metric: BudgetCommitmentMetric = plati_trezor
      limit: Int = 50
    ): [BudgetRankedCommitmentEntity!]!
    "Spend/income by functional×economic classification within ONE pruned leaf. complete=true uses the server completeness guard and requires the default limit."
    budgetAggregateByClassification(
      filter: BudgetFactFilter!
      normalization: BudgetNormalization = TOTAL
      minAmount: Money
      maxAmount: Money
      limit: Int = 50
      complete: Boolean = false
    ): [BudgetAggregatedRow!]!
    "County heatmap (MV → county rollup)."
    budgetCountyHeatmap(
      year: Int!
      reportType: BudgetReportType!
      metric: BudgetRankingMetric = EXPENSE
      normalization: BudgetNormalization = TOTAL
    ): [BudgetCountyHeatmapPoint!]!
    "Complete UAT heatmap (MV → canonical territory rollup; never top-N)."
    budgetUatHeatmap(
      year: Int!
      reportType: BudgetReportType!
      metric: BudgetRankingMetric = EXPENSE
      normalization: BudgetNormalization = TOTAL
    ): [BudgetUatHeatmapPoint!]!
    "Report registry (requires ≥1 of entityCui / reportingYear / reportType)."
    budgetReports(filter: BudgetReportFilter!, page: Int, pageSize: Int): BudgetReportGated!
    budgetReport(reportId: ID!): BudgetReport
    "Functional classification catalog (capability-gated: empty in prod → caveat)."
    budgetFunctionalClassifications(
      search: String
      codes: [String!]
      limit: Int = 50
    ): BudgetClassificationGated!
    budgetEconomicClassifications(
      search: String
      codes: [String!]
      limit: Int = 50
    ): BudgetClassificationGated!
    "Budget-sector catalog (renamed from budgetSectors: the legacy root keeps that name, design 13 §3)."
    budgetSectorCatalog(search: String, ids: [Int!]): [BudgetSectorCatalogEntry!]!
    budgetFundingSources(search: String, ids: [Int!]): [BudgetFundingSource!]!
    "Approved (planned) budget facts (budget-official; works on its own data)."
    budgetApprovedFacts(
      filter: BudgetApprovedFactFilter
      page: Int
      pageSize: Int
    ): BudgetApprovedFactGated!
    "Planned vs actual (capability-gated: execution bulletins not yet loaded → caveat)."
    budgetVsExecution(budgetYear: Int, page: Int, pageSize: Int): BudgetVsExecutionGated!
    "Resolve a free-text query to a budget filter value (name→CUI/SIRUTA/code)."
    budgetResolve(dim: BudgetResolveDim!, q: String!, limit: Int = 10): [BudgetResolveMatch!]!
    "Budget data freshness (latest loaded + latest complete year)."
    budgetAsOf: BudgetAsOf!
  }

  extend type Entity {
    "Budget rollup for this entity by CUI (latest complete year; via the cross-source contributor)."
    budget: BudgetEntityProfile
  }
`;

export const budgetTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
