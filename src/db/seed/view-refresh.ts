import pool from "../connection";

export const refreshViews = async () => {
  console.log("Refreshing views...");
  const client = await pool.connect();

  await client.query(`DROP MATERIALIZED VIEW IF EXISTS vw_BudgetSummary_ByEntityPeriod`);
  await client.query(`CREATE MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod AS
SELECT
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui AS entity_cui,
    eli.main_creditor_cui AS main_creditor_cui,
    e.name AS entity_name,
    u.name AS uat_name,
    u.county_name,
    u.region AS uat_region,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE -eli.amount END) AS budget_balance
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    eli.main_creditor_cui,
    e.name,
    u.name,
    u.county_name,
    u.region;

COMMENT ON MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod IS 'Summary of budget totals (income, expense, balance) aggregated by entity and reporting period';

    `);
  await client.query(`REFRESH MATERIALIZED VIEW vw_ExecutionDetails`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_FundingSource_Summary`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_UAT_Aggregated_Metrics`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_County_Aggregated_Metrics`);
  await client.query(`REFRESH MATERIALIZED VIEW vw_Category_Aggregated_Metrics`);

  console.log("Views refreshed");

  client.release();
};