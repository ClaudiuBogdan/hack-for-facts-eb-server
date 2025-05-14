# Feature Specification: Budget Execution Heatmap Analytics

**Version:** 1.0
**Date:** 2023-10-27

## 1. Introduction & Goals

This document outlines the requirements for a new Heatmap Analytics feature within the "Execuții Bugetare" (Budget Execution) platform. The primary goal is to provide users with a visual tool to explore and analyze budget execution data geographically, allowing for the identification of patterns, disparities, and trends across different administrative regions (UATs - Unități Administrativ-Teritoriale).

The feature aims to:
*   Enable users to visualize aggregated financial data (income or expenses) on a geographical map of Romania.
*   Allow dynamic filtering of data based on various budgetary and temporal criteria.
*   Enhance understanding of public spending and revenue distribution at the UAT level.

## 2. Target Users

*   Data Analysts
*   Journalists
*   Researchers
*   Policy Makers
*   Civic Auditors
*   General Public interested in public finance

## 3. User Stories

*   **As a data analyst, I want to** see the total expenses for education (a specific functional code) across all UATs in 2022 on a heatmap, so I can identify regions with high or low spending.
*   **As a journalist, I want to** filter the heatmap to show total income from local taxes (specific economic codes, account category 'vn') for UATs in a particular county for the last three years, so I can investigate revenue generation patterns.
*   **As a researcher, I want to** compare per-capita spending on healthcare (functional code, account category 'ch', client-side calculation using population) across different UATs, so I can analyze regional disparities.
*   **As a user, I want to** be able to select multiple years and see the aggregated data on the map.
*   **As a user, I want to** be able to filter line items by a minimum and maximum amount before they are aggregated for the heatmap, to exclude outliers or focus on specific transaction sizes.
*   **As a user, I want to** hover over a UAT on the heatmap and see its name, aggregated value, and other key details.

## 4. Functional Requirements

### 4.1. Heatmap Visualization

*   **FR1.1:** The system shall display a geographical map of Romania, divided by UAT boundaries.
*   **FR1.2:** Each UAT on the map shall be color-coded based on an aggregated monetary value derived from the `ExecutionLineItems` table.
*   **FR1.3:** The color intensity shall represent the magnitude of the aggregated value (e.g., light color for low values, dark color for high values). A configurable color scale should be used.
*   **FR1.4:** The map should be interactive, allowing users to pan and zoom.

### 4.2. Data Aggregation & Value Representation

*   **FR2.1:** The system shall calculate the `total_amount` for each UAT by summing the `amount` from `ExecutionLineItems` that match the applied filters.
*   **FR2.2:** Users must be able to select the `account_category` to determine if the aggregated value represents income (`vn`) or expenses (`ch`). This is a mandatory filter.

### 4.3. Filtering Capabilities

The system shall provide the following filters to refine the data displayed on the heatmap:

*   **FR3.1: Functional Codes (`functional_codes`):**
    *   Allow users to select one or more functional classification codes.
    *   If no functional codes are selected, data for all functional codes (matching other filters) should be aggregated.
*   **FR3.2: Economic Codes (`economic_codes`):**
    *   Allow users to select one or more economic classification codes.
    *   If no economic codes are selected, data for all economic codes (matching other filters) should be aggregated. This is particularly relevant for income (`vn`) which may not always have economic codes.
*   **FR3.3: Account Categories (`account_categories`):**
    *   **Mandatory filter.** Allow users to select one or more account categories (typically, users will select either 'vn' for income or 'ch' for expenses for a meaningful heatmap, but the backend should support a list).
*   **FR3.4: Years (`years`):**
    *   **Mandatory filter.** Allow users to select one or more years for which the data should be aggregated.
*   **FR3.5: Minimum Amount (`min_amount`):**
    *   Optional. Allow users to specify a minimum value for individual line items to be included in the aggregation.
*   **FR3.6: Maximum Amount (`max_amount`):**
    *   Optional. Allow users to specify a maximum value for individual line items to be included in the aggregation.
*   **FR3.7 (Future Consideration/Optional): Geographic Filters:**
    *   Allow users to filter by `county_codes` or `regions` to focus the heatmap on specific geographical areas.

### 4.4. User Interface & Interaction

*   **FR4.1:** A clear and intuitive interface shall be provided for selecting filters.
*   **FR4.2:** The heatmap shall update dynamically when filter selections change.
*   **FR4.3:** On hovering over a UAT on the map, a tooltip shall display:
    *   UAT Name (`uat_name`)
    *   UAT Code (`uat_code`)
    *   Aggregated Value (`total_amount`)
    *   County Name (`county_name`)
    *   Population (`population`) (to allow users to mentally contextualize or for client-side per-capita display)
*   **FR4.4:** A legend explaining the color scale and corresponding value ranges shall be displayed.

## 5. Data Requirements

### 5.1. Input Data Sources

The feature will primarily use the following database tables (as defined in `schema.sql`):
*   `ExecutionLineItems`: For financial transaction data.
*   `Reports`: To link line items to reporting years (if `year` is not directly on `ExecutionLineItems` for filtering, or if period filtering becomes necessary).
*   `Entities`: To link line items to UATs.
*   `UATs`: For UAT names, codes, population, and geographical information (county).
*   `FunctionalClassifications`, `EconomicClassifications` (for resolving codes to names if needed, though filters are code-based).

### 5.2. Output Data Structure (API Response)

The GraphQL API will return an array of `HeatmapUATDataPoint` objects:

```graphql
type HeatmapUATDataPoint {
  uat_id: ID!
  uat_code: String!       # For client-side mapping to GeoJSON properties
  uat_name: String!       # For display
  county_code: String     # For context or potential county-level roll-up view
  county_name: String     # For display
  population: Int         # For per-capita calculations by the client
  total_amount: Float! # The calculated sum based on filters
}
```

## 6. API Endpoint

A GraphQL query will be used to fetch the heatmap data:

*   **Query:** `heatmapUATData(filter: HeatmapFilterInput!): [HeatmapUATDataPoint!]!`
*   **Input Filter Type:** `HeatmapFilterInput`

```graphql
input HeatmapFilterInput {
  functional_codes: [String!]    # Optional
  economic_codes: [String!]      # Optional
  account_categories: [String!]! # Mandatory: e.g., ["ch"] for expenses, ["vn"] for income
  years: [Int!]!                 # Mandatory
  min_amount: Float              # Optional
  max_amount: Float              # Optional
  # county_codes: [String!]      # Optional for future geographic pre-filtering
  # regions: [String!]           # Optional for future geographic pre-filtering
}
```

## 7. Performance Considerations

*   **P1.1:** The data retrieval query must be optimized for performance, considering the large volume of data in `ExecutionLineItems`.
*   **P1.2:** Efficient database indexing on filterable and join columns in `ExecutionLineItems`, `Reports`, `Entities`, and `UATs` is crucial. (Relevant indexes largely exist as per `schema.sql`).
*   **P1.3:** The client-side map rendering should handle a large number of UATs (approx. 3200) efficiently.

## 8. Non-Functional Requirements

*   **NFR1.1 Usability:** The heatmap interface and filter controls should be intuitive and easy to use.
*   **NFR1.2 Responsiveness:** The UI should provide timely feedback, and the map should update reasonably fast after filter changes.
*   **NFR1.3 Accessibility:** The feature should adhere to basic web accessibility standards (e.g., color contrast for the map).
*   **NFR1.4 Scalability:** The backend solution should be able to handle a growing dataset and user load.

## 9. Out of Scope (for Version 1.0)

*   Real-time data updates on the heatmap.
*   Saving or sharing specific heatmap views/filter configurations.
*   Advanced statistical analysis directly overlaid on the map (e.g., standard deviation, anomaly detection).
*   Direct drill-down from a UAT on the map to its detailed line items within the same interface (may link to other parts of the application).
*   Aggregations at the County or Region level directly from the API (client can do this if `county_code` is provided per UAT).
*   Support for date range filtering beyond just year selection.

## 10. Future Considerations

*   Allowing users to select a specific metric for color-coding (e.g., total amount, per capita amount, percentage change from the previous year).
*   Time-slider to animate changes across years.
*   Side-by-side map comparisons for different datasets or time periods.
*   Integration with other analytical views.