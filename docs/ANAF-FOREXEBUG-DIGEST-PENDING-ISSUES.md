# ANAF / Forexebug Monthly Digest Pending Issues

**Status:** Pending
**Recorded:** 2026-07-16
**Scope:** `anaf_forexebug_digest` monthly email composition and dry-run behavior

## Verified Baseline

The June 2026 Phoenix dev digest was checked after the ANAF month load.

- Five entity report sections matched the authoritative ANAF source projection,
  Phoenix production/staging, and Phoenix dev exactly.
- June monthly values matched the underlying execution line items and the
  refreshed `mv_summary_monthly` rows.
- YTD income, expense, and balance values matched the June cumulative source
  fields after applying the application's transfer exclusions.
- May-to-June percentage changes, top-three expense chapters, labels, currency
  formatting, and rounding were correct.
- The three rendered alert numbers matched the current implementation and both
  Phoenix databases:
  - global aggregate expenses: `82,396,940,753.61 RON`
  - Cluj public-debt filter: `0 RON` with zero matching June rows
  - Ministry of Labour expenses: `20,501,664,584.45 RON`

The entity report data is not the pending problem. The issues below concern the
meaning and safety of alert sections and the limits of the current dry run.

## P1: Saved Alert Semantics Are Overridden During Digest Composition

`makeBudgetDataFetcher().fetchAlertData()` normalizes an analytics alert config,
then unconditionally replaces these fields:

- `report_period` becomes the digest month (`2026-06` in this verification)
- `normalization` becomes `total`
- `inflation_adjusted` becomes `false`
- `show_period_growth` becomes `false`

This can make the email differ materially from the chart from which the alert
was created.

Observed examples:

- Two saved alert configs requested `normalization: total_euro`, but the digest
  calculated nominal totals and displayed RON.
- The Cluj public-debt alert retained a description referring to a historical
  2022-2024 chart and a saved yearly interval, while the digest evaluated only
  June 2026. Its displayed `0 RON` is arithmetically correct for the overridden
  June filter, but it does not represent the historical chart described in the
  email.

Relevant implementation:

- `src/modules/notification-delivery/shell/data/budget-data-fetcher.ts`
- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`

### Required decision

Choose and document one contract:

1. Preserve the saved chart filter, period, normalization, and unit; or
2. Intentionally evaluate every alert for the digest month in nominal RON, but
   label the section as a monthly snapshot and do not reuse descriptions that
   imply a different period or normalization.

### Acceptance criteria

- The displayed period and unit describe the calculation actually performed.
- A saved `total_euro` alert is not silently rendered as RON.
- A historical chart description is not paired with an unrelated monthly value.
- Unit and integration tests cover both preserved-filter and monthly-snapshot
  behavior, depending on the selected contract.

## P1: Empty-Condition Alerts Cannot Trigger

All three rendered analytics alert configs had `conditions: []`.

The template interprets an empty `triggeredConditions` list as “monitoring
active.” However, an alert with no conditions cannot ever transition to a
triggered state. This makes an unconfigured series look like a functioning
alert.

Relevant implementation:

- `src/modules/notification-delivery/shell/data/budget-data-fetcher.ts`
- `src/modules/email-templates/shell/templates/anaf-forexebug-digest.tsx`

### Required decision

- Reject or exclude alert subscriptions with no conditions; or
- Model them explicitly as tracked-series updates and render different wording
  that does not imply threshold monitoring.

### Acceptance criteria

- Empty-condition configurations are not presented as active threshold alerts.
- The create/update path validates the selected contract.
- Digest composition and template tests cover empty-condition behavior.

## P2: Fallback Titles and Descriptions Can Be Misleading

One alert had no configured title and rendered as the generic `Alerta bugetara`.
Its filter covered aggregate expenses across all matching entities, producing
`82.40 mld. RON`, but the email did not explain that scope.

The Cluj alert description retained the source chart's historical wording even
though the calculation used the overridden monthly period.

### Acceptance criteria

- Every rendered alert has a meaningful title that identifies its scope.
- Descriptions are derived from, or validated against, the effective filter.
- Generic fallback copy is used only when it still explains the calculated
  value; otherwise composition fails closed or omits the section with evidence.

## P1: Digest Dry Run Does Not Validate Rendered Content

`POST /api/v1/admin/notifications/trigger-digests/anaf-forexebug` with
`dryRun: true` currently performs audience planning only. It reports eligible
source-notification and digest counts, but it does not:

- fetch entity or alert data
- validate effective periods, units, titles, or conditions
- identify source notifications that will return no renderable section
- render the email
- compare the preview with the eventual send payload

During the June dev check, the dry run reported 11 eligible source
notifications grouped into two digests. Static-series subscriptions without a
June point can still be omitted later during compose, so eligible counts are not
equivalent to rendered-section counts.

Relevant implementation:

- `src/modules/notification-delivery/core/usecases/materialize-anaf-forexebug-digests.ts`
- `src/modules/notification-delivery/shell/rest/anaf-forexebug-digest-trigger-routes.ts`
- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`

### Acceptance criteria

- Provide a non-sending preview path that executes the same data-fetch and
  section-building logic as compose.
- Return per-digest rendered-section counts and structured warnings without
  exposing recipient addresses or unsubscribe tokens.
- Do not create outbox rows, enqueue compose/send jobs, or contact the email
  provider during preview.
- A production send requires a successful preview for the same period and a
  stable, reviewable input watermark or fingerprint.

## Operational Guard Until Resolved

Before sending an ANAF / Forexebug digest in production:

1. Run the existing audience-only dry run.
2. Inspect every alert config selected for the period, including conditions,
   period, normalization, unit, title, and description.
3. Recompute representative alert values from the effective filter.
4. Render and review a non-production email for the intended period.
5. Obtain explicit approval before the production trigger.

Do not treat a successful current dry run as proof that alert content is
semantically correct.
