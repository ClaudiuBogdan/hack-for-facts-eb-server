# Observed report differences — 17 September 2026

The owner chose differences between available cumulative reports. A missing
report stays a chart gap; a reported zero stays zero; negative differences stay
negative. Quarterly endpoints include the last available report in the quarter.
No new API fields or period types are needed.

The server retains financial and source filters while reading the new monthly
and quarterly roles. A declared-zero source report supplies zero only when it is
admitted and has no facts anywhere for its exact identity. Compensation facts
from a positive-to-zero cumulative movement retain their negative amount.
Aggregate thresholds apply after aggregation, including zero observations.

Astra reviewed the SQL and source/amount boundaries. The final real-DDL E2E run
passes 111 checks. Related unit/integration checks pass 364 with 224 existing
skips; the two suites with updated old assertions were rechecked (22 passed).
GLM 5.3 max reviewed the code only, with tools denied, as a lower-trust security
reviewer. Its suggestion to remove source-sector filtering was rejected: the
real DDL has that column and removing it would mix scopes. Regression tests
verify sector exclusion. No other security findings remain.

Deploy only to DEV after the ETL observed-role migration and 2026 convergence.
Phoenix PROD remains untouched. Historical ETL role convergence is separate.
