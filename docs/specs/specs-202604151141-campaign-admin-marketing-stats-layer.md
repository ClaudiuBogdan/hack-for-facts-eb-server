# Campaign Admin Marketing Stats Layer

**Status**: Draft
**Date**: 2026-04-15
**Author**: Codex

## Problem

The current campaign-admin API is strong on operations and review workflows, but weak on behavioral analytics.

Today the admin surface can answer questions like:

- which interaction records exist
- which items are pending review
- which entities have subscribers or failed notifications
- which correspondence threads are waiting for admin review

It cannot reliably answer questions like:

- how many users viewed a challenge before starting it
- where users drop between content discovery, challenge start, submission, review, and completion
- how long users spend on a step or challenge
- whether campaign emails drive return visits, challenge starts, or completions
- which cohorts retain, stall, or convert across multiple entities or challenges

The main gap is structural: `userinteractions` stores the latest snapshot per user and per record key, plus a narrow audit trail of `submitted` and `evaluated` events. That is enough for operational review, but not enough to reconstruct content exposure, draft abandonment, CTA engagement, or retention windows.

## Context

### Current endpoint audit

| Endpoint                                                                                                           | Current data exposed                                                                                                                                  | Useful for                           | Main gaps                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/campaigns/:campaignKey/user-interactions/meta`                                                  | total items, risk-flagged items, institution-thread coverage, review counts, phase counts, thread-phase counts, available interaction types           | operational campaign health          | no challenge/module breakdown, no unique-user metrics, no trends, no retention, no view or click data   |
| `GET /api/v1/admin/campaigns/:campaignKey/user-interactions`                                                       | per-record interaction audit row with lesson, entity, phase, review, payload summary, submission path, risk flags, thread summary, audit event counts | review queue, moderation, debugging  | latest record snapshot only, no step impressions, no dwell time, no CTA clicks, no ordered user journey |
| `POST /api/v1/admin/campaigns/:campaignKey/user-interactions/reviews`                                              | admin review write path and reviewed rows                                                                                                             | review workflow                      | no review latency stats or downstream conversion summary                                                |
| `GET /api/v1/admin/campaigns/:campaignKey/users/meta`                                                              | total users, users with pending reviews                                                                                                               | campaign coverage                    | no activation stage, no cohorts, no return behavior                                                     |
| `GET /api/v1/admin/campaigns/:campaignKey/users`                                                                   | per-user interaction count, pending review count, latest activity, latest entity                                                                      | lightweight user rollup              | no progression stage, no completions, no retention, no first/last milestone model                       |
| `GET /api/v1/admin/campaigns/:campaignKey/entities/meta`                                                           | total entities and counts with pending reviews, subscribers, notification activity, failed notifications                                              | entity coverage                      | no entity conversion funnel, no correspondence outcome metrics                                          |
| `GET /api/v1/admin/campaigns/:campaignKey/entities` and `/:entityCui`                                              | per-entity user count, interaction count, pending reviews, subscriber counts, notification counts, latest interaction and notification                | entity operations                    | no subscriber-to-action conversion, no request-to-resolution funnel, no trend data                      |
| `GET /api/v1/admin/campaigns/:campaignKey/notifications`                                                           | outbox audit rows with projections for welcome, entity subscription, entity updates, admin failure, reviewed interaction                              | message audit and trigger validation | no open or click metrics, no per-template conversion attribution                                        |
| `GET /api/v1/admin/campaigns/:campaignKey/notifications/meta`                                                      | pending delivery count, failed delivery count, reply-received count                                                                                   | delivery health                      | no delivered-open-click funnel, no downstream progression attribution                                   |
| `GET /api/v1/admin/institution-correspondence/replies`, `GET /threads/:threadId`, `POST /threads/:threadId/review` | pending replies, full threads, resolution write path                                                                                                  | correspondence operations            | no aggregate SLA, reply latency, review latency, or resolution mix                                      |
| `GET /api/v1/campaigns/:campaignId/subscription-stats`                                                             | campaign total subscribers and per-UAT subscriber counts                                                                                              | public campaign reach                | public-only, no behavioral conversion context                                                           |

### Current authoritative data sources

- `userinteractions`
  Stores the latest interactive record per `user_id` and `record_key`, plus `audit_events`.
- `institutionemailthreads`
  Stores platform-send thread state, reply state, and admin-reviewed correspondence outcomes.
- `notifications`
  Stores active campaign preferences and entity subscriptions.
- `notificationsoutbox`
  Stores durable delivery lifecycle and campaign notification metadata.
- `resend_wh_emails`
  Stores webhook events, including `email.opened` and `email.clicked`, plus click link and timestamp.
- `v_public_debate_campaign_user_total` and `v_public_debate_uat_user_counts`
  Already provide lightweight public campaign subscription rollups.

### Important constraints

- The current learning-progress sync model is authoritative for record state and review state.
- Client sync may not write arbitrary server-owned review metadata.
- Stats endpoints may expose only `user_id` plus allowlisted user payload summaries needed for analytics. They must not expose user email addresses, institution email addresses, recipient lists, email subjects, rendered email bodies, or correspondence content.
- Analytics storage must not duplicate sensitive payloads such as raw emails, raw notification content, free-text responses, or correspondence bodies.
- Existing admin routes are already useful; the stats layer should extend them, not replace them.
- Ratio fields should be returned as integer basis points or decimal strings, not floats, to stay aligned with existing numeric constraints.

### Security and data exposure boundary

The analytics layer is intentionally narrower than the operational admin layer.

Allowed in stats:

- `user_id`
- campaign, module, challenge, step, lesson, interaction, entity, and thread identifiers
- submission path, phase, review status, resolution code, and similar enums
- allowlisted user payload summaries that are required for analytics
- aggregate notification delivery, open, and click counts
- normalized click destination categories when tokens and raw URLs are stripped

Forbidden in stats:

- user email addresses from auth, notifications, or delivery systems
- institution email fields such as `primariaEmail` or thread recipient addresses
- `to`, `cc`, `bcc`, message ids, raw webhook headers, or attachment metadata when they reveal email content
- rendered email subject, HTML, text, and any raw email body content
- raw correspondence entries, reply bodies, attachments, or admin review notes
- raw click links or unsubscribe links containing tokens or unique identifiers
- arbitrary raw JSON payload dumps

Implementation rule:

- user-level analytics rows are keyed by `user_id`
- payload data must be transformed into an allowlisted summary shape before it can enter analytics storage or stats responses
- if a field is not explicitly allowlisted for analytics, it is treated as forbidden

### What we can already infer without new client events

- submit-to-review latency from `submittedAt`, `updatedAt`, and `review.reviewedAt`
- operational review mix by admin vs system review source
- debate-request approval, rejection, and thread-phase distribution
- notification delivery health from `notificationsoutbox`
- notification opens and clicks from `resend_wh_emails`
- reply-review resolution mix from `institutionemailthreads`

### What we cannot infer reliably today

- content views
- CTA clicks inside challenge pages
- active time spent
- challenge starts before a draft or submit
- draft abandonment rate
- retention windows based on actual campaign visits
- full path ordering across challenge steps

### Available today vs future telemetry

| Metric or stage                   | Available today | Source of truth                     | Derivation rule                                                     | Needs new client event |
| --------------------------------- | --------------- | ----------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| campaign terms accepted           | yes             | `userinteractions`, `notifications` | terms-accepted records and auto-subscription side effects           | no                     |
| entity subscribed                 | yes             | `notifications`                     | active `funky:notification:entity_updates` rows                     | no                     |
| interaction submitted             | yes             | `userinteractions`                  | `submittedAt`, phase, and `submitted` audit events                  | no                     |
| interaction reviewed              | yes             | `userinteractions`                  | `review.status`, `review.reviewedAt`, `reviewSource`                | no                     |
| interaction completed or failed   | yes             | `userinteractions`                  | phase and review outcome                                            | no                     |
| thread started                    | yes             | `institutionemailthreads`           | platform-send thread created for campaign and entity                | no                     |
| reply received                    | yes             | `institutionemailthreads`           | thread phase and correspondence snapshots                           | no                     |
| reply reviewed and resolved       | yes             | `institutionemailthreads`           | `latestReview`, resolution code, terminal phase                     | no                     |
| email delivered                   | yes             | `notificationsoutbox`               | outbox delivery status                                              | no                     |
| email opened                      | yes             | `resend_wh_emails`                  | provider webhook event correlated to outbox                         | no                     |
| email clicked                     | yes             | `resend_wh_emails`                  | provider webhook event correlated to outbox                         | no                     |
| campaign discovered               | no              | none today                          | requires first-touch client telemetry                               | yes                    |
| content viewed                    | no              | none today                          | requires page or step view telemetry                                | yes                    |
| CTA clicked on campaign pages     | no              | none today                          | requires client CTA instrumentation                                 | yes                    |
| challenge started before submit   | no              | none today                          | requires explicit start or first-step telemetry                     | yes                    |
| draft saved                       | partial         | `userinteractions`                  | draft phase exists, but abandonment is not reconstructable reliably | yes                    |
| active time spent                 | no              | none today                          | requires client-side active-time tracking                           | yes                    |
| retention based on actual revisit | no              | none today                          | requires visit or session telemetry                                 | yes                    |

## Decision

### 1. Use a dedicated stats module and keep operational read models separate

The existing campaign-admin endpoints should remain the operational source for review queues, entity worklists, notification audit, and correspondence actions.

The stats layer should sit beside them as a separate read-optimized analytics slice, not be scattered across the existing operational modules.

Recommended shape:

- new module: `campaign-admin-stats` or `campaign-analytics`
- separate rest schemas for sanitized analytics DTOs
- separate repo backed by SQL views and query helpers
- statement timeout, pagination, and optional caching modeled after `campaign-subscription-stats`
- explicit prohibition on reusing operational DTOs from `campaign-admin`, `campaign-admin-entities`, `campaign-admin-notifications`, or `institution-correspondence`

This matches an existing repo pattern better than embedding analytics logic into the operational route modules.

### 2. Roll out the analytics layer in phases

The spec should be implemented incrementally.

#### Phase 1. Derive-only analytics from current authoritative tables

- build stats from `userinteractions`, `institutionemailthreads`, `notifications`, `notificationsoutbox`, and `resend_wh_emails`
- add dedicated `/stats/*` routes
- add only compact summary blocks to selected `meta` endpoints
- do not introduce a broad new event-ingestion platform yet

This phase supports the operational public-debate funnel and notification health metrics with current data.

#### Phase 2. Append server-side milestones from authoritative writes

- append analytics milestones only from server-owned state transitions such as review saved, thread started, reply received, reply reviewed, and notification delivered
- write these from authoritative mutation paths, not from best-effort replay of operational list endpoints
- do not treat the current `user-events` queue as a general-purpose analytics bus

The current `user-events` flow is narrow and best-effort; it is useful as a local hook, but it is not yet a replayable analytics event platform.

#### Phase 3. Add dedicated client telemetry

- add a dedicated ingestion path for `campaign.discovered`, `content.viewed`, `content.cta_clicked`, `challenge.started`, `challenge.step_viewed`, active time, and revisit sessions
- keep these events clearly marked as client telemetry
- do not mix speculative client events into phase-1 operational stats

### 3. Introduce a narrow analytics fact table only after phase 1 is stable

Phase 1 can be view-backed only. If phase-2 or phase-3 needs append-only storage, introduce a new user-db table with a narrow, allowlisted schema:

`campaign_analytics_events`

| Field                    | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `id`                     | event id                                                                                  |
| `campaign_key`           | campaign partition key                                                                    |
| `occurred_at`            | event timestamp                                                                           |
| `event_date`             | date bucketing                                                                            |
| `user_id`                | authenticated user id, nullable only for pre-auth campaign reach if needed later          |
| `session_id`             | coarse visit/session grouping                                                             |
| `entity_cui`             | entity scope when relevant                                                                |
| `module_slug`            | content grouping                                                                          |
| `challenge_slug`         | funnel grouping                                                                           |
| `step_slug`              | drop-off grouping                                                                         |
| `lesson_id`              | compatibility with current learning-progress records                                      |
| `interaction_id`         | interaction grouping                                                                      |
| `record_key`             | operational join-back when needed                                                         |
| `notification_outbox_id` | notification attribution                                                                  |
| `notification_type`      | message family attribution                                                                |
| `thread_id`              | correspondence attribution                                                                |
| `submission_path`        | `request_platform`, `send_yourself`, and later values                                     |
| `event_name`             | normalized analytics event name                                                           |
| `source`                 | `client`, `learning_progress`, `user_event_worker`, `campaign_admin`, `webhook`, `system` |
| `active_seconds`         | coarse engagement duration in integer seconds, nullable                                   |
| `metadata`               | allowlisted dimensions and allowlisted payload summary only                               |
| `created_at`             | ingestion timestamp                                                                       |

Rules:

- the only user-level identifier exposed by analytics is `user_id`
- store only allowlisted payload summaries derived from the user payload; do not copy raw interaction JSON into analytics
- never store or expose user email addresses, institution email addresses, recipient lists, rendered email content, or correspondence bodies in analytics
- prefer booleans and enums such as `has_official_email`, `email_matches_official`, `review_status`, `resolution_code`
- treat this table as append-only; corrections are new events, not in-place mutation

#### Fact table contract

- required columns in every row:
  `id`, `campaign_key`, `occurred_at`, `event_date`, `event_name`, `source`, `created_at`
- optional dimensions:
  `user_id`, `entity_cui`, `lesson_id`, `interaction_id`, `record_key`, `notification_outbox_id`, `notification_type`, `thread_id`, `submission_path`, `session_id`, `module_slug`, `challenge_slug`, `step_slug`, `active_seconds`, `metadata`
- event ids must be deterministic and idempotent when emitted from server-owned state transitions
- late-arriving corrections must be encoded as new events, not row mutation
- backfills must be explicit, versioned, and safe to rerun
- retention policy must be defined before client telemetry is added
- indexes should start with `campaign_key + event_date`, plus targeted indexes for `user_id`, `entity_cui`, `interaction_id`, `thread_id`, and `notification_outbox_id` only when queries require them
- averages and medians exposed by APIs must use integer seconds, integer hours, basis points, or decimal strings; do not introduce float API fields

### 4. Normalize event families, but separate current-state milestones from future telemetry

Capture a small set of business-level events, with explicit provenance.

#### Available now from server-side state

- `campaign.terms_accepted`
- `subscription.entity_added`
- `challenge.submitted`
- `challenge.reviewed`
- `challenge.completed`
- `challenge.failed`
- `notification.sent`
- `notification.delivered`
- `notification.opened`
- `notification.clicked`
- `notification.bounced`
- `notification.suppressed`
- `correspondence.thread_started`
- `correspondence.thread_failed`
- `correspondence.reply_received`
- `correspondence.reply_reviewed`
- `correspondence.resolved_positive`
- `correspondence.resolved_negative`
- `correspondence.manual_follow_up_needed`

#### Content engagement events

- `campaign.discovered`
- `content.viewed`
- `content.engaged`
- `content.cta_clicked`
- `challenge.started`
- `challenge.step_viewed`
- `challenge.draft_saved`

Producer mapping:

- authoritative server writes emit submit, review, completion, subscription, and correspondence milestones
- notification delivery and resend webhooks emit delivery, open, click, bounce, and suppress
- future client app telemetry emits discovery, view, engagement, CTA, start, step-view, and draft-save

### 5. Build rollups as views first, materialize only when needed

Phase 1 should rely on dedicated SQL views or query helpers over current tables.

Start with:

- `userinteractions`
- `institutionemailthreads`
- `notifications`
- `notificationsoutbox`
- `resend_wh_emails`

Add `campaign_analytics_events` to the rollup set only once phase 2 or phase 3 introduces append-only analytics storage.

Recommended initial rollups:

- `v_campaign_stats_overview_daily`
- `v_campaign_content_engagement_daily`
- `v_campaign_challenge_funnel_daily`
- `v_campaign_user_progression_snapshot`
- `v_campaign_entity_funnel_snapshot`
- `v_campaign_notification_engagement_daily`

Only materialize when:

- a dashboard needs longer windows
- admin queries exceed acceptable latency
- the same aggregates are requested repeatedly

### 6. Define a sanitized analytics DTO boundary

Analytics responses must use dedicated sanitized DTOs.

Rules:

- analytics routes must not reuse operational payload schemas from `campaign-admin` interaction rows
- analytics routes must not reuse thread or message schemas from `institution-correspondence`
- raw `resend_wh_emails` rows must never be returned directly from stats routes
- click data must be normalized into route, target, or template categories before exposure
- analytics DTOs may expose only `user_id` and allowlisted payload summary fields

### 7. Stats response schema

Use one dedicated stats namespace for heavy analytics queries:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/content`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/funnel`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/retention`

Phase-1 responses should only populate fields that are derivable from current authoritative backend state. Metrics that depend on future client telemetry should be omitted, marked unavailable, or returned as `null` until the telemetry source exists.

Core response shapes:

```ts
interface RateMetric {
  numerator: number;
  denominator: number;
  rateBps: number;
}

interface CampaignStatsOverview {
  coverage: {
    hasClientTelemetry: boolean;
    hasNotificationAttribution: boolean;
  };
  window: { from: string; to: string; timezone: string; granularity: 'day' | 'week' };
  acquisition: {
    newActivatedUsers: number;
    returningUsers: number;
    entitySubscribersAdded: number;
  };
  engagement: {
    uniqueViewers: number | null;
    engagedUsers: number | null;
    ctaClicks: number | null;
    avgActiveSeconds: number | null;
    medianActiveSeconds: number | null;
    viewToClick: RateMetric | null;
  };
  progression: {
    challengeStarters: number | null;
    draftSavers: number | null;
    submitters: number;
    approvedUsers: number;
    completedUsers: number;
    startToSubmit: RateMetric | null;
    submitToApprove: RateMetric;
    startToComplete: RateMetric | null;
    medianHoursToFirstCompletion: number | null;
  };
  correspondence: {
    threadsStarted: number;
    repliesReceived: number;
    positiveResolutions: number;
    replyRate: RateMetric;
    positiveResolutionRate: RateMetric;
  };
  notifications: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    deliveredToOpen: RateMetric;
    openToClick: RateMetric;
  };
}

interface ChallengeFunnelSlice {
  challengeSlug: string;
  moduleSlug: string | null;
  viewers: number | null;
  starters: number | null;
  draftSavers: number | null;
  submitters: number;
  approvedUsers: number;
  completedUsers: number;
  dropOffBeforeStartBps: number | null;
  dropOffBeforeSubmitBps: number | null;
  dropOffBeforeCompletionBps: number;
}

interface RetentionSlice {
  cohortDate: string;
  activatedUsers: number;
  retainedD1: number | null;
  retainedD7: number | null;
  retainedD30: number | null;
  retainedD1Bps: number | null;
  retainedD7Bps: number | null;
  retainedD30Bps: number | null;
}
```

### 8. Make `/stats/*` the primary analytics surface

Dedicated analytics routes should be the default way to access this data:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/content`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/funnel`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/retention`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/entities`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/notifications`

Existing operational endpoints should stay narrow and stable.

### 9. Embed only compact summaries into existing endpoints

Do not push full analytics payloads into every operational route. Existing list and detail routes should remain operational; if they gain analytics fields at all, keep those fields to small precomputed summaries, preferably on `meta` endpoints only.

Recommended integration points:

#### `user-interactions/meta`

Add:

- `byInteraction`
- `byChallenge`
- `reviewLatency`
- `submissionPathMix`

This gives marketing and analytics a campaign summary without loading full lists.

#### `users/meta`

Add:

- counts by journey stage
- counts by first completed challenge

Boundary:

- keep user-level analytics in `/stats/*`, not the operational `/users` list
- do not enrich operational user rows with email, correspondence, or notification-recipient identity fields

#### `entities/meta`

Add:

- counts and rates for subscriber-to-contributor, request-to-thread, and reply-to-resolution
- no full funnel payloads on operational entity list rows

Entity-level deep analytics should live under `/stats/entities`.

#### `notifications/meta`

Add:

- delivered, opened, clicked, bounced, suppressed counts
- open and click rates by notification type and template

Boundary:

- expose aggregate delivery and engagement metrics only
- do not expose rendered email subject, HTML, text, recipient email, or raw clicked URLs
- if click destinations are useful, expose normalized route or campaign target categories only

Attribution-heavy downstream conversion metrics should live under `/stats/notifications`, not the operational notification audit endpoints.

#### `institution-correspondence` admin meta

Either add a small `meta` route or extend the replies list payload with:

- pending reply count
- median hours to first reply
- median hours from reply received to admin review
- resolution mix

This keeps operational correspondence tooling connected to campaign outcome analytics.

### 10. Define notification attribution explicitly

Notification attribution should be specified before metrics such as `clickedUsersWhoStartedChallenge` are implemented.

Rules:

- correlation starts from `notificationsoutbox.id` and provider email ids
- opens and clicks come from `resend_wh_emails`
- raw click URLs must be normalized into route or campaign target categories before they are used in analytics
- attribution windows must be explicit, for example `click -> challenge submit within 7 days`
- attribution outputs must be labeled directional, not causal
- if `resend_wh_emails` is minimized later, attribution queries must continue to work from normalized and pre-sanitized derived fields rather than raw provider payloads

### 11. Funnel model

Use two complementary funnels, but distinguish what is available now from what requires new telemetry.

#### Current-state public-debate operational funnel

1. `campaign.terms_accepted`
2. `subscription.entity_added`
3. `challenge.submitted`
4. `challenge.reviewed`
5. `challenge.completed` or `challenge.failed`
6. `correspondence.thread_started`
7. `correspondence.reply_received`
8. `correspondence.reply_reviewed`
9. `correspondence.resolved_positive` or `correspondence.resolved_negative`

This funnel is grounded in current authoritative backend state and can be implemented first.

#### Future content-engagement funnel

1. `campaign.discovered`
2. `content.viewed`
3. `content.engaged`
4. `content.cta_clicked`
5. `challenge.started`
6. `challenge.step_viewed`
7. `challenge.draft_saved`
8. `challenge.submitted`
9. `challenge.completed`
10. revisit in D1, D7, or D30 window

This funnel is valuable for marketing, but it requires dedicated client telemetry and should be treated as future scope until those events exist.

Disengagement should be reported at every edge:

- viewed but not started
- started but not saved
- saved but not submitted
- submitted but rejected
- approved but thread not started
- thread started but no reply
- reply received but unresolved

### 12. Additional insight opportunities

#### Signals we already have and should expose

- email opens and clicks from `resend_wh_emails`
- normalized click destination categories from Resend webhook click payloads, after stripping raw URLs and tokens
- submit-to-review latency from learning-progress timestamps
- system-review vs admin-review mix from `reviewSource`
- correspondence resolution codes and thread phases
- selected-entity breadth from welcome and subscription metadata

#### Signals we should start capturing

- first campaign entry source and referrer or UTM bucket
- challenge and step views
- CTA click ids and destinations
- coarse active seconds per step or challenge
- draft-save events
- entity unsubscription and removal events
- first and repeat visit session ids
- notification-to-visit attribution window markers

#### Signals we should avoid storing in analytics

- user email addresses of any kind
- raw institution emails
- notification recipient addresses
- rendered email subject, HTML, and text
- free-text form answers
- raw email bodies
- raw reply bodies
- raw clicked URLs containing user-specific tokens
- arbitrary payload JSON copies

### 13. Actionable outputs for teams

For marketing:

- top content by view-to-start conversion
- top CTAs by click-to-start conversion
- challenges with the highest pre-submit drop-off
- notification templates with high open but low click rates
- segments of users who completed one challenge but did not return within 7 days

For data analytics:

- challenge funnel by entity, UAT, and submission path
- approval and rejection mix by interaction type
- review SLA and correspondence SLA over time
- request-to-resolution outcomes by entity and campaign slice
- subscriber-to-contributor conversion by entity and region

## Alternatives Considered

### Infer everything from current tables only

Rejected because it cannot reconstruct content views, CTA clicks, active time, or draft abandonment. The current snapshot model is not a true event stream.

### Put all analytics into existing meta endpoints only

Rejected because heavy funnel and retention queries do not belong in operational list endpoints. That would bloat route contracts and couple expensive analytics queries to every admin page load.

### Build a separate warehouse or external analytics platform now

Rejected for the current scope because the backend already has strong operational data and event hooks. A lightweight in-product fact table plus SQL rollups gives most of the value with far less integration cost.

## Consequences

**Positive**

- keeps current admin routes stable while making them more useful
- gives marketing and analytics a shared funnel vocabulary
- reuses authoritative operational tables instead of cloning them
- unlocks quick wins by exposing already-stored email open and click events
- creates a clear path from operational review data to retention and conversion reporting

**Negative**

- adds another write path and read model to the user database
- requires client instrumentation for views, CTA clicks, and active time
- retention and engagement metrics will remain incomplete until client events land
- open rates and click rates remain directional because mail clients and privacy filters distort them
- analytics queries may need materialization later if the campaign scales significantly

## References

- `src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`
- `src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `src/modules/learning-progress/core/campaign-admin-config.ts`
- `src/modules/campaign-admin-entities/shell/rest/routes.ts`
- `src/modules/campaign-admin-entities/shell/rest/schemas.ts`
- `src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts`
- `src/modules/campaign-admin-notifications/shell/rest/routes.ts`
- `src/modules/campaign-admin-notifications/shell/rest/schemas.ts`
- `src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts`
- `src/modules/institution-correspondence/shell/rest/admin-routes.ts`
- `src/modules/institution-correspondence/core/types.ts`
- `src/modules/campaign-subscription-stats/shell/rest/routes.ts`
- `src/modules/resend-webhooks/shell/repo/resend-webhook-email-events-repo.ts`
- `src/infra/database/user/schema.sql`
- `tests/e2e/campaign-admin-stats-repo.test.ts`
- `tests/e2e/campaign-admin-users-repo.test.ts`
- `tests/e2e/campaign-admin-entities-repo.test.ts`
- `tests/e2e/campaign-subscription-stats-repo.test.ts`
