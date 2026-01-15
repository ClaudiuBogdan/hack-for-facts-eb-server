# Notification Module - Complete Implementation Plan (v3)

## Overview

This plan covers the complete notification lifecycle for transparenta.eu with production-grade reliability:

- Template-based email generation with React Email
- Email delivery via Resend with idempotency keys
- Background job processing with BullMQ (rate-limited)
- **True database-level idempotency** with delivery status lifecycle
- Full subscription lifecycle including one-click unsubscribe headers
- Webhook ingestion for bounces/suppressions/complaints

---

## Current State (What Exists)

| Component             | Status                   | Location                                                         |
| --------------------- | ------------------------ | ---------------------------------------------------------------- |
| Subscription CRUD API | ✅ Complete              | `src/modules/notifications/`                                     |
| Database Schema       | ⚠️ Needs extension       | `Notifications`, `NotificationDeliveries`, `UnsubscribeTokens`   |
| Notification Types    | ✅ Defined               | newsletter (monthly/quarterly/yearly), alerts (analytics/static) |
| Idempotency Key       | ⚠️ Defined, not enforced | `delivery_key` = `userId:notificationId:periodKey`               |
| BullMQ                | ⚠️ Installed, unused     | `package.json` dependency                                        |
| Redis                 | ✅ Configured            | For caching, can reuse for queues                                |

---

## Technology Choices

- **Email Provider**: Resend (modern API, React Email integration)
- **Template Engine**: React Email (type-safe, component-based, browser preview)
- **Job Queue**: BullMQ (rate limiting, retry/backoff, deduplication)
- **Developer Tooling**: React Email dev server + REST preview API

---

## Critical Design Decisions

### 1. True Idempotency at Database Layer

**Problem**: Recording delivery "after sending" is not idempotent under crashes/retries.

**Solution**: Treat `NotificationDeliveries` as an **outbox pattern** with status lifecycle and unique constraint.

**Delivery Status Lifecycle**:

```
pending → sending → sent → delivered (via webhook)
                  ↘ failed_transient (retryable)
                  ↘ failed_permanent (no retry)
                  ↘ suppressed (from webhook)
                  ↘ skipped_unsubscribed
                  ↘ skipped_no_email
```

### 2. No Batching for v1 (Simplification)

**Decision**: Send one email per delivery (not batched per user).

**Rationale**:

- Simpler idempotency model (each delivery is a unit)
- Easier to test and debug
- Avoids introducing `batch_key` complexity
- Can add batching in v2 once system is stable

### 3. Token Model: Use Existing `UnsubscribeTokens` Table

**Decision**: Keep `UnsubscribeTokens` as canonical, reference via FK from deliveries.

```typescript
interface DeliveryRecord {
  id: string; // UUID, used for Resend tags (no colons!)
  deliveryKey: string; // userId:notificationId:periodKey (internal use only)
  unsubscribeTokenId: string; // FK to UnsubscribeTokens
  // ... rest of fields
}
```

**Compose step**: Call `getOrCreateActiveToken(userId, notificationId)` and store the FK.

### 4. Resend Rate Limiting

**Constraint**: Resend default limit is 2 requests/second.

**Solution**: BullMQ worker-level rate limiter (global across workers):

```typescript
const sendWorker = new Worker('notification:send', processor, {
  limiter: {
    max: 2, // Max 2 jobs per duration
    duration: 1000, // 1 second
  },
  connection: redis,
});
```

### 5. Resend Idempotency Keys (CORRECT USAGE)

**Important**: Idempotency key is SDK option, NOT an email header!

```typescript
// CORRECT: Idempotency key in 2nd argument
await resend.emails.send(
  {
    from: config.email.fromAddress,
    to: delivery.userEmail,
    subject: delivery.renderedSubject,
    html: delivery.renderedHtml,
    text: delivery.renderedText,
    headers: {
      // Email headers (List-Unsubscribe goes here)
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [
      // Tags must use allowed characters: ASCII letters, numbers, underscores, dashes
      // NO COLONS ALLOWED - use UUIDs instead of delivery_key
      { name: 'delivery_id', value: delivery.id }, // UUID (hex + dashes)
      { name: 'notification_id', value: delivery.notificationId },
      { name: 'period_key', value: delivery.periodKey }, // "2025-01" OK
      { name: 'env', value: config.environment },
    ],
  },
  {
    // SDK-level options (2nd argument)
    idempotencyKey: delivery.id, // Use UUID, NOT delivery_key with colons
  }
);
```

### 6. List-Unsubscribe Headers (CAN-SPAM + One-Click)

**Add to every email**:

- `List-Unsubscribe: <https://transparenta.eu/api/v1/notifications/unsubscribe/{token}>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`

**Unsubscribe endpoint response**:

- `GET` → HTML page (human click from email body)
- `POST` → **Empty body with 200/202** (one-click from email client)

### 7. Worker Deployment Model

**Option chosen**: Gate workers by role flag.

```typescript
PROCESS_ROLE: Type.Optional(Type.Enum(['api', 'worker', 'both']), { default: 'both' }),
```

In production Kubernetes:

- API pods: `PROCESS_ROLE=api` (enqueue only)
- Worker pods: `PROCESS_ROLE=worker` (process jobs)

### 8. BullMQ Redis Configuration (CRITICAL)

**Do NOT use ioredis `keyPrefix`** - BullMQ is incompatible with it.

```typescript
// WRONG - will cause issues
new Redis(url, { keyPrefix: 'transparenta:jobs:' });

// CORRECT - use BullMQ's prefix option
const queue = new Queue('notification:send', {
  connection: redis, // Un-prefixed connection
  prefix: 'transparenta:jobs', // BullMQ's own prefix
});
```

**Redis must be configured with**:

```
maxmemory-policy=noeviction
```

This prevents BullMQ keys from being evicted under memory pressure.

---

## Architecture

### Revised Queue Pipeline

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ notification:   │────▶│ notification:   │────▶│ notification:   │
│ collect         │     │ compose         │     │ send            │
│ (manual trigger)│     │ (render+persist)│     │ (rate-limited)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                              ┌───────────────────────────┤
                              ▼                           ▼
                     ┌─────────────────┐         ┌─────────────────┐
                     │ webhook:        │         │ notification:   │
                     │ resend          │         │ dlq             │
                     │ (status updates)│         │ (failed jobs)   │
                     └─────────────────┘         └─────────────────┘
```

### Module Structure

```
src/
├── modules/
│   ├── notifications/              # EXISTS - subscription management
│   │
│   ├── notification-delivery/      # NEW - delivery pipeline
│   │   ├── core/
│   │   │   ├── types.ts            # DeliveryRecord, DeliveryStatus, etc.
│   │   │   ├── errors.ts           # Delivery-specific errors
│   │   │   ├── ports.ts            # Repositories, EmailSender, etc.
│   │   │   └── usecases/
│   │   │       ├── collect-due-notifications.ts
│   │   │       ├── compose-delivery.ts       # Render + persist
│   │   │       ├── send-delivery.ts          # Fetch + send
│   │   │       └── process-webhook-event.ts  # Handle Resend webhooks
│   │   └── shell/
│   │       ├── repo/
│   │       │   └── delivery-repo.ts          # With atomic claim
│   │       ├── adapters/
│   │       │   ├── resend-adapter.ts         # Correct SDK usage
│   │       │   ├── clerk-adapter.ts          # Fetch user email
│   │       │   └── data-fetcher-adapter.ts
│   │       ├── queue/
│   │       │   ├── workers/
│   │       │   │   ├── collect-worker.ts
│   │       │   │   ├── compose-worker.ts
│   │       │   │   └── send-worker.ts        # Rate-limited
│   │       │   └── scheduler.ts
│   │       └── rest/
│   │           ├── trigger-routes.ts         # Manual trigger endpoint
│   │           └── webhook-routes.ts         # Resend webhook receiver
│   │
│   └── email-templates/            # NEW - React Email templates
│       ├── core/
│       │   ├── types.ts            # Template props, i18n types
│       │   ├── ports.ts            # EmailRenderer, TranslationProvider
│       │   └── i18n/               # Romanian & English translations
│       └── shell/
│           ├── templates/          # React Email components
│           ├── renderer/           # React Email adapter
│           └── rest/               # Preview API (dev only)
│
├── infra/
│   ├── queue/                      # NEW - BullMQ infrastructure
│   │   ├── client.ts               # Uses BullMQ prefix, NOT ioredis keyPrefix
│   │   └── worker-manager.ts       # Lifecycle management
│   └── email/                      # NEW - Resend client
│       └── client.ts
│
emails/                             # NEW - React Email dev server (root)
```

---

## Implementation Phases

### Phase 1: Database Schema Extension

**Safe migration sequence** (handles existing rows):

```sql
-- Step 1: Add columns as NULLABLE first
ALTER TABLE NotificationDeliveries
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS unsubscribe_token_id UUID,  -- FK to UnsubscribeTokens
ADD COLUMN IF NOT EXISTS rendered_subject TEXT,
ADD COLUMN IF NOT EXISTS rendered_html TEXT,
ADD COLUMN IF NOT EXISTS rendered_text TEXT,
ADD COLUMN IF NOT EXISTS content_hash TEXT,
ADD COLUMN IF NOT EXISTS template_name TEXT,
ADD COLUMN IF NOT EXISTS template_version TEXT,
ADD COLUMN IF NOT EXISTS to_email TEXT,  -- Snapshot of email used
ADD COLUMN IF NOT EXISTS resend_email_id TEXT,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS attempt_count INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Step 2: Backfill existing rows (if any)
UPDATE NotificationDeliveries
SET status = 'sent',  -- Assume old records were successful
    attempt_count = 1
WHERE status IS NULL;

-- Step 3: Make NOT NULL and add constraints
ALTER TABLE NotificationDeliveries
ALTER COLUMN status SET NOT NULL,
ALTER COLUMN attempt_count SET NOT NULL,
ALTER COLUMN attempt_count SET DEFAULT 0;

-- Step 4: Add CHECK constraint for valid statuses
ALTER TABLE NotificationDeliveries
ADD CONSTRAINT deliveries_status_check
CHECK (status IN (
  'pending', 'sending', 'sent', 'delivered',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

-- Step 5: CRITICAL - Unique constraint on delivery_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_delivery_key_unique
ON NotificationDeliveries(delivery_key);

-- Step 6: Index for querying pending/failed deliveries
CREATE INDEX IF NOT EXISTS idx_deliveries_status_pending
ON NotificationDeliveries(status) WHERE status IN ('pending', 'failed_transient');

-- Step 7: Index for finding stuck 'sending' records
CREATE INDEX IF NOT EXISTS idx_deliveries_sending_stuck
ON NotificationDeliveries(last_attempt_at) WHERE status = 'sending';

-- Step 8: FK constraint (if using unsubscribe_token_id approach)
ALTER TABLE NotificationDeliveries
ADD CONSTRAINT fk_delivery_unsubscribe_token
FOREIGN KEY (unsubscribe_token_id) REFERENCES UnsubscribeTokens(token)
ON DELETE SET NULL;
```

**Add `ResendWebhookEvents` table:**

```sql
CREATE TABLE IF NOT EXISTS ResendWebhookEvents (
  id BIGSERIAL PRIMARY KEY,
  svix_id TEXT UNIQUE NOT NULL,  -- Use svix-id header as unique event ID
  event_type TEXT NOT NULL,
  resend_email_id TEXT NOT NULL,
  delivery_id UUID,  -- UUID from our tags
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resend_events_email_id
ON ResendWebhookEvents(resend_email_id);

CREATE INDEX IF NOT EXISTS idx_resend_events_delivery_id
ON ResendWebhookEvents(delivery_id);
```

### Phase 2: Infrastructure

**Environment variables (`src/infra/config/env.ts`):**

```typescript
// Email (Resend)
RESEND_API_KEY: Type.Optional(Type.String({ minLength: 20 })),
EMAIL_FROM_ADDRESS: Type.Optional(Type.String({ default: 'noreply@transparenta.eu' })),
EMAIL_PREVIEW_ENABLED: Type.Optional(Type.Boolean({ default: false })),

// Resend Webhooks
RESEND_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 32 })),

// Jobs (BullMQ)
JOBS_ENABLED: Type.Optional(Type.Boolean({ default: false })),
JOBS_CONCURRENCY: Type.Optional(Type.Number({ default: 5 })),
RESEND_MAX_RPS: Type.Optional(Type.Number({ default: 2 })),

// Notification Trigger (manual, API key protected)
NOTIFICATION_TRIGGER_API_KEY: Type.Optional(Type.String({ minLength: 32 })),

// Platform
PLATFORM_BASE_URL: Type.String(),  // Required for unsubscribe links

// Worker deployment
PROCESS_ROLE: Type.Optional(Type.Enum(['api', 'worker', 'both']), { default: 'both' }),

// BullMQ Redis (use BullMQ's prefix, NOT ioredis keyPrefix!)
BULLMQ_PREFIX: Type.Optional(Type.String({ default: 'transparenta:jobs' })),
```

**Production prerequisites (document in ops runbook):**

```
# Redis must be configured with:
maxmemory-policy=noeviction

# Helm/K8s example:
redis:
  args:
    - "--maxmemory-policy"
    - "noeviction"
```

**Dependencies:**

```bash
pnpm add resend @react-email/components @react-email/render
pnpm add -D react-email react @types/react
```

### Phase 3: Email Templates Module

**Core types (`src/modules/email-templates/core/types.ts`):**

```typescript
export type SupportedLanguage = 'ro' | 'en';

export interface BaseTemplateProps {
  lang: SupportedLanguage;
  unsubscribeUrl: string;
  preferencesUrl?: string;
  platformBaseUrl: string;
  isPreview?: boolean;
}

export interface NewsletterEntityProps extends BaseTemplateProps {
  templateType: 'newsletter_entity';
  entityName: string;
  entityCui: string;
  periodType: 'monthly' | 'quarterly' | 'yearly';
  periodLabel: string;
  summary: {
    totalIncome: number;
    totalExpenses: number;
    budgetBalance: number;
    currency: string;
  };
}

export interface AlertSeriesProps extends BaseTemplateProps {
  templateType: 'alert_series';
  title: string;
  description?: string;
  triggeredConditions: Array<{
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
    threshold: number;
    actualValue: number;
    unit: string;
  }>;
}

export type EmailTemplateProps = NewsletterEntityProps | AlertSeriesProps;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string; // Always generate plain text for deliverability
  templateName: string;
  templateVersion: string;
}
```

**React Email templates:**

1. `shell/templates/components/email-layout.tsx` - Base layout with header/footer
2. `shell/templates/components/unsubscribe-footer.tsx` - CAN-SPAM footer
3. `shell/templates/newsletter-entity.tsx` - Budget summary
4. `shell/templates/alert-series.tsx` - Alert conditions

**Preview routes (dev only, protected):**

- `GET /api/v1/emails/templates` - List available templates
- `POST /api/v1/emails/preview` - Render with custom data
- `GET /api/v1/emails/preview/:type` - Quick preview with sample data

### Phase 4: Notification Delivery Module

**Core types (`src/modules/notification-delivery/core/types.ts`):**

```typescript
export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed_transient'
  | 'failed_permanent'
  | 'suppressed'
  | 'skipped_unsubscribed'
  | 'skipped_no_email';

export interface DeliveryRecord {
  id: string; // UUID - use this for Resend tags and idempotency key
  userId: string;
  toEmail?: string; // Snapshot of email used at send time
  notificationId: string;
  periodKey: string;
  deliveryKey: string; // userId:notificationId:periodKey (internal, NOT for Resend)
  status: DeliveryStatus;
  unsubscribeTokenId?: string; // FK to UnsubscribeTokens
  renderedSubject?: string;
  renderedHtml?: string;
  renderedText?: string;
  contentHash?: string;
  templateName?: string;
  templateVersion?: string;
  resendEmailId?: string;
  lastError?: string;
  attemptCount: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  createdAt: Date;
}

export interface TriggerRequest {
  notificationType: NotificationType;
  periodKey?: string; // Defaults to previous period
  dryRun?: boolean; // Returns counts without enqueueing
  limit?: number; // Cap recipients for safe rollout
  force?: boolean; // Bypass deduplication (use with caution)
}

export interface TriggerResponse {
  runId: string;
  notificationType: NotificationType;
  periodKey: string;
  dryRun: boolean;
  eligibleCount: number;
  collectJobEnqueued: boolean;
}
```

**Ports (`src/modules/notification-delivery/core/ports.ts`):**

```typescript
export interface DeliveryRepository {
  // Create with unique constraint protection
  createDelivery(input: CreateDeliveryInput): Promise<Result<DeliveryRecord, DeliveryError>>;

  // ATOMIC CLAIM: Only succeeds if status is claimable
  claimForSending(deliveryId: string): Promise<Result<DeliveryRecord | null, DeliveryError>>;
  // SQL: UPDATE ... SET status='sending', attempt_count=attempt_count+1, last_attempt_at=now()
  //      WHERE id=$1 AND status IN ('pending','failed_transient') RETURNING *

  // Update status with metadata
  updateStatus(
    deliveryId: string,
    status: DeliveryStatus,
    metadata?: Partial<DeliveryRecord>
  ): Promise<Result<void, DeliveryError>>;

  // Find stuck 'sending' records (for sweeper)
  findStuckSending(olderThanMinutes: number): Promise<Result<DeliveryRecord[], DeliveryError>>;

  // Check if delivery exists by key
  existsByDeliveryKey(deliveryKey: string): Promise<Result<boolean, DeliveryError>>;
}

export interface EmailSender {
  send(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string; // Use delivery.id (UUID)
    unsubscribeUrl: string;
    tags: Array<{ name: string; value: string }>;
  }): Promise<Result<{ emailId: string }, EmailError>>;
}

export interface UserEmailFetcher {
  getEmail(userId: string): Promise<Result<string | null, Error>>;
}
```

**Use cases:**

1. `collect-due-notifications.ts` - Find eligible notifications
2. `compose-delivery.ts` - Render + get/create token + persist record (status=pending)
3. `send-delivery.ts` - Claim + send with idempotency key + update status
4. `process-webhook-event.ts` - Handle Resend webhooks with svix-id deduplication
5. `recover-stuck-sending.ts` - Move stale 'sending' back to 'failed_transient'

### Phase 5: BullMQ Workers

**Queue names:**

- `notification:collect` - Manual trigger collection
- `notification:compose` - Content generation + persist
- `notification:send` - Email delivery (rate-limited)
- `notification:dlq` - Failed jobs for inspection

**Queue client with correct prefix:**

```typescript
export const makeQueueClient = (redis: Redis, prefix: string): QueueClient => {
  // NOTE: Do NOT use ioredis keyPrefix - use BullMQ's prefix option
  return {
    getQueue: (name: string) =>
      new Queue(name, {
        connection: redis,
        prefix, // BullMQ's own prefix mechanism
      }),
    createWorker: (name, processor, opts) =>
      new Worker(name, processor, {
        connection: redis,
        prefix,
        ...opts,
      }),
  };
};
```

**Job deduplication with force override:**

```typescript
// Default: dedupe by notificationType + periodKey (prevents accidental double-trigger)
// With force=true: includes runId (allows intentional re-runs)
const jobId = input.force
  ? `collect:${notificationType}:${periodKey}:${runId}`
  : `collect:${notificationType}:${periodKey}`;

await collectQueue.add('collect', payload, { jobId });
```

**Send worker with atomic claim:**

```typescript
export const createSendWorker = (deps: SendWorkerDeps): Worker => {
  return new Worker(
    'notification:send',
    async (job) => {
      // ATOMIC CLAIM: Returns null if already claimed/processed
      const delivery = await deps.deliveryRepo.claimForSending(job.data.deliveryId);
      if (delivery === null) {
        deps.logger.info({ deliveryId: job.data.deliveryId }, 'Delivery already claimed/processed');
        return;
      }

      try {
        // Fetch user email snapshot
        const userEmail = await deps.userEmailFetcher.getEmail(delivery.userId);
        if (!userEmail) {
          await deps.deliveryRepo.updateStatus(delivery.id, 'skipped_no_email');
          return;
        }

        // Get unsubscribe token (FK was stored at compose time)
        const token = await deps.tokensRepo.findById(delivery.unsubscribeTokenId);
        const unsubscribeUrl = `${deps.config.platformBaseUrl}/api/v1/notifications/unsubscribe/${token.token}`;

        // Send via Resend with CORRECT SDK usage
        const result = await deps.emailSender.send({
          to: userEmail,
          subject: delivery.renderedSubject,
          html: delivery.renderedHtml,
          text: delivery.renderedText,
          idempotencyKey: delivery.id, // UUID, NOT delivery_key
          unsubscribeUrl,
          tags: [
            // Tags must use allowed characters only!
            { name: 'delivery_id', value: delivery.id },
            { name: 'notification_id', value: delivery.notificationId },
            { name: 'period_key', value: delivery.periodKey },
            { name: 'env', value: deps.config.environment },
          ],
        });

        await deps.deliveryRepo.updateStatus(delivery.id, 'sent', {
          resendEmailId: result.emailId,
          toEmail: userEmail,
          sentAt: new Date(),
        });
      } catch (error) {
        const isRetryable = isTransientError(error);
        await deps.deliveryRepo.updateStatus(
          delivery.id,
          isRetryable ? 'failed_transient' : 'failed_permanent',
          { lastError: error.message }
        );
        if (isRetryable) throw error; // BullMQ will retry
      }
    },
    {
      connection: deps.redis,
      prefix: deps.config.bullmqPrefix,
      limiter: {
        max: deps.config.resendMaxRps, // Default 2
        duration: 1000,
      },
      concurrency: 5,
    }
  );
};
```

### Phase 6: Manual Trigger Endpoint

**Route: `POST /api/v1/notifications/trigger`**

```typescript
export const makeTriggerRoutes = (deps: TriggerRoutesDeps): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.post<{ Body: TriggerRequest }>(
      '/api/v1/notifications/trigger',
      {
        preHandler: async (request, reply) => {
          const apiKey = request.headers['x-notification-api-key'];
          if (apiKey !== deps.config.triggerApiKey) {
            return reply.status(401).send({ error: 'Invalid API key' });
          }
        },
        schema: {
          body: TriggerRequestSchema,
          response: { 200: TriggerResponseSchema },
        },
      },
      async (request, reply) => {
        const { notificationType, periodKey, dryRun, limit, force } = request.body;
        const runId = crypto.randomUUID();
        const resolvedPeriodKey = periodKey ?? generatePeriodKey(notificationType);

        // Find eligible notifications
        const eligible = await deps.notificationsRepo.findEligibleForDelivery(
          notificationType,
          resolvedPeriodKey,
          limit
        );

        if (dryRun) {
          return reply.send({
            runId,
            notificationType,
            periodKey: resolvedPeriodKey,
            dryRun: true,
            eligibleCount: eligible.length,
            collectJobEnqueued: false,
          });
        }

        // Enqueue collect job with deduplication (unless force=true)
        const jobId = force
          ? `collect:${notificationType}:${resolvedPeriodKey}:${runId}`
          : `collect:${notificationType}:${resolvedPeriodKey}`;

        const added = await deps.collectQueue.add(
          'collect',
          {
            notificationType,
            periodKey: resolvedPeriodKey,
            runId,
            notificationIds: eligible.map((n) => n.id),
          },
          { jobId }
        );

        return reply.send({
          runId,
          notificationType,
          periodKey: resolvedPeriodKey,
          dryRun: false,
          eligibleCount: eligible.length,
          collectJobEnqueued: added !== null, // null if dedupe rejected
        });
      }
    );
  };
};
```

### Phase 7: Resend Webhook Ingestion (CORRECT IMPLEMENTATION)

**Enable raw body in Fastify** (required for signature verification):

```typescript
// In build-app.ts or plugin
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    req.rawBody = body;
    done(null, JSON.parse(body));
  } catch (err) {
    done(err);
  }
});
```

**Route: `POST /api/v1/webhooks/resend`**

```typescript
export const makeResendWebhookRoutes = (deps: WebhookRoutesDeps): FastifyPluginAsync => {
  return async (fastify) => {
    fastify.post('/api/v1/webhooks/resend', async (request, reply) => {
      // 1. Get svix headers (this is the unique event ID!)
      const svixId = request.headers['svix-id'] as string;
      const svixTimestamp = request.headers['svix-timestamp'] as string;
      const svixSignature = request.headers['svix-signature'] as string;

      if (!svixId || !svixTimestamp || !svixSignature) {
        return reply.status(400).send({ error: 'Missing svix headers' });
      }

      // 2. Verify webhook signature using raw body
      const isValid = await deps.resendClient.webhooks.verify(
        request.rawBody, // Must be string, not parsed JSON
        { svixId, svixTimestamp, svixSignature },
        deps.config.webhookSecret
      );

      if (!isValid) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // 3. Idempotent processing using INSERT with conflict handling
      const event = request.body as ResendWebhookEvent;

      // Try to insert - if conflict, already processed
      const insertResult = await deps.webhookRepo.insertEvent({
        svixId, // Use svix-id as unique event ID, NOT event.id
        eventType: event.type,
        resendEmailId: event.data.email_id,
        payload: event,
      });

      if (insertResult.isErr() && insertResult.error.type === 'DUPLICATE') {
        return reply.status(200).send({ status: 'already_processed' });
      }

      // 4. Extract delivery_id from tags (handle both array and object formats)
      const tags = event.data.tags;
      let deliveryId: string | undefined;

      if (Array.isArray(tags)) {
        deliveryId = tags.find((t) => t.name === 'delivery_id')?.value;
      } else if (typeof tags === 'object' && tags !== null) {
        deliveryId = tags['delivery_id'];
      }

      // 5. Update delivery status based on event type
      if (deliveryId) {
        switch (event.type) {
          case 'email.sent':
            // Reconcile if our DB update failed after Resend accepted
            await deps.deliveryRepo.updateStatusIfStillSending(deliveryId, 'sent', {
              resendEmailId: event.data.email_id,
            });
            break;

          case 'email.delivered':
            await deps.deliveryRepo.updateStatus(deliveryId, 'delivered');
            break;

          case 'email.bounced':
            const isPermanentBounce = event.data.bounce?.type === 'Permanent';
            await deps.deliveryRepo.updateStatus(
              deliveryId,
              isPermanentBounce ? 'suppressed' : 'failed_transient',
              { lastError: `bounced: ${event.data.bounce?.subType}` }
            );
            // Optionally deactivate notification for permanent bounces
            if (isPermanentBounce) {
              await deps.notificationsRepo.deactivate(/* notificationId from delivery */);
            }
            break;

          case 'email.complained':
          case 'email.suppressed':
            await deps.deliveryRepo.updateStatus(deliveryId, 'suppressed', {
              lastError: `${event.type}: ${event.data.reason}`,
            });
            // Deactivate to stop future sends
            await deps.notificationsRepo.deactivate(/* notificationId */);
            break;

          case 'email.failed':
            await deps.deliveryRepo.updateStatus(deliveryId, 'failed_permanent', {
              lastError: event.data.error,
            });
            break;

          case 'email.delivery_delayed':
            // Just log for observability, keep as 'sent'
            deps.logger.warn({ deliveryId, event }, 'Email delivery delayed');
            break;
        }
      }

      // 6. Mark event as processed
      await deps.webhookRepo.markProcessed(svixId);

      return reply.status(200).send({ status: 'processed' });
    });
  };
};
```

### Phase 8: Extend Unsubscribe Endpoint (One-Click Support)

**IMPORTANT**: POST must return empty body for one-click compliance!

```typescript
fastify.route({
  method: ['GET', 'POST'],
  url: '/api/v1/notifications/unsubscribe/:token',
  handler: async (request, reply) => {
    const { token } = request.params;

    const result = await unsubscribeViaToken(deps, { token });

    // Handle errors - but don't leak token validity
    if (result.isErr()) {
      if (request.method === 'GET') {
        // Always show success page to user (prevents enumeration)
        return reply.type('text/html').send(renderUnsubscribeSuccessPage());
      }
      // POST: Return empty 200 (one-click spec compliance)
      return reply.status(200).send();
    }

    // Success response
    if (request.method === 'GET') {
      return reply.type('text/html').send(renderUnsubscribeSuccessPage());
    }

    // POST: Return EMPTY body with 200 (one-click spec requirement)
    return reply.status(200).send();
  },
});
```

### Phase 9: Stuck Sending Recovery (Sweeper)

**Manual trigger or periodic job:**

```typescript
export const recoverStuckSending = async (deps: {
  deliveryRepo: DeliveryRepository;
  logger: Logger;
  thresholdMinutes?: number;
}): Promise<{ recovered: number }> => {
  const threshold = deps.thresholdMinutes ?? 15;

  // Find deliveries stuck in 'sending' for too long
  const stuck = await deps.deliveryRepo.findStuckSending(threshold);

  if (stuck.length === 0) {
    return { recovered: 0 };
  }

  deps.logger.warn({ count: stuck.length }, 'Found stuck sending deliveries');

  for (const delivery of stuck) {
    // Move back to failed_transient so it can be retried
    // (Resend idempotency key is valid for 24h, so retry is safe)
    await deps.deliveryRepo.updateStatus(delivery.id, 'failed_transient', {
      lastError: 'Recovered from stuck sending state',
    });
  }

  return { recovered: stuck.length };
};
```

### Phase 10: Integration & Wiring

**`src/app/build-app.ts` additions:**

```typescript
const processRole = config.processRole ?? 'both';

// Queue client with CORRECT prefix usage
let queueClient: QueueClient | undefined;
if (config.jobs.enabled && config.redis.url) {
  const redis = new Redis(config.redis.url, {
    password: config.redis.password,
    // DO NOT SET keyPrefix HERE - BullMQ is incompatible with it!
  });

  queueClient = makeQueueClient(redis, config.bullmq.prefix);
}

// API role: Register trigger endpoint + webhook receiver
if (processRole === 'api' || processRole === 'both') {
  if (queueClient && config.notifications.triggerApiKey) {
    await app.register(
      makeTriggerRoutes({
        collectQueue: queueClient.getQueue('notification:collect'),
        notificationsRepo,
        config: { triggerApiKey: config.notifications.triggerApiKey },
      })
    );
  }

  if (config.resend.webhookSecret) {
    await app.register(
      makeResendWebhookRoutes({
        deliveryRepo,
        notificationsRepo,
        webhookRepo,
        resendClient: new Resend(config.resend.apiKey),
        config: { webhookSecret: config.resend.webhookSecret },
      })
    );
  }
}

// Worker role: Start BullMQ workers
if (processRole === 'worker' || processRole === 'both') {
  if (queueClient && config.resend.apiKey) {
    const workerManager = createWorkerManager({ logger: app.log });

    const workers = createNotificationWorkers({
      queueClient,
      deliveryRepo,
      notificationsRepo,
      tokensRepo,
      emailRenderer,
      emailSender: makeResendClient({ apiKey: config.resend.apiKey }),
      clerkClient,
      config: {
        platformBaseUrl: config.platformBaseUrl,
        resendMaxRps: config.resend.maxRps,
        bullmqPrefix: config.bullmq.prefix,
        environment: config.environment,
      },
    });

    workerManager.registerAll(workers);

    // Graceful shutdown
    app.addHook('onClose', () => workerManager.stopAll());
  }
}

// Email preview routes (dev only, non-production)
if (config.email.previewEnabled && !config.server.isProduction) {
  await app.register(makeEmailPreviewRoutes({ emailRenderer, sampleDataProvider }));
}
```

### Phase 11: Testing

**Critical test cases:**

1. **DB idempotency**: Concurrent insert with same `delivery_key` → only one record
2. **Atomic claim**: Two workers claim same delivery → only one succeeds
3. **Retry safety**: Job fails after compose, retry uses persisted content
4. **Resend idempotency**: Same key + same payload = success
5. **Rate limiting**: Many jobs → max 2 Resend calls/second
6. **429 handling**: Worker backs off, doesn't exhaust attempts
7. **Unsubscribe flows**: GET returns HTML, POST returns empty 200
8. **Webhook processing**: Duplicate svix-id events are ignored
9. **Suppression handling**: Suppressed delivery doesn't retry
10. **Stuck recovery**: `sending` older than threshold → `failed_transient`
11. **Tag validation**: Verify tags contain only allowed characters

---

## Verification Plan

1. **Template Preview:**

   ```bash
   pnpm email:dev  # React Email dev server on port 3001
   curl localhost:3000/api/v1/emails/preview/newsletter_entity_monthly
   ```

2. **Dry Run Trigger:**

   ```bash
   curl -X POST localhost:3000/api/v1/notifications/trigger \
     -H "X-Notification-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"notificationType": "newsletter_entity_monthly", "dryRun": true}'
   ```

3. **Real Send (with limit):**

   ```bash
   curl -X POST localhost:3000/api/v1/notifications/trigger \
     -H "X-Notification-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"notificationType": "newsletter_entity_monthly", "limit": 5}'
   ```

4. **Monitor queues:**

   ```bash
   # Check BullMQ dashboard or logs
   # Verify delivery records transition: pending → sending → sent → delivered
   ```

5. **Webhook testing:**

   ```bash
   # Use Resend webhook testing or ngrok
   # Verify delivery status updates
   ```

6. **Stuck recovery:**

   ```bash
   # Manually trigger sweeper or wait for periodic run
   # Check that 'sending' > 15min becomes 'failed_transient'
   ```

---

## Critical Files Summary

| File                                                                   | Purpose                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `src/infra/database/user/schema.sql`                                   | Extend `NotificationDeliveries` schema         |
| `src/modules/notification-delivery/core/types.ts`                      | DeliveryRecord, DeliveryStatus                 |
| `src/modules/notification-delivery/shell/repo/delivery-repo.ts`        | Atomic claim + status updates                  |
| `src/modules/notification-delivery/shell/adapters/resend-adapter.ts`   | Correct SDK usage (idempotency key in options) |
| `src/modules/notification-delivery/shell/queue/workers/send-worker.ts` | Rate-limited sender with atomic claim          |
| `src/modules/notification-delivery/shell/rest/trigger-routes.ts`       | Manual trigger with deduplication              |
| `src/modules/notification-delivery/shell/rest/webhook-routes.ts`       | Resend webhook with svix-id deduplication      |
| `src/modules/email-templates/shell/templates/*.tsx`                    | React Email components                         |
| `src/app/build-app.ts`                                                 | Wire everything with role-based gating         |

---

## Pre-Implementation Checklist

Before coding, ensure these critical items are addressed:

- [ ] Redis configured with `maxmemory-policy=noeviction`
- [ ] Resend idempotency key uses SDK option, NOT email header
- [ ] Tags use UUIDs (`delivery_id`), NOT `delivery_key` with colons
- [ ] BullMQ uses its own `prefix`, NOT ioredis `keyPrefix`
- [ ] Webhook uses `svix-id` header as unique event ID
- [ ] Webhook verification uses raw body (enable in Fastify)
- [ ] Unsubscribe POST returns empty 200, NOT JSON
- [ ] `pending→sending` is atomic claim (compare-and-set)
- [ ] `attempt_count` incremented in SQL, not application code
- [ ] Migration handles existing rows (nullable first, then backfill)

---

## Open Questions Resolved

1. **Email Provider**: Resend ✓
2. **Template Engine**: React Email ✓
3. **Job Processing**: BullMQ (manual trigger, rate-limited) ✓
4. **Preview Tooling**: Dev server + REST API ✓
5. **User Emails**: Fetch from Clerk API ✓
6. **Email Batching**: No (v1 simplification) ✓
7. **Alert Triggers**: Manual only (API key protected) ✓
8. **Idempotency**: DB unique constraint + Resend idempotency key (UUID) ✓
9. **Delivery lifecycle**: pending → sending → sent → delivered ✓
10. **List-Unsubscribe**: Headers + one-click POST (empty 200) ✓
11. **Webhook ingestion**: Resend events with svix-id deduplication ✓
12. **Worker deployment**: Role-based gating (api/worker/both) ✓
13. **Token model**: Use existing UnsubscribeTokens table via FK ✓
14. **Stuck recovery**: Sweeper moves stale 'sending' to 'failed_transient' ✓
15. **BullMQ prefix**: Use BullMQ prefix, NOT ioredis keyPrefix ✓
16. **Redis config**: maxmemory-policy=noeviction required ✓
