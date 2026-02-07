/**
 * GraphQL schema for INS module.
 */

export const InsSchema = /* GraphQL */ `
  """
  INS periodicity values.
  """
  enum InsPeriodicity {
    ANNUAL
    QUARTERLY
    MONTHLY
  }

  """
  INS territory levels (NUTS + LAU hierarchy).
  """
  enum InsTerritoryLevel {
    NATIONAL
    NUTS1
    NUTS2
    NUTS3
    LAU
  }

  """
  INS sync status for datasets.
  """
  enum InsSyncStatus {
    PENDING
    SYNCING
    SYNCED
    FAILED
    STALE
  }

  """
  INS latest value match strategy.
  """
  enum InsLatestMatchStrategy {
    PREFERRED_CLASSIFICATION
    TOTAL_FALLBACK
    REPRESENTATIVE_FALLBACK
    NO_DATA
  }

  """
  INS dimension type.
  """
  enum InsDimensionType {
    TEMPORAL
    TERRITORIAL
    CLASSIFICATION
    UNIT_OF_MEASURE
  }

  """
  INS dataset (matrix) metadata.
  """
  type InsDataset {
    id: ID!
    code: String!
    name_ro: String
    name_en: String
    definition_ro: String
    definition_en: String
    periodicity: [InsPeriodicity!]!
    year_range: [Int!]
    dimension_count: Int!
    has_uat_data: Boolean!
    has_county_data: Boolean!
    has_siruta: Boolean!
    sync_status: InsSyncStatus
    last_sync_at: DateTime
    context_code: String
    context_name_ro: String
    context_name_en: String
    context_path: String
    metadata: JSON
    dimensions: [InsDimension!]!
  }

  """
  Paginated connection of INS datasets.
  """
  type InsDatasetConnection {
    nodes: [InsDataset!]!
    pageInfo: PageInfo!
  }

  """
  INS context (taxonomy node).
  """
  type InsContext {
    id: ID!
    code: String!
    name_ro: String
    name_en: String
    name_ro_markdown: String
    name_en_markdown: String
    level: Int
    parent_id: Int
    parent_code: String
    path: String!
    matrix_count: Int!
  }

  """
  Paginated connection of INS contexts.
  """
  type InsContextConnection {
    nodes: [InsContext!]!
    pageInfo: PageInfo!
  }

  """
  Dimension metadata for an INS dataset.
  """
  type InsDimension {
    index: Int!
    type: InsDimensionType!
    label_ro: String
    label_en: String
    classification_type: InsClassificationType
    is_hierarchical: Boolean!
    option_count: Int!
    values(
      filter: InsDimensionValueFilterInput
      limit: Int = 50
      offset: Int = 0
    ): InsDimensionValueConnection!
  }

  """
  A single dimension value (nomItemId) mapped to canonical entities.
  """
  type InsDimensionValue {
    nom_item_id: Int!
    dimension_type: InsDimensionType!
    label_ro: String
    label_en: String
    parent_nom_item_id: Int
    offset_order: Int!
    territory: InsTerritory
    time_period: InsTimePeriod
    classification_value: InsClassificationValue
    unit: InsUnit
  }

  type InsDimensionValueConnection {
    nodes: [InsDimensionValue!]!
    pageInfo: PageInfo!
  }

  input InsDimensionValueFilterInput {
    search: String
  }

  """
  INS territory entity.
  """
  type InsTerritory {
    id: ID!
    code: String!
    siruta_code: String
    level: InsTerritoryLevel!
    name_ro: String!
    path: String
    parent_id: Int
  }

  """
  INS time period.
  """
  type InsTimePeriod {
    id: ID!
    year: Int!
    quarter: Int
    month: Int
    periodicity: InsPeriodicity!
    period_start: Date
    period_end: Date
    label_ro: String
    label_en: String
    iso_period: String!
  }

  """
  INS classification type.
  """
  type InsClassificationType {
    id: ID!
    code: String!
    name_ro: String
    name_en: String
    is_hierarchical: Boolean!
    value_count: Int
  }

  """
  INS classification value.
  """
  type InsClassificationValue {
    id: ID!
    type_id: Int!
    type_code: String!
    type_name_ro: String
    type_name_en: String
    code: String!
    name_ro: String
    name_en: String
    level: Int
    parent_id: Int
    sort_order: Int
  }

  """
  INS unit of measure.
  """
  type InsUnit {
    id: ID!
    code: String!
    symbol: String
    name_ro: String
    name_en: String
  }

  """
  Single INS observation (data point).
  """
  type InsObservation {
    id: ID!
    dataset_code: String!
    territory: InsTerritory
    time_period: InsTimePeriod!
    unit: InsUnit
    value: String
    value_status: String
    classifications: [InsClassificationValue!]!
    dimensions: JSON!
  }

  type InsObservationConnection {
    nodes: [InsObservation!]!
    pageInfo: PageInfo!
  }

  type InsLatestDatasetValue {
    dataset: InsDataset!
    observation: InsObservation
    latestPeriod: String
    matchStrategy: InsLatestMatchStrategy!
    hasData: Boolean!
  }

  """
  Filter datasets by code, search, and metadata.
  """
  input InsDatasetFilterInput {
    search: String
    codes: [String!]
    contextCode: String
    rootContextCode: String
    periodicity: [InsPeriodicity!]
    syncStatus: [InsSyncStatus!]
    hasUatData: Boolean
    hasCountyData: Boolean
  }

  input InsContextFilterInput {
    search: String
    level: Int
    parentCode: String
    rootContextCode: String
  }

  input InsEntitySelectorInput {
    sirutaCode: String
    territoryCode: String
    territoryLevel: InsTerritoryLevel
  }

  """
  Filter observations by dimensions.
  """
  input InsObservationFilterInput {
    territoryCodes: [String!]
    sirutaCodes: [String!]
    territoryLevels: [InsTerritoryLevel!]
    unitCodes: [String!]
    classificationValueCodes: [String!]
    classificationTypeCodes: [String!]
    period: ReportPeriodInput
    hasValue: Boolean
  }

  """
  A dataset grouped with its observations for a UAT dashboard.
  """
  type InsUatDatasetGroup {
    dataset: InsDataset!
    observations: [InsObservation!]!
    latestPeriod: String
  }

  extend type Query {
    """
    List INS datasets (matrices) with optional filtering.
    """
    insDatasets(
      filter: InsDatasetFilterInput
      limit: Int = 20
      offset: Int = 0
    ): InsDatasetConnection!

    """
    Get a single INS dataset by code.
    """
    insDataset(code: String!): InsDataset

    """
    Query paginated values for one INS dataset dimension.
    """
    insDatasetDimensionValues(
      datasetCode: String!
      dimensionIndex: Int!
      filter: InsDimensionValueFilterInput
      limit: Int = 50
      offset: Int = 0
    ): InsDimensionValueConnection!

    """
    List INS contexts (taxonomy nodes) with optional filtering.
    """
    insContexts(
      filter: InsContextFilterInput
      limit: Int = 20
      offset: Int = 0
    ): InsContextConnection!

    """
    Query INS observations for a dataset.
    """
    insObservations(
      datasetCode: String!
      filter: InsObservationFilterInput
      limit: Int = 50
      offset: Int = 0
    ): InsObservationConnection!

    """
    Get INS indicators for a specific UAT (siruta code).
    """
    insUatIndicators(
      sirutaCode: String!
      period: PeriodDate
      datasetCodes: [String!]!
    ): [InsObservation!]!

    """
    Compare a dataset across multiple UATs.
    """
    insCompare(
      sirutaCodes: [String!]!
      datasetCode: String!
      period: PeriodDate
    ): [InsObservation!]!

    """
    Load all UAT-level indicators for a specific territory, grouped by dataset.
    Optimized for rendering a UAT dashboard in a single request.
    """
    insUatDashboard(
      sirutaCode: String!
      period: PeriodDate
      contextCode: String
    ): [InsUatDatasetGroup!]!

    """
    Return the latest available value per dataset for a selected entity.
    """
    insLatestDatasetValues(
      entity: InsEntitySelectorInput!
      datasetCodes: [String!]!
      preferredClassificationCodes: [String!]
    ): [InsLatestDatasetValue!]!
  }
`;
