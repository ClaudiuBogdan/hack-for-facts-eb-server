export const DatasetsSchema = /* GraphQL */ `
  """
  Data type for axis values in charts.
  """
  enum DatasetAxisDataType {
    STRING
    INTEGER
    FLOAT
    DATE
  }

  """
  Granularity of time-based axis data.
  Used for charts to determine appropriate display formatting.
  """
  enum AxisGranularity {
    YEAR
    QUARTER
    MONTH
    CATEGORY
  }

  """
  Axis configuration for chart display.
  """
  type DatasetAxis {
    """
    Human-readable axis label
    """
    name: String!
    """
    Data type for axis values
    """
    type: DatasetAxisDataType!
    """
    Unit of measurement (e.g., 'year', 'RON', '%')
    """
    unit: String!
    """
    Granularity for time-based data (e.g., YEAR, MONTH)
    """
    granularity: AxisGranularity
  }

  """
  Dataset metadata for listing (excludes data points).
  """
  type Dataset {
    """
    Unique identifier matching filename
    """
    id: ID!
    """
    Display name (localized)
    """
    name: String!
    """
    Dataset title (localized)
    """
    title: String!
    """
    Dataset description (localized)
    """
    description: String!
    """
    Name of the data source
    """
    sourceName: String
    """
    URL to the original data source
    """
    sourceUrl: String
    """
    X-axis configuration
    """
    xAxis: DatasetAxis!
    """
    Y-axis configuration
    """
    yAxis: DatasetAxis!
  }

  """
  Pagination metadata for dataset listing.
  """
  type DatasetPageInfo {
    """
    Total count of matching datasets
    """
    totalCount: Int!
    """
    Whether there are more items after current page
    """
    hasNextPage: Boolean!
    """
    Whether there are items before current page
    """
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection of datasets.
  """
  type DatasetConnection {
    """
    List of datasets in current page
    """
    nodes: [Dataset!]!
    """
    Pagination metadata
    """
    pageInfo: DatasetPageInfo!
  }

  """
  Filter options for dataset listing.
  """
  input DatasetFilter {
    """
    Fuzzy search across name, title, description, source
    """
    search: String
    """
    Filter to specific dataset IDs
    """
    ids: [ID!]
  }

  """
  A single data point in a chart series.
  """
  type StaticAnalyticsDataPoint {
    """
    X-axis value (always string for GraphQL)
    """
    x: String!
    """
    Y-axis value
    """
    y: Float!
  }

  """
  Analytics series for chart display.
  """
  type StaticAnalyticsSeries {
    """
    Dataset ID this series represents
    """
    seriesId: String!
    """
    X-axis configuration
    """
    xAxis: DatasetAxis!
    """
    Y-axis configuration
    """
    yAxis: DatasetAxis!
    """
    Data points in the series
    """
    data: [StaticAnalyticsDataPoint!]!
  }

  extend type Query {
    """
    List available datasets with optional filtering and pagination.
    """
    datasets(
      """
      Filter options
      """
      filter: DatasetFilter
      """
      Maximum datasets to return (default: 100)
      """
      limit: Int = 100
      """
      Number of datasets to skip (default: 0)
      """
      offset: Int = 0
      """
      Language code for localization (e.g., 'en' for English)
      """
      lang: String
    ): DatasetConnection!

    """
    Get formatted chart data for specific dataset IDs.
    Non-existent IDs are silently omitted from results.
    """
    staticChartAnalytics(
      """
      Dataset IDs to retrieve
      """
      seriesIds: [ID!]!
      """
      Language code for localization
      """
      lang: String
    ): [StaticAnalyticsSeries!]!
  }
`;
