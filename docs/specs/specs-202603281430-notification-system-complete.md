# Notification System - Complete Architecture

**Status**: Draft
**Date**: 2026-03-28
**Author**: Claude Code
**Supersedes**: `docs/notifications.md` (early brainstorming)
**Builds on**: `specs-202601142200-notification-delivery-module.md` (delivery pipeline)

## Problem

The transparenta.eu platform has a working subscription management system and a delivery pipeline (collect -> compose -> send), but it only supports two notification categories: periodic newsletters and threshold alerts. The platform needs to support the full lifecycle of user communication:

- **No transactional emails**: Users who register or subscribe receive no confirmation or onboarding communication. No welcome email, no subscription confirmation, no expectation-setting about notification frequency.
- **No challenge notifications**: The upcoming public budget challenge campaigns have 6 distinct trigger types (T&C acceptance, campaign requests, system reviews, deadline reminders, calendar milestones, weekly progress) with no notification infrastructure to support them.
- **No digest mechanism**: During challenge season, a user tracking 10 entities could receive 10+ emails per day. There is no throttling or batching strategy to prevent notification fatigue.
- **No calendar integration**: Public debate milestones need to appear in users' calendars, but there is no mechanism to generate or deliver calendar events.
- **No scheduled jobs**: The pipeline relies entirely on manual admin triggers. Deadline reminders, weekly updates, and stuck-sending recovery have no automated scheduling.
- **Pipeline blockers**: 5 adapter implementations required by the existing delivery pipeline are missing (DataFetcher, UserEmailFetcher, ExtendedNotificationsRepository, ExtendedTokensRepository), and workers are not wired into the application startup.

## Context

### What Exists (Implemented and Accepted)

| Component                                        | Status                    | Location                                    |
| ------------------------------------------------ | ------------------------- | ------------------------------------------- |
| Subscription CRUD API                            | Complete                  | `src/modules/notifications/`                |
| 3-stage delivery pipeline (collect/compose/send) | Complete (core + workers) | `src/modules/notification-delivery/`        |
| React Email templates (newsletter + alert)       | Complete                  | `src/modules/email-templates/`              |
| Resend client with rate limiting (2 RPS)         | Complete                  | `src/infra/email/client.ts`                 |
| Resend webhook ingestion                         | Complete                  | `src/modules/resend-webhooks/`              |
| BullMQ queue infrastructure                      | Complete                  | `src/infra/queue/client.ts`                 |
| Database schema (deliveries, tokens, webhooks)   | Complete                  | `src/infra/database/user/schema.sql`        |
| Outbox pattern with atomic claiming              | Complete                  | Delivery repo                               |
| Admin trigger endpoint                           | Complete                  | `POST /api/v1/notifications/trigger`        |
| Clerk webhook endpoint                           | Exists                    | Receives user events, no notification logic |
| Budget data queries                              | Exists                    | Available for adapter wiring                |
| Clerk SDK                                        | Integrated                | Available for email fetching                |

### What's Missing

| Component                    | Gap                                                            | Impact                                           |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| DataFetcher adapter          | No implementation for `fetchNewsletterData` / `fetchAlertData` | Compose worker cannot render                     |
| UserEmailFetcher adapter     | No Clerk email lookup                                          | Send worker cannot resolve recipients            |
| ExtendedNotificationsRepo    | No `findEligibleForDelivery` query                             | Collect worker cannot find targets               |
| ExtendedTokensRepo           | No `getOrCreateActive`                                         | Compose worker cannot generate unsubscribe links |
| Worker initialization        | Not wired into `build-app.ts`                                  | Pipeline cannot start                            |
| Transactional email types    | Not in `NotificationType` union                                | No welcome or confirmation emails                |
| Challenge notification types | Not designed                                                   | Entire challenge campaign feature blocked        |
| Digest mechanism             | No buffering or batching                                       | Notification fatigue risk                        |
| Scheduler                    | No BullMQ repeatable jobs                                      | No automated triggers                            |
| DLQ consumer                 | Queue defined, no consumer                                     | Silent data loss                                 |

### Constraints

- **Scale**: 1,000-10,000 users. Resend 2 RPS = ~7,200 emails/hour. Sufficient but batching matters.
- **Architecture**: Hexagonal/Functional Core pattern. Core must remain I/O-free, use `Result<T,E>`.
- **Compliance**: CAN-SPAM, GDPR, RFC 8058 one-click unsubscribe (already implemented in delivery module).
- **Financial precision**: `decimal.js` for all numeric values in newsletter data.
- **Timezone**: All institutional operations in `Europe/Bucharest`. Cron evaluations must account for this.

### Why Now

Challenge campaigns are the next major platform feature. They depend on the notification system for user engagement throughout the campaign lifecycle (onboarding, progress tracking, deadline enforcement, public debate participation). Newsletters and alerts also remain non-functional until the missing adapters are wired.

## Decision

### 1. Unified Pipeline with Extended Type System

Extend the existing `NotificationType` union to cover all notification categories. All types flow through the same 3-stage pipeline (collect -> compose -> send), with per-type behavior in the compose stage.

```typescript
// Extended NotificationType union
export type NotificationType =
  // Existing
  | 'newsletter_entity_monthly'
  | 'newsletter_entity_quarterly'
  | 'newsletter_entity_yearly'
  | 'alert_series_analytics'
  | 'alert_series_static'
  // Transactional (new)
  | 'transactional_welcome'
  | 'transactional_subscription_confirm'
  // Challenge (new)
  | 'challenge_tnc_accepted'
  | 'challenge_request_submitted'
  | 'challenge_system_review'
  | 'challenge_deadline_reminder'
  | 'challenge_calendar_milestone'
  | 'challenge_weekly_progress';
```

**Rationale**: Extending the union preserves compile-time exhaustiveness checks across the pipeline. Every `switch(notificationType)` statement will fail to compile when a new type is added, forcing explicit handling. The alternative (separate type systems per category) would fragment the pipeline and duplicate infrastructure.

### 2. Transactional Emails: Same Pipeline, Special Handling

Welcome and subscription confirmation emails flow through the existing pipeline with these adaptations:

- **Synthetic period key**: Use ISO timestamp (`2026-03-28T14:30:00Z`) instead of period strings. The `delivery_key` uniqueness constraint (`userId:notificationId:periodKey`) still prevents duplicates.
- **No subscription check**: Transactional types bypass the `findEligibleForDelivery` query. The trigger writes a delivery record directly.
- **No collect stage**: The Clerk webhook handler (for welcome) and the `subscribe` use case (for confirmation) write directly to the compose queue, skipping collection.e

**Welcome email trigger flow**:

```
Clerk webhook received
  -> Validate signature (Svix, already implemented)
  -> Extract user ID from event payload
  -> Generate delivery_key: "{userId}:transactional_welcome:{timestamp}"
  -> Check delivery_key uniqueness (prevents duplicate webhooks)
  -> Enqueue compose job with { notificationId: synthetic, userId, periodKey: timestamp }
  -> Compose worker renders welcome template
  -> Send worker delivers via Resend
```

**Subscription confirmation trigger flow**:

```
subscribe() use case completes successfully
  -> Check: is this the user's first-ever subscription? (count query)
  -> If first: enqueue "transactional_subscription_confirm" compose job
  -> If not first: skip (one-time per user)
  -> Compose worker renders confirmation template with onboarding tips
  -> Send worker delivers
```

**Reconciliation**: A daily BullMQ repeatable job queries Clerk for users created in the last 48 hours and cross-references against `transactional_welcome` deliveries. Any missing welcome emails are enqueued. This covers Clerk webhook delivery failures and server downtime.

### 3. Challenge Notifications: Hybrid Trigger Model

Challenge notifications use two trigger mechanisms depending on urgency:

#### Event-Driven Triggers (Immediate Write to Digest Buffer)

User-initiated actions write a **pending digest item** immediately:

| Trigger                    | Source Event                 | Digest Item Created           |
| -------------------------- | ---------------------------- | ----------------------------- |
| T&C accepted               | User interaction webhook/API | `challenge_tnc_accepted`      |
| Campaign request submitted | Interactive element event    | `challenge_request_submitted` |

These are not sent immediately. They are buffered for the daily digest (see section 4).

#### Cron Sweep Triggers (BullMQ Repeatable Jobs)

System-evaluated conditions run on schedule and write digest items in bulk:

| Trigger               | Schedule                            | Logic                                                       |
| --------------------- | ----------------------------------- | ----------------------------------------------------------- |
| System review results | Admin-triggered (existing endpoint) | Batch per user, one digest item per reviewed entity         |
| Deadline reminders    | Daily at 01:00 `Europe/Bucharest`   | Query user-entity pairs where deadline is within 7/3/1 days |
| Calendar milestones   | Daily at 01:00 `Europe/Bucharest`   | Query upcoming milestones, generate `.ics` attachments      |
| Weekly progress       | Monday 01:00 `Europe/Bucharest`     | Aggregate per-user campaign stats                           |

All cron sweeps run before the 9 AM digest dispatch, giving adequate buffer time for composition.

### 4. Daily Digest Mechanism

All challenge notifications are batched into a single daily email per user.

**Timing**:

- **Collection window**: 00:00 - 23:59 previous day (midnight cutoff)
- **Dispatch**: 09:00 `Europe/Bucharest` next day
- **Implementation**: BullMQ repeatable job at 09:00

**Digest pipeline**:

```
1. Digest dispatch job fires at 09:00
2. Query: SELECT DISTINCT user_id FROM pending_digest_items
         WHERE created_at >= midnight_yesterday AND created_at < midnight_today
         AND NOT consumed
3. For each user:
   a. Collect all pending items for this user in this window
   b. Group by challenge notification type
   c. Compose a single digest email using the digest template
   d. Create ONE delivery record (type: 'challenge_digest', key: "{userId}:challenge_digest:{date}")
   e. Mark pending items as consumed
   f. Enqueue send job
4. Send worker delivers the single digest email
```

**Database schema extension**:

```sql
CREATE TABLE PendingDigestItems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  entity_cui TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  ics_data TEXT,                              -- Pre-generated .ics content (for calendar milestones)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  consumed_by_delivery_id UUID,              -- FK to NotificationDeliveries

  CONSTRAINT chk_notification_type CHECK (notification_type IN (
    'challenge_tnc_accepted', 'challenge_request_submitted',
    'challenge_system_review', 'challenge_deadline_reminder',
    'challenge_calendar_milestone', 'challenge_weekly_progress'
  ))
);

CREATE INDEX idx_pending_digest_user_date ON PendingDigestItems (user_id, created_at) WHERE NOT consumed;
CREATE INDEX idx_pending_digest_dispatch ON PendingDigestItems (consumed, created_at);
```

**Rationale for separate staging table**: Digest items are ephemeral and high-volume. Mixing them into `NotificationDeliveries` would bloat the delivery table and complicate the outbox pattern. The staging table is append-only during the day, read-once during dispatch, and can be pruned aggressively (delete consumed items older than 30 days).

### 5. Calendar Events (.ics Attachments)

Public debate milestones generate RFC 5545 compliant `.ics` files:

- **Library**: `ical-generator` (lightweight, well-maintained, no native dependencies)
- **Event UID**: Deterministic format `{entityCui}-{milestoneId}@transparenta.eu` (enables updates via SEQUENCE increment)
- **Timezone**: `Europe/Bucharest` (VTIMEZONE component included)
- **Delivery**: Attached to the digest email as `.ics` file via Resend attachment API
- **Storage**: `.ics` content stored in `PendingDigestItems.ics_data` at creation time (cron sweep pre-generates it)

**Update strategy**: When a milestone date changes, the cron sweep detects the change (compare against last-sent milestone data in metadata), generates a new `.ics` with incremented SEQUENCE, and creates a new digest item. The user receives the update in the next daily digest.

### 6. BullMQ Repeatable Jobs (Scheduler)

All scheduled work uses BullMQ's built-in repeat mechanism. No external cron or additional libraries.

| Job Name                    | Schedule (cron)               | Timezone           | Purpose                          |
| --------------------------- | ----------------------------- | ------------------ | -------------------------------- |
| `challenge:deadline-sweep`  | `0 1 * * *` (01:00 daily)     | `Europe/Bucharest` | Evaluate deadline reminders      |
| `challenge:milestone-sweep` | `0 1 * * *` (01:00 daily)     | `Europe/Bucharest` | Evaluate calendar milestones     |
| `challenge:weekly-progress` | `0 1 * * 1` (01:00 Monday)    | `Europe/Bucharest` | Generate weekly progress items   |
| `digest:dispatch`           | `0 9 * * *` (09:00 daily)     | `Europe/Bucharest` | Collect and send digest emails   |
| `recovery:stuck-sending`    | `*/15 * * * *` (every 15 min) | UTC                | Recover stuck deliveries         |
| `reconciliation:welcome`    | `0 3 * * *` (03:00 daily)     | UTC                | Reconcile missing welcome emails |

**Initialization**: Repeatable jobs are registered during worker startup (gated by `PROCESS_ROLE: worker | both`). Each job is idempotent - BullMQ deduplicates based on repeat key.

### 7. Worker Initialization and Process Role Gating

Wire workers into `build-app.ts` using the existing `PROCESS_ROLE` config:

```typescript
// In build-app.ts
if (config.processRole === 'worker' || config.processRole === 'both') {
  const workerManager = createWorkerManager(logger);

  // Delivery pipeline workers
  workerManager.register(createCollectWorker(deps));
  workerManager.register(createComposeWorker(deps));
  workerManager.register(createSendWorker(deps));

  // Repeatable jobs (scheduler)
  await registerRepeatableJobs(queues, config);

  // Graceful shutdown
  app.addHook('onClose', () => workerManager.shutdown());
}
```

### 8. Missing Adapter Implementations

| Adapter                                               | Implementation Strategy                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DataFetcher.fetchNewsletterData()`                   | Query budget DB via existing Kysely client. Aggregate income/expenses by entity + period. Map to `NewsletterData` type.                                                          |
| `DataFetcher.fetchAlertData()`                        | Query budget DB with alert config filter. Evaluate threshold conditions. Return `AlertData` or `null` (no alert triggered).                                                      |
| `UserEmailFetcher.getEmail()`                         | Call Clerk SDK `users.getUser(userId)`. Extract primary email. Cache with 5-minute TTL (in-memory Map with expiry).                                                              |
| `ExtendedNotificationsRepo.findEligibleForDelivery()` | LEFT JOIN `Notifications` with `NotificationDeliveries` on delivery_key. Return notifications where no delivery exists for this period OR delivery is in terminal failure state. |
| `ExtendedTokensRepo.getOrCreateActive()`              | SELECT active token for (userId, notificationId). If none or expired, INSERT new token with 365-day expiry. Return token string.                                                 |

### 9. Observability

| Layer                | Mechanism                             | Implementation                                                                                                          |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Queue metrics**    | BullMQ event listeners                | Log queue depth, processing rate, failure rate per stage                                                                |
| **Delivery metrics** | SQL aggregation endpoint              | `GET /api/v1/admin/notifications/metrics` - success/failure rates, delivery latency                                     |
| **DLQ consumer**     | Dedicated BullMQ worker               | Log failed job payload + error, increment failure counter, alert if DLQ depth > 0                                       |
| **Stuck recovery**   | Repeatable job (every 15 min)         | Query `idx_deliveries_sending_stuck`, reset to `failed_transient` or `pending`                                          |
| **Run tracking**     | New `notification_trigger_runs` table | Track each trigger invocation: run_id, type, period, eligible_count, sent_count, failed_count, started_at, completed_at |

### 10. Notification Preferences Extension

Extend the existing preference model for challenge notifications:

- **Global pause**: Add `is_globally_paused` boolean to user profile (checked at send time, not queue time, to handle mid-batch pauses)
- **Challenge opt-in**: Challenge notifications require explicit opt-in per campaign (new subscription type in `Notifications` table)
- **Preference check timing**: Checked twice - at collect/compose time (skip early) and at send time (catch late unsubscribes). The send worker's `claimForSending` query should JOIN against `Notifications.is_active`.

## Alternatives Considered

### 1. Separate Pipeline for Challenge Notifications

**Considered**: Build an independent pipeline with its own queue, compose logic, and send workers for challenge emails.

**Rejected because**:

- Duplicates infrastructure (queue setup, rate limiting, webhook handling, error recovery)
- Two pipelines competing for Resend rate limits without coordination
- Double the operational surface to monitor
- The existing pipeline is generic enough to handle different notification types via the compose stage

### 2. Immediate Delivery for Challenge Events (No Digest)

**Considered**: Send each challenge notification immediately when triggered, like transactional emails.

**Rejected because**:

- 10 entities x 3 trigger types = 30 emails/day during peak campaign season
- Users would unsubscribe due to noise, defeating the engagement goal
- Digest reduces email volume by ~80% while preserving information delivery
- Daily digest at 9 AM aligns with user behavior (morning email processing)

### 3. Per-User Configurable Digest Time

**Considered**: Let users choose when their daily digest arrives (e.g., 7 AM, 12 PM, 6 PM).

**Rejected because**:

- Requires per-user scheduling (N individual BullMQ jobs instead of 1 sweep)
- At 10,000 users, managing individual scheduled jobs is operationally complex
- Marginal UX improvement - most users process notifications at their own pace regardless of delivery time
- Can be added later as a v2 enhancement without architectural changes

### 4. Google Calendar Links Instead of .ics Attachments

**Considered**: Generate Google Calendar URL scheme links instead of .ics files.

**Rejected because**:

- Only works for Google Calendar users (excludes Outlook, Apple Calendar)
- No update/cancellation mechanism (each link creates a new event)
- .ics is the universal standard supported by all major clients
- `ical-generator` library makes generation straightforward

### 5. External Cron (k8s CronJobs) for Scheduling

**Considered**: Use Kubernetes CronJobs to call the admin trigger endpoint on schedule.

**Rejected because**:

- Adds deployment-time configuration complexity
- Scheduling logic split between app code and infrastructure config
- BullMQ repeatable jobs are built-in, tested, and co-located with the workers
- BullMQ handles deduplication (won't create duplicate repeatable jobs)
- Easier to test (no k8s dependency in development)

### 6. Generic `{ category, subtype }` Instead of Typed Union

**Considered**: Replace `NotificationType` union with a flexible `{ category: string, subtype: string }` model.

**Rejected because**:

- Loses compile-time exhaustiveness checking across the pipeline
- Every `switch` statement on notification type would need a `default` branch that could hide bugs
- The typed union forces explicit handling when new types are added
- With ~13 types total, the union is manageable

## Consequences

**Positive**

- Complete user communication lifecycle: registration -> subscription -> periodic updates -> challenge engagement
- Daily digest prevents notification fatigue during high-activity campaign periods
- .ics calendar integration helps users track public debate deadlines in their preferred calendar
- Unified pipeline means one codebase to maintain, monitor, and scale
- BullMQ repeatable jobs eliminate external scheduling dependencies
- Reconciliation job catches missing welcome emails from webhook failures
- Compile-time safety from extended `NotificationType` union catches missing handlers

**Negative**

- `NotificationType` union grows to ~13 types - compose worker switch statement becomes large (mitigate with per-type compose strategy modules)
- Daily digest adds a staging table (`PendingDigestItems`) and a new compose path
- .ics generation adds a dependency (`ical-generator`) and complexity (RFC 5545 compliance, timezone handling, SEQUENCE tracking)
- Digest has inherent latency - user actions at 11 PM won't be communicated until 9 AM next day (acceptable trade-off per decision)
- Repeatable jobs require `PROCESS_ROLE` gating to prevent duplicate schedulers across API instances
- Reconciliation job depends on Clerk API availability (rate limits, downtime)

## Implementation Order

Recommended sequencing based on dependencies and risk:

| Phase       | Scope                                                                               | Unblocks                                          |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Phase 1** | Wire missing adapters + initialize workers in `build-app.ts`                        | Newsletter and alert delivery (existing features) |
| **Phase 2** | Add transactional types + welcome/confirmation email flow                           | User onboarding communication                     |
| **Phase 3** | Add challenge types + `PendingDigestItems` schema + digest mechanism                | Challenge campaign notifications                  |
| **Phase 4** | BullMQ repeatable jobs (deadline sweep, weekly progress, digest dispatch, recovery) | Automated scheduling                              |
| **Phase 5** | .ics generation + calendar milestone sweep                                          | Calendar integration                              |
| **Phase 6** | Observability (DLQ consumer, run tracking, metrics endpoint)                        | Operational visibility                            |

## References

- **Existing delivery spec**: `docs/specs/specs-202601142200-notification-delivery-module.md`
- **Original brainstorming**: `docs/notifications.md` (superseded by this spec)
- **Delivery pipeline types**: `src/modules/notification-delivery/core/types.ts`
- **Delivery pipeline ports**: `src/modules/notification-delivery/core/ports.ts`
- **Notification types**: `src/modules/notifications/core/types.ts`
- **Queue infrastructure**: `src/infra/queue/client.ts`
- **Email client**: `src/infra/email/client.ts`
- **Database schema**: `src/infra/database/user/schema.sql`
- **Architecture guide**: `docs/ARCHITECTURE.md`
- **RFC 5545 (iCalendar)**: <https://datatracker.ietf.org/doc/html/rfc5545>
- **RFC 8058 (One-Click Unsubscribe)**: <https://datatracker.ietf.org/doc/html/rfc8058>
- **ical-generator**: <https://github.com/sebbo2002/ical-generator>
- **BullMQ Repeatable Jobs**: <https://docs.bullmq.io/guide/jobs/repeatable>
