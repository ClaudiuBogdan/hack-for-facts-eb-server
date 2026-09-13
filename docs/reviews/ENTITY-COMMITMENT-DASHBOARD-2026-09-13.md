# Entity commitment dashboard adapter

The restored client dashboard needs cards, trends and classification detail from native Chronos data. `budgetCommitmentDashboard` and `get_budget_commitment_dashboard` share the same validated use case and bounded repository query. This is an additive serving API; no database schema or data changes are required.

The read is limited to one public entity, optional main creditor, one report type and at most 16 calendar years. Only the selected detail year exposes classification groups. Explicit fact-year predicates enable partition pruning. A 20,000-row guard fails rather than returning partial totals.

Coverage is derived from admitted source periods independently of financial facts and before transfer exclusion. A complete regular period needs one valid source for every known sector; values require facts, declared zero may have no facts. Identity drift, missing sectors and irregular periods null the whole period. Year reads latest YTD across financial chains; MONTH/QUARTER reads flow deltas while budget/authority remain endpoint balances. Sector terminal months are returned for disclosure. Source-validated amount nulls stay null. Existing promoted currency/CPI and annual population ports provide normalization; unsupported years remain unavailable.

Tradeoffs: known sectors are conservative for their whole year; no inferred lifecycle model. Decimal strings remain exact in transport; the existing client uses numeric widgets. This endpoint does not migrate standalone commitment-series chart editing. No online publication machinery, new migrations or materialized views are introduced.

Validation: 10 real-DDL PostgreSQL cases and 6 GraphQL/MCP/input-bound tests passed; server typecheck/build passed. Local read-only Chronos + client browser displayed Iași 2026 RON cards, breakdown and reports; 2026 EUR factor absence stayed explicit. Astra xhigh reviewed correctness and simplicity; GLM 5.3 max performed the lower-trust security review. No remaining security or correctness blocker was identified in the scoped implementation.

Deployment order: publish server dev first, verify query availability, then client dev. Phoenix production remains untouched. Rollback is the prior dev image for each application; data is unaffected. Companion client notes: `docs/entity-tabs-native-restoration.md`.
