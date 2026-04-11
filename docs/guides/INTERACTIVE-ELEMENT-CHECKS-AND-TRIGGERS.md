# Interactive Element Checks And Triggers

This guide is for maintainers who add a new interactive element that needs:

- campaign-admin review visibility
- server-side validation checks
- automatic review handling
- approval-time triggers or other side effects

The current implementation has two separate concerns:

1. Safe review projection for the admin queue
2. Server-owned side effects for specific approved interactions

Keep those concerns separate. Do not expose raw user JSON in the admin queue, and do not let the client choose privileged triggers directly.

## 1. Decide the interaction category

For a new interactive element, decide which bucket it belongs to:

- `immediate` state only
  No async review, no admin queue, no server-side trigger
- `async_review` with data-only approval
  Review changes stored state only
- `async_review` with approval trigger
  Approval may create correspondence, notifications, or other downstream work
- automatic worker check
  A user-event or sync hook can auto-approve, auto-reject, or hold the record

If the interaction is only `immediate`, you usually do not need the campaign-admin queue.

## 2. Add a safe payload parser

Create or extend a typed parser in:

- [src/common/campaign-user-interactions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/common/campaign-user-interactions.ts:1)

Rules:

- Validate with TypeBox `Value.Check`
- Normalize legacy shapes if needed
- Return only fields that the server actually needs
- Keep sensitive fields out of admin projection helpers unless they are required for review

If the interaction already has a dedicated domain parser, reuse it instead of duplicating logic.

## 3. Register the interaction in the campaign-admin allowlist

Update:

- [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts:1)
- [src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts:1)

Checklist:

- add the interaction id to `CAMPAIGN_REVIEW_CONFIGS`
- assign an explicit `projection`
- add the campaign step link metadata when the UI should deep-link to the form
- constrain `reviewableSubmissionPath` only when the queue must hide other submission modes
- add a `payloadSummary` branch for the safe flattened fields
- add any derived `riskFlags` only from server-owned logic, never from client labels

Rules:

- never return raw `record.value`
- never return raw `auditEvents` from the campaign-admin route
- keep correspondence thread exposure to summary fields only

## 4. Add repository/query support only when needed

The generic campaign-admin repository method already supports:

- interaction allowlists
- `submissionPath`
- keyset pagination
- thread summary filters

Relevant files:

- [src/modules/learning-progress/core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/types.ts:1)
- [src/modules/learning-progress/shell/repo/learning-progress-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts:1)

Only add new filters or indexes when the review workflow needs them.

If you add a new indexed filter:

- update [src/infra/database/user/schema.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/schema.sql:1)
- update the matching migration
- update [tests/e2e/campaign-admin-user-interaction-indexes.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/e2e/campaign-admin-user-interaction-indexes.test.ts:1)

## 5. Add automatic checks or worker logic

If the interaction should be auto-reviewed or validated asynchronously, implement that in a server-owned handler:

- user-event worker handlers live under [src/modules/user-events/shell/handlers](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers)
- sync hooks and admin-event hooks should stay narrow and explicit

Pattern to follow:

1. Load the canonical interaction row again from the repo
2. Validate eligibility from persisted state, not client intent
3. Prepare any expensive or risky action first
4. Win the review/update race before external side effects fire
5. Write review attribution with the correct `actorSource`

Current reference implementation:

- [src/modules/user-events/shell/handlers/public-debate-request-handler.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-handler.ts:1)
- [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts:1)

## 6. Add approval-time triggers carefully

If admin approval should trigger downstream behavior, extend the server-owned approval preparation flow rather than adding ad hoc route logic.

Current wiring entry point:

- [src/app/build-app.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts:1566)

Current approval-side-effect implementation:

- [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts:295)

Rules:

- prepare side effects before commit
- execute side effects only after the review transaction commits
- keep triggers allowlisted by interaction type
- preserve idempotency
- keep reviewer attribution separate from trigger execution

If a second interaction needs approval triggers, prefer adding an explicit per-interaction registry rather than extending the public-debate branch with unrelated behavior.

## 7. Update the client admin contract

When the campaign-admin response shape changes, update the client too:

- `hack-for-facts-eb-client/src/features/campaigns/buget/admin/types.ts`
- `hack-for-facts-eb-client/src/features/campaigns/buget/admin/schemas/api-schemas.ts`
- `hack-for-facts-eb-client/src/features/campaigns/buget/admin/constants.ts`
- the affected UI components under `.../admin/components/`

The client parser is strict. If the server adds a field and the client schema does not know about it, the page can fail at runtime.

## 8. Test checklist

Server tests to update:

- campaign-admin route integration:
  [tests/integration/campaign-admin-user-interactions-rest.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/integration/campaign-admin-user-interactions-rest.test.ts:1)
- legacy admin approval route if approval semantics changed:
  [tests/integration/learning-progress-admin-review-rest.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/integration/learning-progress-admin-review-rest.test.ts:1)
- worker or side-effect unit tests:
  [tests/unit/user-events/public-debate-request-handler.test.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/unit/user-events/public-debate-request-handler.test.ts:1)

Client tests to update:

- API parser tests
- admin page tests
- clipboard/export tests if the primary displayed value changes

Minimum verification for a new async-review interaction:

- it appears in metadata
- it lists with a safe `payloadSummary`
- review submit works
- hidden submission paths stay hidden when required
- side effects run only on the allowed approval path
- reviewer/source attribution is persisted correctly

## 9. Current known boundary

Today, only `public_debate_request` has full approval-time side effects. Other async-review interactions are currently data-only approvals unless explicitly extended.
