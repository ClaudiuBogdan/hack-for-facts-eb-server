I have another problem. I need to solve with the monthly data. Each month includes the amount from the previous month, which means the various accumulated from the beginning of the year. I need an algorithm that calculates the difference between the previous month and the current one in order to generate the real amount for that month. We can create columns for the original values and keep them for reference or other computations, but to display the data for each month we need to compute the value by subtracting the previous month value. What do you think about this problem and how should I approach it? Should I leave the original value in the table and then the computer at runtime or have that cashed in the database and use it?

---

Great problem to solve—and super common with public finance data. In short: each monthly figure you receive is YTD (cumulative), but you want the true month-only amount. The right approach is:
 • Keep the raw YTD value (for auditability and re-imports).
 • Store the month-only value computed once during ETL at the finest grain you have.
 • Validate with a quick reconciliation check.
 • Fall back to an on-the-fly window function view if you ever need to recompute/verify.

Here’s a concise, production-friendly plan.

1) Table design (store both)

Make the normalized amount the one you use in analytics/UI, and keep the raw YTD for traceability.

-- Suggested structure for MonthlyExecutionLineItems (key columns only shown)
CREATE TABLE MonthlyExecutionLineItems (
  line_item_id        BIGSERIAL,
  monthly_report_id   TEXT NOT NULL REFERENCES MonthlyReports(monthly_report_id) ON DELETE CASCADE,
  entity_cui          VARCHAR(20) NOT NULL REFERENCES Entities(cui),
  main_creditor_cui   VARCHAR(20) REFERENCES Entities(cui),
  budget_sector_id    INT NOT NULL REFERENCES BudgetSectors(sector_id),
  funding_source_id   INT NOT NULL REFERENCES FundingSources(source_id),
  functional_code     VARCHAR(20) NOT NULL REFERENCES FunctionalClassifications(functional_code),
  economic_code       VARCHAR(20) REFERENCES EconomicClassifications(economic_code),
  program_code        VARCHAR(50),
  account_category    CHAR(2) NOT NULL CHECK (account_category IN ('vn','ch')),
  year                INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month               INT  NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- NEW: keep raw YTD as delivered + compute true monthly amount
  raw_amount_ytd      DECIMAL(18,2) NOT NULL,
  amount              DECIMAL(18,2) NOT NULL, -- month-only (normalized)

  PRIMARY KEY (line_item_id, year)
) PARTITION BY RANGE (year);

-- Ensure one row per grain for a given report/month
CREATE UNIQUE INDEX ux_monthly_grain
ON MonthlyExecutionLineItems (
  monthly_report_id, entity_cui, main_creditor_cui, budget_sector_id,
  funding_source_id, functional_code, economic_code, COALESCE(program_code, ''), account_category
);

Why store both?
 • YTD is what the source provides (you need it for auditing and debugging corrections).
 • Month-only is what you actually query/graph 99% of the time; computing it once is faster and avoids repeating window functions on every request.

2) ETL: compute the monthly amount with a window function

Load into a staging table exactly as delivered (one year+month per line), then insert into the partitioned table computing the delta via LAG(...).

-- stg_monthly_line_items columns should mirror the grain above and include ytd_amount
-- Example insert that computes the month-only amount:
INSERT INTO MonthlyExecutionLineItems (
  monthly_report_id, entity_cui, main_creditor_cui, budget_sector_id,
  funding_source_id, functional_code, economic_code, program_code,
  account_category, year, month, raw_amount_ytd, amount
)
SELECT
  s.monthly_report_id,
  s.entity_cui,
  s.main_creditor_cui,
  s.budget_sector_id,
  s.funding_source_id,
  s.functional_code,
  s.economic_code,
  s.program_code,
  s.account_category,
  s.year,
  s.month,
  s.ytd_amount                                       AS raw_amount_ytd,
  s.ytd_amount - COALESCE(
    LAG(s.ytd_amount) OVER (
      PARTITION BY
        s.entity_cui, s.main_creditor_cui, s.budget_sector_id,
        s.funding_source_id, s.functional_code, s.economic_code,
        COALESCE(s.program_code, ''), s.account_category, s.year
      ORDER BY s.month
    ),
    0
  )                                                  AS amount
FROM stg_monthly_line_items s
-- (optional) limit to the year/report you're loading now
;

-- Idempotent upsert (in case of re-runs / revised reports)
-- Use the same unique key as ux_monthly_grain:
INSERT INTO MonthlyExecutionLineItems ( ... )
SELECT ...
ON CONFLICT ON CONSTRAINT ux_monthly_grain
DO UPDATE SET
  raw_amount_ytd = EXCLUDED.raw_amount_ytd,
  amount         = EXCLUDED.amount;

Notes:
 • January: LAG(...) returns NULL, so COALESCE(..., 0) makes January’s monthly amount = January YTD (correct).
 • Missing months: the delta will capture the gap (fine—because that’s exactly when the change occurred).
 • Corrections: if a revised YTD goes down, amount becomes negative in that month. Keep it negative (it’s an accounting correction); you can flag it in analytics if you want.

3) Indexing (fast reads)

-- Primary access path for charts/tables
CREATE INDEX idx_monthly_entity_year_month
ON MonthlyExecutionLineItems (entity_cui, year, month)
INCLUDE (amount, functional_code, economic_code, account_category);

-- Helpful for time-ranged scans
CREATE INDEX idx_monthly_year_month_brin
ON MonthlyExecutionLineItems USING brin (year, month);

4) Reconciliation & quality checks

Quick “does it add up?” query—great for CI or post-load:

-- For each grain, the sum of monthly amounts Jan..Dec should equal Dec YTD
SELECT
  entity_cui, main_creditor_cui, budget_sector_id, funding_source_id,
  functional_code, economic_code, COALESCE(program_code, '') AS program_code, account_category, year,
  SUM(amount)                                   AS sum_monthly,
  MAX(CASE WHEN month = 12 THEN raw_amount_ytd END) AS dec_ytd
FROM MonthlyExecutionLineItems
GROUP BY 1,2,3,4,5,6,7,8,9
HAVING SUM(amount) <> MAX(CASE WHEN month = 12 THEN raw_amount_ytd END);

5) If you prefer to compute at read-time (optional)

You can keep only raw_amount_ytd and expose a view or materialized view that derives amount with LAG(...). This is simpler to maintain but heavier for live queries; a materialized view is a good compromise.

CREATE MATERIALIZED VIEW vw_MonthlyNormalized AS
SELECT
  m.*,
  m.raw_amount_ytd

- COALESCE(LAG(m.raw_amount_ytd) OVER (
      PARTITION BY entity_cui, main_creditor_cui, budget_sector_id,
                   funding_source_id, functional_code, economic_code,
                   COALESCE(program_code, ''), account_category, year
      ORDER BY month
    ), 0) AS amount
FROM MonthlyExecutionLineItems m;

CREATE INDEX idx_mv_monthly_entity_year_month
ON vw_MonthlyNormalized (entity_cui, year, month);

Refresh it after each import:

REFRESH MATERIALIZED VIEW CONCURRENTLY vw_MonthlyNormalized;

6) Recommendation (what I’d do)
 • ETL-normalize and store both: raw_amount_ytd (source truth) and amount (month-only).
 • Use the stored amount for all UI/analytics.
 • Keep a validation query (above) and optionally a materialized view as a verification tool or fallback.
 • Compute at the finest grain you have (entity + sector + funding + functional + economic + program + account_category + year + month). Summations over this grain will always be correct.

This gives you correctness, speed, and debuggability—with minimal runtime cost.
