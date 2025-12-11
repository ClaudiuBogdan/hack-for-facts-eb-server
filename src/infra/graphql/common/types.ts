/**
 * Common GraphQL types and inputs
 * Reusable type definitions for pagination, sorting, filtering, etc.
 */

export const CommonTypes = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Sorting
  # ---------------------------------------------------------------------------
  "Input for specifying sort order on a field"
  input SortOrder {
    "Field name to sort by"
    by: String!
    "Sort direction (ASC or DESC)"
    order: String!
  }

  # ---------------------------------------------------------------------------
  # Pagination (Relay Cursor Connection Pattern)
  # ---------------------------------------------------------------------------
  "Information about pagination in a connection"
  type PageInfo {
    "Total count of items matching the query"
    totalCount: Int!
    "Indicates if there are more pages after the current page"
    hasNextPage: Boolean!
    "Indicates if there are more pages before the current page"
    hasPreviousPage: Boolean!
    "Cursor of the first edge in the page"
    startCursor: String
    "Cursor of the last edge in the page"
    endCursor: String
  }

  "Input for pagination using cursor-based pagination"
  input PaginationInput {
    "Number of items to return (default: 20, max: 100)"
    first: Int
    "Cursor to start fetching from"
    after: String
    "Number of items to return from the end"
    last: Int
    "Cursor to fetch items before"
    before: String
  }

  # ---------------------------------------------------------------------------
  # Date Range Filtering
  # ---------------------------------------------------------------------------
  "Input for filtering by date range"
  input DateRangeInput {
    "Start date (inclusive)"
    start: Date!
    "End date (inclusive)"
    end: Date!
  }

  # ---------------------------------------------------------------------------
  # Numeric Range Filtering
  # ---------------------------------------------------------------------------
  "Input for filtering by numeric range"
  input NumericRangeInput {
    "Minimum value (inclusive)"
    min: Float
    "Maximum value (inclusive)"
    max: Float
  }

  # ---------------------------------------------------------------------------
  # String Filtering
  # ---------------------------------------------------------------------------
  "Input for string filtering operations"
  input StringFilterInput {
    "Exact match"
    equals: String
    "Contains substring (case-insensitive)"
    contains: String
    "Starts with prefix (case-insensitive)"
    startsWith: String
    "Ends with suffix (case-insensitive)"
    endsWith: String
    "Value is in the provided list"
    in: [String!]
    "Value is not in the provided list"
    notIn: [String!]
  }

  # ---------------------------------------------------------------------------
  # Temporal Data
  # ---------------------------------------------------------------------------
  "A single data point in a time series"
  type DataPoint {
    "Date string: YYYY, YYYY-MM, or YYYY-QN"
    date: String!
    "Decimal value as string"
    value: String!
  }

  "Time series data with consistent frequency"
  type DataSeries {
    "Period type of the data points"
    frequency: PeriodType!
    "Ordered array of data points"
    data: [DataPoint!]!
  }
`;
