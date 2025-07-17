# Entity Details Page: Functional and Technical Specification

**Version:** 1.0
**Date:** 2023-10-27

## 1. Introduction & Purpose

The Entity Details Page provides a comprehensive, centralized view of a specific public entity's financial and administrative information. Its primary purpose is to enable detailed analysis of an entity's budget execution, track performance over time, identify trends, and support the detection of potential anomalies or areas of interest. This page serves various stakeholders, including financial analysts, auditors, policymakers, and the public (for transparency).

## 2. Target Users

*   Financial Analysts & Budget Officers (within the entity or oversight bodies)
*   Auditors (internal and external)
*   Government Oversight Agencies
*   Researchers and Economists
*   Journalists
*   Concerned Citizens

## 3. Key Features

*   **Entity Profile:** Displays core identifying and contextual information about the entity.
*   **Financial Summary:** High-level overview of income, expenses, and budget balance, with trends over time.
*   **Income Breakdown:** Detailed view of income sources and classifications.
*   **Expense Breakdown:** Detailed view of expenses by functional, economic, and program classifications.
*   **Reporting History:** Chronological list of submitted financial reports.
*   **Comparative Analysis & Anomaly Flags:** Highlights how the entity performs against its own history and relevant peer groups, flagging potential anomalies.
*   **Detailed Transactions View:** Access to individual budget execution line items for granular inspection.
*   **Interactive Visualizations:** Charts and graphs for easy data interpretation.
*   **Data Export:** Ability to export underlying data for offline analysis.

## 4. Data Sources & Key Data Points

The page primarily draws data from the following tables and views (as defined in `src/db/schema.sql`):

*   **`Entities`:**
    *   `cui`: Primary identifier.
    *   `name`: Entity's official name.
    *   `address`: Physical address.
    *   `last_updated`: Data freshness indicator.
*   **`UATs` (linked via `Entities.uat_id`):**
    *   `uat_code`, `name` (UAT name), `county_code`, `county_name`, `region`, `population`. Essential for per capita calculations and geographical context.
*   **`Reports` (linked via `Entities.cui` -> `Reports.entity_cui`):**
    *   `report_id`, `report_date`, `reporting_year`, `reporting_period`, `import_timestamp`. Used for tracking reporting activity and filtering data by time.
*   **`ExecutionLineItems` (linked via `Reports.report_id` and `Entities.cui`):**
    *   `line_item_id`, `funding_source_id`, `functional_code`, `economic_code` (nullable), `account_category` ('vn' or 'ch'), `amount`, `program_code` (nullable), `year`. The core transactional data.
*   **Dimension Tables (for descriptive names):**
    *   `FunctionalClassifications` (`functional_name`)
    *   `EconomicClassifications` (`economic_name`)
    *   `FundingSources` (`source_description`)
*   **Materialized Views (for aggregated data & performance):**
    *   `vw_ExecutionDetails`: Flattened detailed view.
    *   `vw_BudgetSummary_ByEntityPeriod`: Aggregated income, expenses, balance per entity/period.
    *   `vw_ExpenseAnalysis_ByCategory`: Expense breakdown by classifications.
    *   `vw_FundingSource_Summary`: Income/expense by funding source.
    *   `vw_UAT_Aggregated_Metrics`: Per UAT metrics including per capita.
    *   `vw_County_Aggregated_Metrics`: County-level aggregations (for peer comparison).
    *   `vw_Category_Aggregated_Metrics`: Aggregations by various categories.
    *   *(Potentially new MVs for anomaly detection baselines, e.g., historical standard deviations, peer group medians).*

## 5. Page Sections & Business Logic

### 5.1. Header / Profile Section
*   **Data:** `Entities.name`, `Entities.cui`, `Entities.category`, `UATs.name` (if linked), `UATs.county_name`, `UATs.population`.
*   **Logic:** Direct lookup from `Entities` and `UATs` tables based on the entity CUI.

### 5.2. Financial Overview (Latest Period & Trends)
*   **Data:** Sourced from `vw_BudgetSummary_ByEntityPeriod` and `vw_UAT_Aggregated_Metrics`.
*   **Metrics Displayed:**
    *   Total Income (latest period, YTD, trend over last 3-5 years).
    *   Total Expense (latest period, YTD, trend over last 3-5 years).
    *   Budget Balance (Surplus/Deficit) (latest period, YTD, trend).
    *   Per Capita Income/Expense (for UATs, latest period, trend).
*   **Logic:**
    *   Filter view data by `entity_cui` and selected `reporting_year`/`reporting_period`.
    *   Time series data fetched by querying for multiple periods/years.
*   **Visualization:** Line charts for trends, KPI cards for latest figures.

### 5.3. Income Analysis
*   **Data:** `ExecutionLineItems` filtered by `account_category = 'vn'`, joined with `FundingSources`, `FunctionalClassifications`.
*   **Breakdowns:**
    *   By Funding Source (`FundingSources.source_description`).
    *   By Functional Classification (`FunctionalClassifications.functional_name`), if meaningful for income.
*   **Logic:** Aggregate `amount` grouped by the chosen dimension for the selected period.
*   **Visualization:** Pie chart or bar chart for proportions (latest period), stacked bar chart for trends over time.

### 5.4. Expense Analysis
*   **Data:** `ExecutionLineItems` filtered by `account_category = 'ch'`, joined with `FunctionalClassifications`, `EconomicClassifications`, `FundingSources`, `ProgramCodes` (if programs are a focus).
*   **Breakdowns:**
    *   By Functional Classification (Top N categories and "Other").
    *   By Economic Classification (Top N categories and "Other").
    *   By Funding Source.
    *   By Program Code (if used).
*   **Logic:** Aggregate `amount` grouped by chosen dimensions for the selected period.
*   **Visualization:** Treemaps, bar charts for proportions, stacked bar charts for trends.

### 5.5. Comparative Analysis & Anomaly Indicators
*   **Data:**
    *   Entity's data from views like `vw_UAT_Aggregated_Metrics`, `vw_ExpenseAnalysis_ByCategory`.
    *   Historical baselines (e.g., average of same metric over last 3 years for the entity).
    *   Peer group baselines (e.g., median per capita expense for UATs in the same county from `vw_County_Aggregated_Metrics` or a specialized peer view).
*   **Logic:**
    *   Calculate percentage deviation from historical self.
    *   Calculate percentage deviation from peer group average/median.
    *   Apply predefined thresholds (e.g., deviation > 20% or > 2 standard deviations) to flag anomalies.
    *   Display metrics alongside their baselines and deviation scores.
*   **Visualization:** KPI cards with color-coded indicators (green/yellow/red), bullet charts showing actual vs. target/baseline.

### 5.6. Reporting History
*   **Data:** `Reports` table.
*   **Logic:** List all reports for the `entity_cui`, ordered by `report_date` descending. Show `report_date`, `reporting_year`, `reporting_period`, `file_source` (if available), `import_timestamp`.

### 5.7. Detailed Execution Line Items
*   **Data:** `vw_ExecutionDetails`.
*   **Logic:** A paginated, searchable, sortable, and filterable table.
    *   Filters: `report_date` range, `account_category`, `functional_name`, `economic_name`, `funding_source`, `amount` range.
*   **Columns:** `report_date`, `account_category`, `functional_name`, `economic_name`, `funding_source`, `program_code`, `amount`.

## 6. Comparative Analysis for Anomaly Detection (Detailed)

The goal of comparative analysis in this context is to identify data points or trends for an entity that deviate significantly from a "norm," potentially indicating errors, inefficiencies, unusual activities, or areas requiring further investigation.

### 6.1. Establishing Baselines for "Normal"

*   **Historical Self-Comparison (Intra-Entity Analysis):**
    *   **Trend Analysis:** Compare current metrics against historical data.
        *   *Metrics:* Month-over-month, quarter-over-quarter, year-over-year changes.
        *   *Baselines:* Rolling averages, values from the same period in previous years.
        *   *Anomaly Indication:* Statistically significant spikes/drops (e.g., >2-3 std dev), deviation from trends.
*   **Peer Group Comparison (Inter-Entity Analysis):**
    *   **Defining Peer Groups:**
        *   *For UATs:* Same county/region, similar population size (+/- 10-20%), similar socio-economic profiles (advanced).
        *   *For Other Entities:* Same `category`, similar size/budget.
    *   **Metrics for Comparison:** Per capita figures, % budget allocations, operational ratios.
    *   **Baselines:** Average, median, quartiles of the peer group.
    *   *Anomaly Indication:* Outlier status (e.g., top/bottom 5%), significant deviation from peer central tendency.
*   **Budget vs. Actual (if budget data becomes available):**
    *   Compare actuals against planned amounts.
    *   *Anomaly Indication:* Significant overruns/underruns.

### 6.2. Key Metrics & Dimensions for Anomaly Detection

*   **Expenditure Anomalies:** Unusual spending in `functional_code` or `economic_code`, new unexpected categories, rapid `amount` increase, high `program_code` expenses.
*   **Income Anomalies:** Significant changes in `FundingSources.source_description`, very large one-off income.
*   **Operational Anomalies (derived):** Changes in administrative cost ratios, per capita metric changes, unusual `reporting_period` patterns.

### 6.3. Visualizing and Investigating Anomalies

*   **Dashboards:** Visual cues (color-coding, icons) for metrics outside ranges.
*   **Statistical Control Charts:** Plot metrics with upper/lower control limits.
*   **Box Plots:** Visualize entity position within peer group distribution.
*   **Drill-Down Capabilities:** Click anomalous aggregates to see underlying `ExecutionLineItems` or `Reports`.

### 6.4. Technical Considerations for Anomaly Detection

*   **Materialized Views for Baselines:** Pre-calculate historical and peer group statistics.
*   **Defining Thresholds:** Statistical or percentage-based, potentially configurable/learned.
*   **Alerting Mechanisms:** Notifications for critical anomalies.

## 7. User Interaction & Controls

*   **Global Period Selector:** Select `reporting_year` and `reporting_period` (Quarter, Month, Annual) to update all page sections.
*   **Drill-Downs:** Interactive charts allowing clicks to filter or navigate.
*   **Export Functionality:** "Export to CSV/Excel" for tables and chart data.
*   **Tooltips:** Information on hover for chart elements and metric definitions.

## 8. Non-Functional Requirements

*   **Performance:** Fast page loads, relying on materialized views and optimized queries.
*   **Usability:** Intuitive navigation and clear information presentation.
*   **Accessibility:** Adherence to WCAG guidelines.
*   **Security:** Appropriate data access controls.

## 9. Future Enhancements

*   Integration of budget plan data for budget vs. actual analysis.
*   More sophisticated statistical anomaly detection models.
*   User-configurable anomaly thresholds and alert subscriptions.
*   Direct links from anomalous items to supporting documentation or report files.
*   Natural Language Querying (e.g., "Show me the biggest expense changes this quarter"). 