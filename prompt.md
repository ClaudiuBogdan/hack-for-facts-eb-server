Plan the notification module implementation.

Here is the old codebase specs:
<specification>

# Notifications Module - Detailed Specification

This specification documents the notifications module for migration to a new codebase.

---

## 1. Overview

The notifications module is a comprehensive system for managing user notification subscriptions, email delivery, and tracking. It supports both **entity newsletters** (periodic budget execution reports) and **series alerts** (condition-based alerts on data series).

### Architecture Pattern

```
API Layer (routes) → Service Layer (notificationService) →
Data Providers (registry + providers) → Repository Layer (DB access) → Database
```

### Key Features

- Hash-based deduplication for notification uniqueness
- Delivery key deduplication to prevent duplicate sends
- Transactional email batching (consolidates multiple notifications per user)
- Unsubscribe token system with 1-year expiry
- Analytics data fetching with period-over-period comparisons
- Clerk integration for user email lookup

---

## 2. Notification Types

| Type                          | Description                              | Requires Entity | Period Key Format |
| ----------------------------- | ---------------------------------------- | --------------- | ----------------- |
| `newsletter_entity_monthly`   | Monthly budget execution updates         | Yes             | `YYYY-MM`         |
| `newsletter_entity_quarterly` | Quarterly budget execution updates       | Yes             | `YYYY-Q[1-4]`     |
| `newsletter_entity_yearly`    | Yearly budget execution summary          | Yes             | `YYYY`            |
| `alert_series_analytics`      | Alerts based on analytics filter queries | No              | `YYYY-MM`         |
| `alert_series_static`         | Alerts based on static datasets by ID    | No              | `YYYY-MM`         |

---

## 3. Database Schema

### 3.1 Notifications Table

```sql
CREATE TABLE Notifications (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NULL,  -- Nullable for global notifications
  notification_type VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB,  -- Type-specific configuration
  hash TEXT UNIQUE NOT NULL,  -- SHA-256 uniqueness hash
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_notifications_user_active ON Notifications(user_id) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_entity ON Notifications(entity_cui) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_type_active ON Notifications(notification_type) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_hash ON Notifications(hash);
```

### 3.2 NotificationDeliveries Table

```sql
CREATE TABLE NotificationDeliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,  -- '2025-01', '2025-Q1', '2025'
  delivery_key TEXT UNIQUE NOT NULL,  -- user_id:notification_id:period_key
  email_batch_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_deliveries_delivery_key ON NotificationDeliveries(delivery_key);
CREATE INDEX idx_deliveries_user_period ON NotificationDeliveries(user_id, period_key);
CREATE INDEX idx_deliveries_created_at ON NotificationDeliveries(created_at DESC);
CREATE INDEX idx_deliveries_notification ON NotificationDeliveries(notification_id);
CREATE INDEX idx_deliveries_email_batch ON NotificationDeliveries(email_batch_id);
```

### 3.3 UnsubscribeTokens Table

```sql
CREATE TABLE UnsubscribeTokens (
  token TEXT PRIMARY KEY,  -- 64-char hex (32 bytes)
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_unsubscribe_tokens_user ON UnsubscribeTokens(user_id) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_expires ON UnsubscribeTokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_notification ON UnsubscribeTokens(notification_id);
```

---

## 4. Type Definitions

### 4.1 Core Types

```typescript
type NotificationType =
  | 'newsletter_entity_monthly'
  | 'newsletter_entity_quarterly'
  | 'newsletter_entity_yearly'
  | 'alert_series_analytics'
  | 'alert_series_static';

type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

interface Notification {
  id: UUID;
  userId: string;
  entityCui: string | null;
  notificationType: NotificationType;
  isActive: boolean;
  config: NotificationConfig | null;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

interface NotificationDelivery {
  id: number;
  userId: string;
  notificationId: UUID;
  periodKey: string;
  deliveryKey: string;
  emailBatchId: string;
  sentAt: Date;
  metadata: Record<string, any>;
  createdAt: Date;
}

interface UnsubscribeToken {
  token: string;
  userId: string;
  notificationId: UUID;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}
```

### 4.2 Alert Configuration Types

```typescript
// Analytics-backed series alert
interface AnalyticsSeriesAlertConfig {
  title?: string; // Max 200 chars
  description?: string; // Max 1000 chars
  conditions: AlertCondition[];
  filter: AnalyticsFilter; // Your analytics filter schema
}

// Static dataset-backed series alert
interface StaticSeriesAlertConfig {
  title?: string;
  description?: string;
  conditions: AlertCondition[];
  datasetId: string;
}

interface AlertCondition {
  operator: AlertOperator;
  threshold: number;
  unit: string; // 1-32 chars
}
```

### 4.3 Email Content Types

```typescript
interface EntityNewsletterContent {
  entityName: string;
  entityCui: string;
  periodKey: string;
  granularity: 'MONTH' | 'QUARTER' | 'YEAR';
  summary: {
    totalSpending: number;
    totalIncome: number;
    balance: number;
    executionRate?: number;
  };
  comparisons?: {
    vsPrevious?: {
      expensesAbs: number;
      expensesPct?: number;
      incomeAbs: number;
      incomePct?: number;
    };
    vsYoY?: { expensesAbs: number; expensesPct?: number; incomeAbs: number; incomePct?: number };
  };
  topFunctional?: Array<{ code: string; name?: string; amount: number }>;
  topEconomic?: Array<{ code: string; name?: string; amount: number }>;
  trend?: Array<{ x: string; y: number }>;
  entityUrl?: string;
}

interface SeriesAlertEmailContent {
  alertTitle?: string;
  alertMessage?: string;
  details?: {
    currentValue?: number;
    threshold?: number;
    difference?: number;
    percentChange?: number;
  };
  periodKey?: string;
  entityUrl?: string;
  comparisons?: {
    prev?: { abs?: number; pct?: number };
    yoy?: { abs?: number; pct?: number };
  };
  stats?: { min: number; max: number; avg: number; count: number };
  conditions?: Array<{ operator: AlertOperator; threshold: number; unit: string; met: boolean }>;
  series?: { xAxis: { unit: string }; yAxis: { unit: string } };
}

interface ConsolidatedEmailData {
  userEmail: string;
  sections: EmailSection[];
  baseUrl: string;
}

interface EmailSection {
  type: 'entity_newsletter' | 'alert';
  title: string;
  content: EntityNewsletterContent | SeriesAlertEmailContent;
  unsubscribeUrl: string;
}
```

---

## 5. Key Algorithms

### 5.1 Notification Hash Generation

```typescript
function generateNotificationHash(
  userId: string,
  notificationType: NotificationType,
  entityCui: string | null,
  config: NotificationConfig | null
): string {
  const configStr = config ? JSON.stringify(sortObjectKeys(config)) : '';
  const data = `${userId}:${notificationType}:${entityCui || ''}:${configStr}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Helper: recursively sort object keys for consistent JSON
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const sorted: any = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}
```

### 5.2 Delivery Key Generation

```typescript
function generateDeliveryKey(userId: string, notificationId: UUID, periodKey: string): string {
  return `${userId}:${notificationId}:${periodKey}`;
}
```

### 5.3 Period Key Generation

```typescript
// Monthly: Returns previous month
function generatePreviousMonthKey(date: Date): string {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Quarterly: Returns previous quarter
function generatePreviousQuarterKey(date: Date): string {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const previousQuarter = quarter === 1 ? 4 : quarter - 1;
  const year = quarter === 1 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return `${year}-Q${previousQuarter}`;
}

// Yearly: Returns previous year
function generatePreviousYearKey(date: Date): string {
  return String(date.getUTCFullYear() - 1);
}
```

---

## 6. REST API Endpoints

### 6.1 Subscribe to Notification

```
POST /api/v1/notifications
Authorization: Required (JWT)

Request Body (discriminated union by notificationType):

// For entity newsletters:
{
  "notificationType": "newsletter_entity_monthly",
  "entityCui": "12345678",
  "config": null
}

// For analytics alerts:
{
  "notificationType": "alert_series_analytics",
  "entityCui": null,
  "config": {
    "title": "Budget Alert",
    "description": "Triggers when spending exceeds threshold",
    "filter": { /* AnalyticsFilter */ },
    "conditions": [
      { "operator": "gt", "threshold": 1000000, "unit": "RON" }
    ]
  }
}

// For static dataset alerts:
{
  "notificationType": "alert_series_static",
  "entityCui": null,
  "config": {
    "title": "Dataset Alert",
    "datasetId": "dataset-uuid-here",
    "conditions": [
      { "operator": "gte", "threshold": 500000, "unit": "EUR" }
    ]
  }
}

Response:
{ "ok": true, "data": Notification }

Error Response:
{ "ok": false, "error": "message", "details": [...] }
```

### 6.2 Get User Notifications

```
GET /api/v1/notifications
Authorization: Required

Response:
{ "ok": true, "data": Notification[] }
```

### 6.3 Get Entity Notifications

```
GET /api/v1/notifications/entity/:cui
Authorization: Required

Response:
{ "ok": true, "data": Notification[] }
```

### 6.4 Update Notification

```
PATCH /api/v1/notifications/:id
Authorization: Required (must own notification)

Request Body:
{
  "isActive": boolean,        // Optional
  "config": NotificationConfig | null  // Optional
}

Response:
{ "ok": true, "data": Notification }
```

### 6.5 Delete Notification

```
DELETE /api/v1/notifications/:id
Authorization: Required (must own notification)

Response:
{ "ok": true }
```

### 6.6 Get Delivery History

```
GET /api/v1/notifications/deliveries?limit=50&offset=0
Authorization: Required

Query Parameters:
- limit: number (default: 50)
- offset: number (default: 0)

Response:
{ "ok": true, "data": NotificationDelivery[] }
```

### 6.7 Unsubscribe via Token

```
GET /api/v1/notifications/unsubscribe/:token
Authorization: Not required (token-based)

Response:
{ "ok": true, "message": "Successfully unsubscribed from notifications" }

Error Response:
{ "ok": false, "error": "Invalid or expired token" }
```

---

## 7. Service Layer

### 7.1 NotificationService Methods

| Method                         | Signature                                            | Description                           |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| `subscribe`                    | `(userId, type, entityCui?, config?) → Notification` | Create or reactivate subscription     |
| `unsubscribe`                  | `(notificationId) → Notification`                    | Deactivate notification (soft delete) |
| `update`                       | `(notificationId, updates) → Notification`           | Update notification config/status     |
| `getUserNotifications`         | `(userId, activeOnly?) → Notification[]`             | Get user's notifications              |
| `getEntityNotifications`       | `(entityCui, activeOnly?) → Notification[]`          | Get entity's notifications            |
| `getUserEntityNotifications`   | `(userId, entityCui, activeOnly?) → Notification[]`  | Get user's notifications for entity   |
| `hasBeenDelivered`             | `(userId, notificationId, periodKey) → boolean`      | Check delivery status                 |
| `getActiveNotificationsByType` | `(type) → Notification[]`                            | Get all active of a type              |
| `deleteNotification`           | `(notificationId) → Notification                     | null`                                 | Cascade delete with deliveries/tokens |
| `getUserDeliveryHistory`       | `(userId, limit?, offset?) → NotificationDelivery[]` | Get delivery history                  |
| `getBatchDeliveries`           | `(emailBatchId) → NotificationDelivery[]`            | Get all deliveries in a batch         |
| `getPeriodKey`                 | `(type, date?) → string`                             | Generate period key                   |

### 7.2 EmailService Methods

| Method                     | Signature                                      | Description                              |
| -------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `sendBatchedNotifications` | `(userId, email, pending[]) → string`          | Send consolidated email, returns batchId |
| `hasBeenDelivered`         | `(deliveryKey) → boolean`                      | Check if already delivered               |
| `getDeliveryKey`           | `(userId, notificationId, periodKey) → string` | Generate delivery key                    |

---

## 8. Repository Layer

### 8.1 NotificationsRepository

```typescript
interface NotificationsRepository {
  create(input: CreateNotificationInput, client?: PoolClient): Promise<Notification>;
  findById(id: UUID, client?: PoolClient): Promise<Notification | null>;
  findByHash(hash: string, client?: PoolClient): Promise<Notification | null>;
  findByUserId(userId: string, activeOnly?: boolean): Promise<Notification[]>;
  findByEntityCui(entityCui: string, activeOnly?: boolean): Promise<Notification[]>;
  findByType(
    type: NotificationType,
    activeOnly?: boolean,
    client?: PoolClient
  ): Promise<Notification[]>;
  findByUserAndEntity(
    userId: string,
    entityCui: string | null,
    activeOnly?: boolean
  ): Promise<Notification[]>;
  findByUserTypeAndEntity(
    userId: string,
    type: NotificationType,
    entityCui: string | null,
    client?: PoolClient
  ): Promise<Notification | null>;
  findUserSeriesAlerts(userId: string, activeOnly?: boolean): Promise<Notification[]>;
  update(id: UUID, input: UpdateNotificationInput, client?: PoolClient): Promise<Notification>;
  deactivate(id: UUID, client?: PoolClient): Promise<Notification>;
  deleteCascade(id: UUID): Promise<Notification | null>;
  getActiveNotificationsByUser(userId: string): Promise<Notification[]>;
}
```

### 8.2 NotificationDeliveriesRepository

```typescript
interface NotificationDeliveriesRepository {
  create(input: CreateDeliveryInput, client?: PoolClient): Promise<NotificationDelivery>;
  findByDeliveryKey(deliveryKey: string, client?: PoolClient): Promise<NotificationDelivery | null>;
  findByEmailBatchId(emailBatchId: string): Promise<NotificationDelivery[]>;
  findByUserId(userId: string, limit?: number, offset?: number): Promise<NotificationDelivery[]>;
  findByNotificationId(notificationId: UUID): Promise<NotificationDelivery[]>;
  findByUserAndPeriod(userId: string, periodKey: string): Promise<NotificationDelivery[]>;
  checkDeliveryExists(deliveryKey: string, client?: PoolClient): Promise<boolean>;
  getRecentDeliveries(limit?: number): Promise<NotificationDelivery[]>;
}
```

### 8.3 UnsubscribeTokensRepository

```typescript
interface UnsubscribeTokensRepository {
  create(input: CreateTokenInput, client?: PoolClient): Promise<UnsubscribeToken>;
  findByToken(token: string, client?: PoolClient): Promise<UnsubscribeToken | null>;
  findByUserId(userId: string, activeOnly?: boolean): Promise<UnsubscribeToken[]>;
  findByNotificationId(notificationId: UUID): Promise<UnsubscribeToken[]>;
  markAsUsed(token: string, client?: PoolClient): Promise<UnsubscribeToken>;
  deleteExpired(): Promise<number>;
  isTokenValid(token: string, client?: PoolClient): Promise<boolean>;
}
```

---

## 9. Data Providers

### 9.1 Provider Registry

Routes notification type to appropriate data provider:

```typescript
async function fetchNotificationSeries(
  notification: Notification,
  periodKey: string
): Promise<ProviderResult | null> {
  if (notification.notificationType === 'alert_series_analytics') {
    return fetchAnalyticsSeries(notification, periodKey);
  }
  if (notification.notificationType === 'alert_series_static') {
    return fetchStaticSeries(notification, periodKey);
  }
  return null;
}
```

### 9.2 Provider Result Format

```typescript
interface ProviderResult {
  series: AnalyticsSeries;
  metadata?: SeriesMeta;
}

interface SeriesMeta {
  current?: { x: string; y: number };
  comparisons?: {
    prev?: { abs?: number; pct?: number };
    yoy?: { abs?: number; pct?: number };
  };
  stats?: { min: number; max: number; avg: number; count: number };
  conditions?: Array<{ operator: AlertOperator; threshold: number; unit: string; met: boolean }>;
  periodType?: 'MONTH' | 'QUARTER' | 'YEAR';
  periodKey?: string;
  datasetId?: string;
  sourceName?: string;
  sourceUrl?: string;
}

interface AnalyticsSeries {
  seriesId: string;
  xAxis: { name: string; type: AxisDataType; unit: string };
  yAxis: { name: string; type: AxisDataType; unit: string };
  data: Array<{ x: string; y: number }>;
}
```

### 9.3 Series Metadata Computation

The providers compute the following metadata:

- **Current value**: Last data point in the series
- **Previous comparison**: Absolute and percentage change vs previous period
- **YoY comparison**: Absolute and percentage change vs same period last year
- **Statistics**: Computed over a sliding window
  - Monthly: Last 12 months
  - Quarterly: Last 8 quarters
  - Yearly: Last 5 years
- **Condition evaluation**: Each configured condition is evaluated against current value

```typescript
function evaluateCondition(value: number, op: AlertOperator, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
  }
}
```

---

## 10. Batch Send Script

### 10.1 Usage

```bash
ts-node scripts/send-newsletters.ts --clerk-token <token> [options]

Options:
  --type <type>      Notification type (optional, sends all types if omitted)
  --clerk-token      Clerk admin token for email lookup (required)
  --user <id>        Send only to specific user (for testing)
  --dry-run          Simulate without sending emails
  --date <ISO>       Override date for period calculation (default: today)
```

### 10.2 Execution Flow

```
1. Parse CLI arguments
2. Fetch active notifications (by type or all types)
3. Filter by user if --user specified
4. Group notifications by user
5. Fetch user emails from Clerk in batches of 10
6. For each user:
   a. Skip if no email found
   b. For each notification:
      - Generate period key
      - Check if already delivered (skip if yes)
      - Fetch notification data
      - For alerts: evaluate conditions (skip if not triggered)
      - Add to pending list
   c. If pending notifications exist:
      - In dry-run: log what would be sent
      - Otherwise: call emailService.sendBatchedNotifications()
7. Print summary (success/skip/error counts)
```

### 10.3 Transaction Flow (sendBatchedNotifications)

```
BEGIN TRANSACTION
  1. For each pending notification:
     - Create unsubscribe token
     - Build email section
     - Insert delivery record
  2. Build consolidated email data
  3. Send email via provider
  4. If email fails: ROLLBACK
COMMIT
```

---

## 11. External Dependencies

| Dependency       | Purpose                               | Usage Location                                         |
| ---------------- | ------------------------------------- | ------------------------------------------------------ |
| `@clerk/backend` | User email lookup                     | `scripts/send-newsletters.ts`                          |
| `pg`             | PostgreSQL client                     | All repositories                                       |
| `zod`            | Request validation                    | `src/routes/notifications.ts`, `src/schemas/alerts.ts` |
| `crypto`         | SHA-256 hash, random token generation | `types.ts`, `unsubscribeTokensRepository.ts`           |
| `uuid`           | UUID generation                       | `notificationsRepository.ts`                           |

---

## 12. Validation Schemas (Zod)

### 12.1 Alert Schemas

```typescript
const alertOperatorEnum = z.enum(['gt', 'gte', 'lt', 'lte', 'eq']);

const alertConditionSchema = z.object({
  operator: alertOperatorEnum,
  threshold: z.number(),
  unit: z.string().min(1).max(32),
});

const seriesAlertCommonSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  conditions: z.array(alertConditionSchema).default([]),
});

const analyticsSeriesAlertConfigSchema = seriesAlertCommonSchema.extend({
  filter: analyticsFilterSchema, // Your analytics filter schema
});

const staticSeriesAlertConfigSchema = seriesAlertCommonSchema.extend({
  datasetId: z.string().min(1),
});
```

### 12.2 API Request Schemas

```typescript
const createNotificationBodySchema = z.discriminatedUnion('notificationType', [
  z.object({
    notificationType: z.literal('newsletter_entity_monthly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('newsletter_entity_quarterly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('newsletter_entity_yearly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('alert_series_analytics'),
    entityCui: z.string().optional().nullable(),
    config: analyticsSeriesAlertConfigSchema,
  }),
  z.object({
    notificationType: z.literal('alert_series_static'),
    entityCui: z.string().optional().nullable(),
    config: staticSeriesAlertConfigSchema,
  }),
]);

const updateNotificationSchema = z.object({
  isActive: z.boolean().optional(),
  config: z.unknown().optional(),
});

const notificationIdParamsSchema = z.object({
  id: z.uuid(),
});
```

---

## 13. Missing/Placeholder Implementations

### 13.1 Email Provider Integration

**Current state**: Logs to console only

**Required implementation**:

```typescript
private async sendConsolidatedEmail(data: ConsolidatedEmailData): Promise<void> {
  // 1. Render email template with Handlebars
  const html = await renderEmailTemplate('consolidated-notification', data);

  // 2. Send via email provider API (SendGrid, AWS SES, Mailgun, etc.)
  await emailProvider.send({
    to: data.userEmail,
    from: 'notifications@yourdomain.com',
    subject: this.generateEmailSubject(data.sections),
    html,
  });
}
```

### 13.2 Email Templates

Referenced but not implemented:

- Handlebars template system
- `renderEmailTemplate()` function
- Template partials and helpers

### 13.3 Job Queue

**Current state**: Manual CLI script execution

**Recommended**: Implement background job processor (Bull/BullMQ, RabbitMQ) for:

- Scheduled newsletter sends
- Retry logic for failed deliveries
- Rate limiting

### 13.4 Monitoring & Logging

**Current state**: Basic `console.log`

**Recommended**:

- Structured logging (Winston, Pino)
- Metrics collection (delivery success/failure rates)
- Alerting for failed sends

---

## 14. File Inventory

### Core Services

| File                                                | Purpose                               |
| --------------------------------------------------- | ------------------------------------- |
| `src/services/notifications/types.ts`               | Type definitions, hash/key generation |
| `src/services/notifications/notificationService.ts` | Main business logic                   |
| `src/services/notifications/emailService.ts`        | Email sending with transactions       |
| `src/services/notifications/emailTypes.ts`          | Email content type definitions        |

### Providers

| File                                                              | Purpose                 |
| ----------------------------------------------------------------- | ----------------------- |
| `src/services/notifications/providers/registry.ts`                | Provider routing        |
| `src/services/notifications/providers/seriesAnalyticsProvider.ts` | Analytics data fetching |
| `src/services/notifications/providers/seriesStaticProvider.ts`    | Static dataset fetching |

### Repositories

| File                                                      | Purpose            |
| --------------------------------------------------------- | ------------------ |
| `src/db/repositories/notificationsRepository.ts`          | Notifications CRUD |
| `src/db/repositories/notificationDeliveriesRepository.ts` | Delivery tracking  |
| `src/db/repositories/unsubscribeTokensRepository.ts`      | Token management   |

### Routes & Scripts

| File                          | Purpose             |
| ----------------------------- | ------------------- |
| `src/routes/notifications.ts` | REST API endpoints  |
| `scripts/send-newsletters.ts` | Batch send CLI tool |

### Schemas

| File                         | Purpose                       |
| ---------------------------- | ----------------------------- |
| `src/schemas/alerts.ts`      | Zod schemas for alert configs |
| `src/db/schema-userdata.sql` | Database table definitions    |

---

## 15. Migration Considerations

### 15.1 Required External Systems

| System                    | Purpose                       | Current Integration             |
| ------------------------- | ----------------------------- | ------------------------------- |
| User Database             | Authentication & email lookup | Clerk                           |
| Budget/Analytics Database | Entity newsletter data        | `executionLineItemRepository`   |
| Static Datasets Database  | Static series alerts          | `staticDatasetsRepository`      |
| Entity Database           | Entity metadata               | `entityRepository`              |
| Aggregated Line Items     | Top categories data           | `aggregatedLineItemsRepository` |

### 15.2 Configuration Requirements

| Variable                    | Purpose                               | Default                 |
| --------------------------- | ------------------------------------- | ----------------------- |
| `BASE_URL`                  | Server base URL for unsubscribe links | `http://localhost:3000` |
| `CLIENT_BASE_URL`           | Client app URL for entity links       | `http://localhost:5173` |
| `PUBLIC_CLIENT_BASE_URL`    | Fallback for client URL               | -                       |
| Database connection strings | Both `budget_db` and `userdata_db`    | -                       |

### 15.3 Key Business Rules

1. **Entity requirement**: Newsletter types (`newsletter_entity_*`) require an `entityCui`
2. **Config requirement**: Alert types (`alert_series_*`) require a valid `config` with conditions
3. **Hash uniqueness**: Notifications are uniquely identified by SHA-256 hash of `(userId, type, entityCui, config)`
4. **Delivery deduplication**: Deliveries are deduplicated by composite key `(userId, notificationId, periodKey)`
5. **Token expiry**: Unsubscribe tokens expire after 1 year
6. **Cascade deletion**: Deleting a notification removes related deliveries and tokens
7. **Alert triggering**: Series alerts only send if ALL conditions are met
8. **Batch consolidation**: Multiple notifications for same user are consolidated into one email

### 15.4 Migration Checklist

- [ ] Configure Clerk integration or alternative auth provider
- [ ] Set up email provider (SendGrid/SES/etc.)
- [ ] Implement email templates
- [ ] Configure environment variables
- [ ] Set up job scheduler for automated sends
- [ ] Implement monitoring and alerting
- [ ] Test unsubscribe flow end-to-end
- [ ] Verify cascade delete behavior

</specification>

The goal is to write a new specification file using the our architectural decisions, adapting the old specification to our needs.

The clients uses the following apis:
<apis>
GET <https://api.transparenta.eu/api/v1/notifications/entity/4267117>
Authorization: Bearer <jwt_token>

Response:

{
"ok": true,
"data": [
{
"id": "049fe74a-1758-424a-8be0-9bdad470915b",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": "4267117",
"notificationType": "newsletter_entity_monthly",
"isActive": true,
"config": null,
"hash": "714ad6ccb8c514ceebebaae4a98ad2bcd7ed822f3099af3eb07282c5af9567fe",
"createdAt": "2025-11-16T11:21:32.344Z",
"updatedAt": "2025-11-16T11:21:32.344Z"
}
]
}
</apis>
<apis>

<https://api.transparenta.eu/api/v1/notifications>
Request Method
GET
{
"ok": true,
"data": [
{
"id": "948649a1-54f3-4963-84b3-2d3da74940dc",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": "4270740",
"notificationType": "newsletter_entity_quarterly",
"isActive": false,
"config": null,
"hash": "eaff729c15ba27c8a8b80e303f0d3f7ca7ec92c0588ac600893f5721c35f1d2b",
"createdAt": "2025-11-17T06:09:05.121Z",
"updatedAt": "2025-11-17T06:09:15.987Z"
},
{
"id": "77868ecd-07f1-4ec1-b8b6-c8ce6cbd9847",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": null,
"notificationType": "alert_series_analytics",
"isActive": true,
"config": {
"title": "Transporturi alert",
"filter": {
"is_uat": true,
"report_type": "Executie bugetara agregata la nivel de ordonator principal",
"county_codes": [
"B"
],
"normalization": "total",
"report_period": {
"type": "YEAR",
"selection": {
"interval": {
"end": "2025",
"start": "2016"
}
}
},
"account_category": "ch",
"functional_prefixes": [
"84"
]
},
"conditions": [],
"description": "Alert created from chart \"Buget Bucuresti 2016-2025\""
},
"hash": "6e39da6592c3c1c06dad2e5821256757b6b24f4fdab373733b291e2784bf9c57",
"createdAt": "2025-11-16T11:22:02.741Z",
"updatedAt": "2025-11-16T11:22:02.741Z"
},
{
"id": "049fe74a-1758-424a-8be0-9bdad470915b",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": "4267117",
"notificationType": "newsletter_entity_monthly",
"isActive": true,
"config": null,
"hash": "714ad6ccb8c514ceebebaae4a98ad2bcd7ed822f3099af3eb07282c5af9567fe",
"createdAt": "2025-11-16T11:21:32.344Z",
"updatedAt": "2025-11-16T11:21:32.344Z"
},
{
"id": "a5392788-2a4d-4009-ac7a-c85cdbb0b896",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": "4270740",
"notificationType": "newsletter_entity_yearly",
"isActive": false,
"config": null,
"hash": "ca7addab6fcc6d643a4ed6ab5d08c9978e84dc94cd316e2e9bf2c5a48adc16f0",
"createdAt": "2025-11-08T12:37:47.744Z",
"updatedAt": "2025-11-17T06:09:14.143Z"
},
{
"id": "8c2c26be-128b-4d33-9bed-f86fd5fb61fd",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": null,
"notificationType": "alert_series_analytics",
"isActive": true,
"config": {
"title": "Transporturi alert",
"filter": {
"is_uat": true,
"exclude": {
"economic_prefixes": [
"51"
]
},
"entity_cuis": [],
"report_type": "Executie bugetara agregata la nivel de ordonator principal",
"county_codes": [
"B"
],
"normalization": "total",
"report_period": {
"type": "YEAR",
"selection": {
"dates": []
}
},
"account_category": "ch",
"functional_prefixes": [
"84"
]
},
"conditions": [],
"description": "Alert created from chart \"Functional Budget Distribution\""
},
"hash": "f7fba8062575cd8df973f1f271d21b7ea43327f2f263fef1a0d14d7e02d9064e",
"createdAt": "2025-11-08T12:37:21.412Z",
"updatedAt": "2025-11-08T12:37:21.412Z"
},
{
"id": "e01d0b87-a01b-4d13-b59d-f45f0074748d",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": null,
"notificationType": "alert_series_analytics",
"isActive": true,
"config": {
"title": "Ministry of European Investments and Projects - Total Expenses alert",
"filter": {
"exclude": {},
"entity_cuis": [
"38918422"
],
"report_type": "Executie bugetara agregata la nivel de ordonator principal",
"normalization": "total",
"report_period": {
"type": "YEAR",
"selection": {
"interval": {
"end": "2024",
"start": "2016"
}
}
},
"account_category": "ch"
},
"conditions": [],
"description": "Alert created from chart \"EU Investments Ministry - Budget Evolution (2016-2024)\""
},
"hash": "1d7f4a6553ddfda3692e01f476f313253ec02f3314610c385ec4a9e089ba2985",
"createdAt": "2025-11-05T17:34:18.717Z",
"updatedAt": "2025-11-05T17:34:18.717Z"
},
{
"id": "771bd90c-a0d9-4efd-a27d-3fd768f1a591",
"userId": "user_34QaVGwRWxrn8ScB9adgz3FOSTa",
"entityCui": "4270740",
"notificationType": "newsletter_entity_monthly",
"isActive": true,
"config": null,
"hash": "b7e08a0189ed59c85dbf41af92fb6b7b1640542514da484277fc1e3bfbb04b2a",
"createdAt": "2025-11-05T15:45:14.844Z",
"updatedAt": "2025-11-17T06:09:03.649Z"
}
]
}

<https://api.transparenta.eu/api/v1/notifications/77868ecd-07f1-4ec1-b8b6-c8ce6cbd9847>
Request Method
PATCH

</apis>

Here is the old api code
<old_api_code>
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../utils/auth-hook';
import { notificationService } from '../services/notifications/notificationService';
import { unsubscribeTokensRepository } from '../db/repositories/unsubscribeTokensRepository';
import { notificationsRepository } from '../db/repositories/notificationsRepository';
import { z } from 'zod';
import type { NotificationType, NotificationConfig } from '../services/notifications/types';
import { ValidationError } from '../utils/errors';
import { formatZodError } from '../utils/validation';
import { analyticsSeriesAlertConfigSchema, staticSeriesAlertConfigSchema } from '../schemas/alerts';

// Validation schemas

// Strong, per-type request body validation using discriminated union
const createNotificationBodySchema = z.discriminatedUnion('notificationType', [
z.object({
notificationType: z.literal('newsletter_entity_monthly'),
entityCui: z.string().min(1),
config: z.null().optional(),
}),
z.object({
notificationType: z.literal('newsletter_entity_quarterly'),
entityCui: z.string().min(1),
config: z.null().optional(),
}),
z.object({
notificationType: z.literal('newsletter_entity_yearly'),
entityCui: z.string().min(1),
config: z.null().optional(),
}),
z.object({
notificationType: z.literal('alert_series_analytics'),
entityCui: z.string().optional().nullable(),
config: analyticsSeriesAlertConfigSchema,
}),
z.object({
notificationType: z.literal('alert_series_static'),
entityCui: z.string().optional().nullable(),
config: staticSeriesAlertConfigSchema,
}),
]);

const updateNotificationSchema = z.object({
isActive: z.boolean().optional(),
config: z.unknown().optional(),
});

const notificationIdParamsSchema = z.object({
id: z.uuid(),
});

export default async function notificationRoutes(fastify: FastifyInstance) {
await fastify.register(async function (fastify) {
/\*\*
_POST /api/v1/notifications/subscribe
_ Subscribe to a notification
\*/
fastify.post(
'/api/v1/notifications',
{
preHandler: [authenticate],
},
async (request: FastifyRequest, reply: FastifyReply) => {
const userId = request.auth?.userId;
if (!userId) {
return reply.code(401).send({ ok: false, error: 'Unauthorized' });
}

        try {
          const parsed = createNotificationBodySchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send({ ok: false, error: 'Invalid request body', details: formatZodError(parsed.error) });
          }
          const { notificationType, entityCui } = parsed.data as any;
          const config: NotificationConfig = (parsed.data as any).config ?? null;

          const notification = await notificationService.subscribe(
            userId,
            notificationType as NotificationType,
            entityCui,
            config
          );

          return reply.code(200).send({ ok: true, data: notification });
        } catch (err: any) {
          if (err instanceof ValidationError) {
            return reply
              .code(400)
              .send({ ok: false, error: err.message, details: err.issues ?? [] });
          }
          request.log.error(err, 'Failed to subscribe to notification');
          return reply.code(500).send({ ok: false, error: err.message || 'Internal server error' });
        }
      }
    );

    /**
     * POST /api/v1/notifications/:id/unsubscribe
     * Unsubscribe from a notification (deactivate)
     */
    /**
     * GET /api/v1/notifications
     * Get all notifications for the authenticated user
     */
    fastify.get(
      '/api/v1/notifications',
      {
        preHandler: [authenticate],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const notifications = await notificationService.getUserNotifications(userId, false);
          return reply.code(200).send({ ok: true, data: notifications });
        } catch (err: any) {
          request.log.error(err, 'Failed to get notifications');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/entity/:cui
     * Get notifications for a specific entity (user's notifications for that entity)
     */
    fastify.get<{ Params: { cui: string } }>(
      '/api/v1/notifications/entity/:cui',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const { cui } = request.params;
          const notifications = await notificationService.getUserEntityNotifications(userId, cui);

          return reply.code(200).send({ ok: true, data: notifications });
        } catch (err: any) {
          request.log.error(err, 'Failed to get entity notifications');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * PATCH /api/v1/notifications/:id/config
     * Update notification configuration
     */
    fastify.patch<{ Params: { id: string } }>(
      '/api/v1/notifications/:id',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const parsedParams = notificationIdParamsSchema.safeParse(request.params);
          if (!parsedParams.success) {
            return reply
              .code(400)
              .send({
                ok: false,
                error: 'Invalid notification ID',
                details: formatZodError(parsedParams.error),
              });
          }
          const notificationId = parsedParams.data.id;

          const parsed = updateNotificationSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send({ ok: false, error: 'Invalid request body', details: formatZodError(parsed.error) });
          }

          // Verify ownership
          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          // If config provided, validate per notification type
          let updates: { isActive?: boolean; config?: NotificationConfig | null } = {};
          if (parsed.data.isActive !== undefined) {
            updates.isActive = parsed.data.isActive;
          }

          if (parsed.data.config !== undefined) {
            const cfg = parsed.data.config;
            if (notification.notificationType === 'alert_series_analytics') {
              const result = analyticsSeriesAlertConfigSchema.safeParse(cfg);
              if (!result.success) {
                return reply
                  .code(400)
                  .send({ ok: false, error: 'Invalid analytics alert config', details: formatZodError(result.error) });
              }
              updates.config = result.data;
            } else if (notification.notificationType === 'alert_series_static') {
              const result = staticSeriesAlertConfigSchema.safeParse(cfg);
              if (!result.success) {
                return reply
                  .code(400)
                  .send({ ok: false, error: 'Invalid static alert config', details: formatZodError(result.error) });
              }
              updates.config = result.data;
            } else {
              updates.config = null;
            }
          }

          const updated = await notificationService.update(notificationId, updates);

          return reply.code(200).send({ ok: true, data: updated });
        } catch (err: any) {
          if (err instanceof ValidationError) {
            return reply
              .code(400)
              .send({ ok: false, error: err.message, details: err.issues ?? [] });
          }
          request.log.error(err, 'Failed to update notification config');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/deliveries
     * Get delivery history for authenticated user
     */
    fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
      '/api/v1/notifications/deliveries',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
          const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

          const deliveries = await notificationService.getUserDeliveryHistory(userId, limit, offset);

          return reply.code(200).send({ ok: true, data: deliveries });
        } catch (err: any) {
          request.log.error(err, 'Failed to get delivery history');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/unsubscribe/:token
     * Unsubscribe via email link (no authentication required)
     */
    fastify.get<{ Params: { token: string } }>(
      '/api/v1/notifications/unsubscribe/:token',
      async (request, reply) => {
        try {
          const { token } = request.params;

          // Validate token
          const isValid = await unsubscribeTokensRepository.isTokenValid(token);
          if (!isValid) {
            return reply.code(400).send({ ok: false, error: 'Invalid or expired token' });
          }

          // Get token details
          const tokenData = await unsubscribeTokensRepository.findByToken(token);
          if (!tokenData) {
            return reply.code(404).send({ ok: false, error: 'Token not found' });
          }

          // Mark token as used
          await unsubscribeTokensRepository.markAsUsed(token);

          // Deactivate notification
          await notificationService.unsubscribe(tokenData.notificationId);

          return reply.code(200).send({
            ok: true,
            message: 'Successfully unsubscribed from notifications',
          });
        } catch (err: any) {
          request.log.error(err, 'Failed to process unsubscribe');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * DELETE /api/v1/notifications/:id
     * Delete a notification and related data
     */
    fastify.delete<{ Params: { id: string } }>(
      '/api/v1/notifications/:id',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const parsedParams = notificationIdParamsSchema.safeParse(request.params);
          if (!parsedParams.success) {
            return reply
              .code(400)
              .send({
                ok: false,
                error: 'Invalid notification ID',
                details: formatZodError(parsedParams.error),
              });
          }
          const notificationId = parsedParams.data.id;

          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          await notificationService.deleteNotification(notificationId);

          return reply.code(200).send({ ok: true });
        } catch (err: any) {
          request.log.error(err, 'Failed to delete notification');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

});
}

</old_api_code>

---

I need to brainstorm with you some ideas for building a more complex entity ranking table. I need to combine analytics filter input to obtain more valuable information, like the entity deficit, which means we need to get the total income and total expense and compute the difference, or we may need different ratios. I want to explore how this can be done. I would want to generate a series of data based on the analytics calculation. This data is generated for each entity and then ranked.

For the input, we could use somthing like:

```

type SeriesId = string;
export type Operand = SeriesId | Calculation | number;
export type Operation = 'sum' | 'subtract' | 'multiply' | 'divide';
// Add mechanism to avoid circular dependencies. Also, add validation for operations: Ex: divide by zero, etc.
export interface Calculation {
  op: Operation;
  args: Array<Operand>;
}

const SeriesIdSchema = z.string().describe('Reference to another series by its ID. Used in calculations to reference data from other series. The series must exist in the same chart. Example: "series-edu-001" references the education spending series. Used as operand in calculations like "revenue - expenses" where each is a series ID.');
const OperationSchema = z.enum(['sum', 'subtract', 'multiply', 'divide']).describe('Mathematical operation for calculations. "sum": add all operands (2+ values) - use for totals. "subtract": first operand minus second (exactly 2 values) - use for deficits, growth. "multiply": multiply all operands - use for scaling, ratios. "divide": first operand divided by second (exactly 2 values) - use for per-unit calculations. Example: { op: "subtract", args: ["revenue-series-id", "expenses-series-id"] } calculates budget balance.');

const CalculationSchema: z.ZodType<Calculation> = z.lazy(() =>
  z.object({
    op: OperationSchema,
    args: z.array(OperandSchema).describe('Array of operands for the calculation. Each operand can be: (1) a series ID string referencing another series, (2) a nested Calculation object for complex expressions, or (3) a number constant. Minimum 2 operands. Order matters for subtract/divide. Example: ["series-a", "series-b"] for basic operations, or ["series-a", { op: "multiply", args: ["series-b", 2] }] for nested calculations. Warning: avoid circular references where series A depends on B and B depends on A.'),
  }).describe('Calculation definition for computed series. Defines a mathematical operation on other series or values. Supports nesting for complex expressions like "(A + B) / C". Common use cases: budget deficit = revenue - expenses, growth rate = (current - previous) / previous, weighted average = sum of (value * weight). System validates for circular dependencies and division by zero at runtime.')
);

const OperandSchema: z.ZodType<Operand> = z.lazy(() =>
  z.union([SeriesIdSchema, CalculationSchema, z.number()]).describe('An operand in a calculation. Can be: (1) Series ID string - references data from another series in the chart, (2) Nested Calculation - for complex expressions like ((A+B)/C), (3) Number constant - for fixed values like scaling factors or thresholds. Examples: "revenue-series-id" (series reference), { op: "sum", args: ["a", "b"] } (nested calc), 1000000 (constant). Choose based on needs: series for dynamic data, nested calc for multi-step math, number for constants.')
);
```

The challenge is how we generate a paginated ranked results.

---

## Goal

Brainstorm how to build an **entity ranking table** where entities are ranked by calculated metrics (e.g., deficit = income - expenses, ratios, growth rates).

## Current Design

I have a calculation schema that allows defining computed series:

```typescript
type SeriesId = string;
export type Operand = SeriesId | Calculation | number;
export type Operation = 'sum' | 'subtract' | 'multiply' | 'divide';

export interface Calculation {
  op: Operation;
  args: Array<Operand>;
}
```

**Example use case:** Rank entities by budget deficit

```typescript
{ op: 'subtract', args: ['total-income-series', 'total-expense-series'] }
```

## The Challenge

How do we generate **paginated, ranked results** when:

1. Each entity needs its calculated value computed first
2. Results must be sorted by that computed value
3. We need efficient pagination (not compute-all-then-paginate)

## What I Want to Explore

- Data flow: filter inputs → calculation → per-entity results → ranking
- Pagination strategies for computed rankings
- Sorting by different fields
- Generating the values for each period (month, quarter, year) and the total. allow sorting by specific period or total
- Combine different data series with different unit to obtain a meaningful value, like spending/capita but more complex ones, like spending/young_adults, etc

---

I like some or your ideas, but I have a good one that I want to explore. What if we store the computation for each entity into a table. This way, we can have a limited batch of entities that run in parallel and store the results in a table, with value for each period based on the data series filter. After we generate all the series for all the entities, then we can use the rank and so on. We can even add the rank value for the total to display it in the entity page.
