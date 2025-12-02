/**
 * Common GraphQL enums
 * Reusable enum types shared across multiple modules
 */

export const CommonEnums = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Sorting
  # ---------------------------------------------------------------------------
  "Sort direction for ordered results"
  enum SortDirection {
    "Ascending order"
    ASC
    "Descending order"
    DESC
  }

  # ---------------------------------------------------------------------------
  # Currency
  # ---------------------------------------------------------------------------
  "Supported currencies for financial data"
  enum Currency {
    "Romanian Leu"
    RON
    "Euro"
    EUR
    "US Dollar"
    USD
  }

  # ---------------------------------------------------------------------------
  # Report Type
  # ---------------------------------------------------------------------------
  "Type of report"
  enum ReportType {
    "Executie bugetara agregata la nivel de ordonator principal"
    PRINCIPAL_AGGREGATED
    "Executie bugetara agregata la nivel de ordonator secundar"
    SECONDARY_AGGREGATED
    "Executie bugetara detaliata"
    DETAILED
  }

  # ---------------------------------------------------------------------------
  # Frequency
  # ---------------------------------------------------------------------------
  "Frequency of temporal data points"
  enum Frequency {
    "Monthly data points"
    MONTHLY
    "Quarterly data points"
    QUARTERLY
    "Yearly data points"
    YEARLY
  }
`;
