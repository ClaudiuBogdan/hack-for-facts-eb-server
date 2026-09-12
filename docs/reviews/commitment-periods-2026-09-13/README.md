# Native commitment intervals — 2026-09-13

The native GraphQL `budgetCommitmentPeriods` and MCP
`get_budget_commitment_periods` read published source-period metadata and the
stored base differences. They do not compute new predecessors, spread a gap over
months, or change the existing MONTH/QUARTER/YEAR frequencies or summaries.

One request requires one CUI, year and commitment report type. Month bounds select
report endpoints; each returned amount retains its complete start/end interval.
Rows remain separate by report and budget sector. All thirteen measures are exact
decimal strings, in nominal RON excluding transfers. Source-empty presence yields
null amounts; independently admitted zero and transfer-only reports may yield
zero. No cross-report total is supplied.

The reader first pages source reports, then accesses their facts through the
existing report index. It checks identity and stored period roles before transfer
exclusion. Inconsistent facts or a values report with no physical facts refuse
the response. Protected entity/creditor identities use the shared privacy rule.

## Publication boundary

`metadataAvailable` means published source-period metadata exists. Terminal month
bounds describe published sectors and are independent of pagination or endpoint
filters. They do not independently certify complete ANAF capture or every sector.

**First activation and subsequent loads must use the approved staging-only intake
and validated complete-year publication path.** Keep the default live chain
recompute/refresh path disabled for that operation. The old chain lane can replace
accepted groups while retaining refused groups; presence alone would not prove
complete initial activation through that lane. No readiness table or whole-year
fact audit is added to every serving request.

The operational caller must prove current source membership, financial admissions,
detached output and matching summaries before the atomic switch. It must not set
`intervalReadModelReady` solely because this code compiles. Check the deployed API
and native client and record the exact deployment revisions first.

## Review and validation

- Astra xhigh advisory and final delta review: no blocking findings in scope.
- GLM security review requested with `zai-coding-plan/glm-5.3#max`, plan/read-only.
  Lower-trust findings assessed by the implementing agent: `is_yearly` intentionally
  equals latest YTD; non-admitted facts intentionally refuse; source URLs have a
  NOT NULL HTTP(S) database check and a client URL check; organization CUI is unique.
  No reviewer ran operational commands or read credentials.
- Full server types, lint, circular-dependency check and 5,328 unit/integration
  tests passed (227 existing skips). Two focused GraphQL/MCP contract tests passed.
- Real pinned scrapper migration DDL tests cover exact cents, all thirteen measures,
  quarter/irregular spans, transfers, empty/zero, mixed cutoffs, pages, identity,
  same-report legacy corruption, missing facts and strict-role activation.
- Local logs: `/private/tmp/commitment-periods-20260913/`.

No production database, application deployment or migration was changed by this
implementation. No new database schema is required by this reader beyond the
already-approved source-period migrations.
