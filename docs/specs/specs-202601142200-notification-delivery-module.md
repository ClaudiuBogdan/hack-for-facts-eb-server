# Notification Delivery Module

**Status**: Accepted
**Date**: 2026-01-14
**Author**: Claude Code

## Problem

The transparenta.eu platform needed a reliable email notification system for delivering periodic budget newsletters and alerts to subscribed users. The existing `notifications` module handled subscription management (CRUD operations), but lacked:

- Template-based email generation with localization support
- Reliable email delivery with retry logic and idempotency
- Background job processing with rate limiting (Resend API: 2 req/sec)
- Webhook ingestion to track delivery status (bounces, complaints, suppressions)
- RFC 8058 compliant one-click unsubscribe for email clients
- Recovery mechanisms for stuck or failed deliveries

Without this system, users could not receive their subscribed notifications, defeating the purpose of the subscription feature.

## Context

### Existing Infrastructure

| Component             | Status     | Location                                        |
| --------------------- | ---------- | ----------------------------------------------- |
| Subscription CRUD API | Exists     | `src/modules/notifications/`                    |
| Database Schema       | Extended   | `NotificationDeliveries`, `ResendWebhookEvents` |
| Notification Types    | Defined    | newsletter (monthly/quarterly/yearly), alerts   |
| BullMQ                | Installed  | `package.json` dependency                       |
| Redis                 | Configured | Reused for job queues                           |

### Constraints

- **Rate Limiting**: Resend API limits to 2 requests/second
- **Idempotency**: Must prevent duplicate sends under crashes/retries
- **Compliance**: CAN-SPAM requires unsubscribe mechanism; RFC 8058 for one-click
- **Architecture**: Must follow existing Hexagonal/Functional Core pattern
- **Financial Precision**: Uses `decimal.js` for all numeric values
- **Error Handling**: Must use `Result<T,E>` pattern (no throws in core)

### Why Now

The subscription feature was complete but non-functional without delivery capability. Users were signing up for notifications that were never sent.

## Decision

Implemented a production-grade notification delivery pipeline with the following architecture:

### Core Design: Outbox Pattern with Status Lifecycle

Treat `NotificationDeliveries` as an outbox with atomic status transitions:

```
pending → sending → sent → delivered (via webhook)
                  ↘ failed_transient (retryable)
                  ↘ failed_permanent (no retry)
                  ↘ suppressed (from webhook)
                  ↘ skipped_unsubscribed
                  ↘ skipped_no_email
```

**Atomic Claim Pattern**: The `pending → sending` transition uses SQL compare-and-set to prevent concurrent workers from claiming the same delivery:

```sql
UPDATE notification_deliveries
SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = NOW()
WHERE id = $1 AND status IN ('pending', 'failed_transient')
RETURNING *
```

### Queue Pipeline (BullMQ)

```
notification:collect → notification:compose → notification:send
     (trigger)           (render + persist)     (rate-limited)
                                                      ↓
                              webhook:resend ← [Resend webhooks]
```

- **Collect Worker**: Finds eligible notifications, creates compose jobs
- **Compose Worker**: Renders templates, persists delivery records (status=pending)
- **Send Worker**: Claims delivery, sends via Resend, updates status (rate-limited: 2/sec)

### Technology Stack

| Component       | Choice                                   | Rationale                                            |
| --------------- | ---------------------------------------- | ---------------------------------------------------- |
| Email Provider  | Resend                                   | Modern API, React Email integration, webhook support |
| Template Engine | React Email                              | Type-safe, component-based, browser preview          |
| Job Queue       | BullMQ                                   | Rate limiting, retry/backoff, deduplication          |
| Idempotency     | DB unique constraint + Resend SDK option | Belt-and-suspenders approach                         |

### Key Implementation Details

**Resend Integration** (correct SDK usage):

```typescript
await resend.emails.send(
  {
    from: config.email.fromAddress,
    to: userEmail,
    subject: delivery.renderedSubject,
    html: delivery.renderedHtml,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [
      { name: 'delivery_id', value: delivery.id }, // UUID, not delivery_key
    ],
  },
  { idempotencyKey: delivery.id } // SDK option, NOT email header
);
```

**Webhook Deduplication**: Uses `svix-id` header (not `event.id`) as unique event identifier with database constraint.

**One-Click Unsubscribe (RFC 8058)**: POST requests return empty body with 200 status (not JSON).

### Module Structure

```
src/modules/notification-delivery/
├── core/
│   ├── types.ts              # DeliveryRecord, DeliveryStatus, etc.
│   ├── errors.ts             # Discriminated union errors
│   ├── ports.ts              # Repository interfaces
│   └── usecases/
│       ├── collect-due-notifications.ts
│       ├── compose-delivery.ts
│       ├── send-delivery.ts
│       ├── process-webhook-event.ts
│       └── recover-stuck-sending.ts
└── shell/
    ├── repo/
    │   ├── delivery-repo.ts          # Atomic claim implementation
    │   └── webhook-event-repo.ts
    ├── adapters/
    │   └── resend-adapter.ts
    ├── queue/
    │   └── workers/
    │       ├── collect-worker.ts
    │       ├── compose-worker.ts
    │       └── send-worker.ts
    └── rest/
        ├── trigger-routes.ts         # Manual trigger endpoint
        └── webhook-routes.ts         # Resend webhook receiver
```

## Alternatives Considered

### 1. SendGrid / Mailgun instead of Resend

**Rejected because**:

- Resend has native React Email support
- Simpler API with better TypeScript types
- Modern webhook system with svix signatures
- Competitive pricing for our volume

### 2. Cron-based sending instead of BullMQ

**Rejected because**:

- No built-in rate limiting
- No retry/backoff logic
- No job deduplication
- Harder to scale horizontally
- BullMQ already a dependency

### 3. Record delivery after sending (optimistic)

**Rejected because**:

- Not idempotent under crashes
- If app crashes after Resend accepts but before DB write, retry sends duplicate
- Outbox pattern with atomic claim is industry standard for this problem

### 4. Batch multiple notifications per email

**Rejected for v1 because**:

- Complicates idempotency model
- Harder to track individual delivery status
- Can add in v2 once system is stable

### 5. Use delivery_key (userId:notificationId:periodKey) for Resend tags

**Rejected because**:

- Resend tags don't allow colons
- UUIDs (delivery.id) work everywhere
- delivery_key still used internally for DB uniqueness

## Consequences

**Positive**

- Reliable email delivery with automatic retries for transient failures
- True idempotency prevents duplicate sends under any failure scenario
- Rate limiting respects Resend API limits (2 req/sec)
- Webhook ingestion provides delivery tracking (bounces, complaints)
- RFC 8058 compliance improves deliverability with major email providers
- Stuck delivery recovery prevents permanent "sending" states
- Clean separation: existing `notifications` module unchanged
- Comprehensive test coverage (47 new unit tests)

**Negative**

- Adds operational complexity (Redis required for BullMQ)
- Worker deployment requires consideration (api/worker/both roles)
- Template changes require code deployment (not dynamic)
- Single email per delivery (no batching in v1)

## References

- **Plan File**: `~/.claude/plans/lively-wishing-yeti.md`
- **Core Types**: `src/modules/notification-delivery/core/types.ts`
- **Delivery Repository**: `src/modules/notification-delivery/shell/repo/delivery-repo.ts`
- **Webhook Routes**: `src/modules/notification-delivery/shell/rest/webhook-routes.ts`
- **Send Worker**: `src/modules/notification-delivery/shell/queue/workers/send-worker.ts`
- **Unit Tests**: `tests/unit/notification-delivery/`
- **Integration Tests**: `tests/integration/notifications-rest.test.ts` (one-click unsubscribe)
- **Database Schema**: `src/infra/database/user/schema.sql`
- **Resend Webhook Docs**: <https://resend.com/docs/webhooks>
- **RFC 8058**: <https://datatracker.ietf.org/doc/html/rfc8058>
