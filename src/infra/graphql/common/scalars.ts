/**
 * Common GraphQL scalars
 * Custom scalar types for dates, decimals, etc.
 */

export const CommonScalars = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Date & Time
  # ---------------------------------------------------------------------------
  "ISO 8601 date string (YYYY-MM-DD)"
  scalar Date

  "ISO 8601 datetime string with timezone"
  scalar DateTime

  # ---------------------------------------------------------------------------
  # Period
  # ---------------------------------------------------------------------------
  "A string representing a Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])"
  scalar PeriodDate

  # ---------------------------------------------------------------------------
  # Data Types
  # ---------------------------------------------------------------------------
  "Arbitrary JSON value"
  scalar JSON
`;
