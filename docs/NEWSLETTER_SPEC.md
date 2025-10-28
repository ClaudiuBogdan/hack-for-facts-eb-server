# Newsletter & Alerts Module - Technical Specification

## Overview

A subscription-based notification system allowing users to receive newsletters and alerts about budget execution entities. The system prioritizes simplicity, security, and auditability while avoiding storage of sensitive user data.

## Core Principles

1. **No Email Storage** - Only Clerk user IDs are stored; emails fetched at send-time with admin token
2. **Manual Execution** - Newsletters sent via CLI scripts, not automated cron jobs
3. **Code-Based Configuration** - Notification types and templates defined in code, not database
4. **Transaction-Based Deduplication** - Database constraints and transactions prevent duplicate sends
5. **Success-Only Audit Trail** - Only successful deliveries are recorded; failures are rolled back

---

## Database Schema

### Notifications Table

Stores user notification preferences for entities and notification types.

```sql
CREATE TABLE Notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NULL, -- Reference to main DB Entities (nullable for global notifications)
  notification_type VARCHAR(50) NOT NULL, -- 'newsletter_entity_monthly', 'alert_entity_threshold', etc.
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Configuration (newsletters, alerts, custom queries)
  config JSONB,

  -- Hash for uniqueness: hash(user_id, notification_type, entity_cui, config)
  hash TEXT UNIQUE NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_active ON Notifications(user_id) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_entity ON Notifications(entity_cui) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_type_active ON Notifications(notification_type) WHERE is_active = TRUE;
```

**Fields:**

- `user_id`: Clerk user identifier (never store email here)
- `entity_cui`: CUI of the entity (NULL for global/non-entity notifications)
- `notification_type`: Type of notification (see Notification Types section)
- `is_active`: Whether notification is active (soft delete)
- `config`: JSON configuration for any notification-specific settings
- `hash`: Unique hash to prevent duplicate configurations

### NotificationDeliveries Table

Tracks **only successfully delivered** notifications for deduplication and audit.

```sql
CREATE TABLE NotificationDeliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id BIGINT NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,

  -- Period identifier for deduplication
  period_key TEXT NOT NULL, -- '2025-01', '2025-Q1', '2025'

  -- Composite deduplication key: user_id:notification_id:period_key
  delivery_key TEXT UNIQUE NOT NULL,

  -- Email/SMS batch identifier (groups notifications sent in same email/sms/notification)
  notification_batch_id UUID NOT NULL,

  -- Delivery timestamp (always set - only successful sends recorded)
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional metadata for audit (alert values, etc.)
  metadata JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_delivery_key ON NotificationDeliveries(delivery_key);
CREATE INDEX idx_deliveries_user_period ON NotificationDeliveries(user_id, period_key);
CREATE INDEX idx_deliveries_created_at ON NotificationDeliveries(created_at DESC);
CREATE INDEX idx_deliveries_notification ON NotificationDeliveries(notification_id);
CREATE INDEX idx_deliveries_email_batch ON NotificationDeliveries(notification_batch_id);
```

**Fields:**

- `delivery_key`: Unique composite key preventing duplicate sends (enforced at DB level)
- `period_key`: Human-readable period identifier (e.g., '2025-01' for January 2025)
- `notification_batch_id`: UUID identifying the email batch (all notifications sent in same email share this ID)
- `sent_at`: When email was successfully sent (always populated)
- `metadata`: Optional audit data (alert threshold values, data snapshot, etc.)

**Key Design Principles:**

1. **Success-Only Recording**: Only successful deliveries create a database record
2. **Batched Emails**: Multiple notifications for same user sent in one email
   - All notifications in batch share same `notification_batch_id`
   - Example: User has 3 entity newsletters + 2 alerts → 1 email with 5 sections
3. **Transaction-Based**: Each batch send wrapped in a transaction:
   - Insert all delivery records for batch (locks via unique constraints)
   - Send single consolidated email
   - Commit transaction (only if email sent successfully)
   - Rollback on failure (no records created)
4. **Concurrent Send Protection**: If two processes try to send same notification:
   - First process: Inserts delivery record → Acquires lock → Sends email
   - Second process: Tries to insert → **Constraint violation** → Skips (already being processed)
5. **Idempotency**: Re-running the script skips already-sent notifications automatically:
   - Query: `SELECT 1 FROM NotificationDeliveries WHERE delivery_key = ?`
   - If exists → Skip
   - If not exists → Proceed with transaction

### UnsubscribeTokens Table

Manages unsubscribe tokens for email links.

```sql
CREATE TABLE UnsubscribeTokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id BIGINT NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

CREATE INDEX idx_unsubscribe_tokens_user ON UnsubscribeTokens(user_id) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_expires ON UnsubscribeTokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_notification ON UnsubscribeTokens(notification_id);
```

**Fields:**

- `token`: Cryptographically secure unsubscribe token
- `notification_id`: Links to specific notification configuration
- `expires_at`: Token expiration (1 year)
- `used_at`: When token was used (NULL = unused)

---

## Notification Types

Defined in code at `src/services/notifications/types.ts`:

```typescript
export type NotificationType =
  | 'newsletter_entity_monthly'      // Monthly entity newsletter
  | 'newsletter_entity_quarterly'    // Quarterly entity newsletter
  | 'newsletter_entity_annual'       // Annual entity newsletter
  | 'alert_data_series';             // Data series alert (custom queries)

export interface NotificationTypeConfig {
  type: NotificationType;
  templateName: string;
  displayName: string;
  description: string;
}

export const NOTIFICATION_TYPE_CONFIGS: Record<NotificationType, NotificationTypeConfig> = {
  newsletter_entity_monthly: {
    type: 'newsletter_entity_monthly',
    templateName: 'newsletter-entity-monthly',
    displayName: 'Raport Lunar - Entitate',
    description: 'Primește un raport lunar cu execuția bugetară a entității'
  },
  newsletter_entity_quarterly: {
    type: 'newsletter_entity_quarterly',
    templateName: 'newsletter-entity-quarterly',
    displayName: 'Raport Trimestrial - Entitate',
    description: 'Primește un raport trimestrial cu execuția bugetară a entității'
  },
  newsletter_entity_yearly: {
    type: 'newsletter_entity_yearly',
    templateName: 'newsletter-entity-yearly',
    displayName: 'Raport Anual - Entitate',
    description: 'Primește un raport anual cu execuția bugetară a entității'
  },
  alert_data_series: {
    type: 'alert_data_series',
    templateName: 'alert-data-series',
    displayName: 'Alertă Serie de Date',
    description: 'Primește o alertă când o serie de date depășește o valoare stabilită'
  },
};
```

### Configuration Schema

The `config` JSONB field structure varies by notification type:

**Newsletter Config**:

```typescript
interface NewsletterConfig {
  includeComparisons?: boolean;      // Include YoY, MoM comparisons (default: true)
  includeTrends?: boolean;            // Include trend charts (default: true)
  topCategoriesLimit?: number;        // Number of top categories to show (default: 5)
}
```

**Data Series Alert Config**:

```typescript
interface AlertCondition {
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  threshold: number;
  unit: string;
}

interface DataSeriesAlertConfig {
  alertTitle?: string;
  alertDescription?: string;
  conditions?: AlertCondition[];
  analyticsInput?: {
    filter: {
      account_category: 'vn' | 'ch';
      report_period: {
        type: 'MONTH' | 'QUARTER' | 'YEAR';
        selection: {
          interval?: {
            start: string; // PeriodDate format: YYYY, YYYY-MM, or YYYY-Q[1-4]
            end: string;
          };
          dates?: string[];
        };
      };
      // All other AnalyticsFilterInput fields are optional
      report_type?: string;
      main_creditor_cui?: string;
      entity_cuis?: string[];
      functional_codes?: string[];
      functional_prefixes?: string[];
      economic_codes?: string[];
      economic_prefixes?: string[];
      funding_source_ids?: number[];
      budget_sector_ids?: number[];
      expense_types?: ('dezvoltare' | 'functionare')[];
      program_codes?: string[];
      county_codes?: string[];
      regions?: string[];
      uat_ids?: number[];
      entity_types?: string[];
      is_uat?: boolean;
      search?: string;
      min_population?: number;
      max_population?: number;
      normalization?: 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro';
      aggregate_min_amount?: number;
      aggregate_max_amount?: number;
      item_min_amount?: number;
      item_max_amount?: number;
    };
    seriesId?: string;
  };
}
```

**Notes:**

- `alertTitle`: Custom title for the alert (e.g., "Cluj County Spending Alert")
- `alertDescription`: Optional description providing context
- `analyticsInput`: Uses the same filter structure as the `executionAnalytics` GraphQL query
- The data series will be evaluated during notification processing to generate email content
- The `analyticsInput` is required for `alert_data_series` notification type

### Hash Generation

```typescript
function generateNotificationHash(
  userId: string,
  notificationType: NotificationType,
  entityCui: string | null,
  config: any
): string {
  const crypto = require('crypto');
  const data = JSON.stringify({
    userId,
    notificationType,
    entityCui,
    config: config || {}
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}
```

---

## Deduplication Logic

### Delivery Key Generation

```typescript
function generateDeliveryKey(
  userId: string,
  notificationId: number,
  periodKey: string
): string {
  return `${userId}:${notificationId}:${periodKey}`;
}
```

**Examples:**

- `user_2abc123:42:2025-01` → January 2025 newsletter for notification #42
- `user_2abc123:42:2025-Q1` → Q1 2025 newsletter for notification #42

### Period Key Generation

```typescript
function generatePeriodKey(
  notificationType: NotificationType,
  config: any,
  date: Date = new Date()
): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const quarter = Math.ceil(month / 3);

  switch (notificationType) {
    case 'newsletter_entity_monthly':
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

    case 'newsletter_entity_quarterly':
      const prevQuarter = quarter === 1 ? 4 : quarter - 1;
      const qYear = quarter === 1 ? year - 1 : year;
      return `${qYear}-Q${prevQuarter}`;

    case 'newsletter_entity_annual':
      return String(year - 1);

    case 'alert_data_series':
      const alertPeriod = config?.period || 'monthly';
      if (alertPeriod === 'monthly') {
        return `${year}-${String(month).padStart(2, '0')}`;
      } else if (alertPeriod === 'quarterly') {
        return `${year}-Q${quarter}`;
      } else {
        return `${year}`;
      }

    default:
      throw new Error(`Unknown notification type: ${notificationType}`);
  }
}
```

### Transaction-Based Deduplication

**Before sending, check if already delivered:**

```typescript
async function wasAlreadySent(deliveryKey: string): Promise<boolean> {
  const result = await runQuery(
    'userdata',
    'SELECT 1 FROM NotificationDeliveries WHERE delivery_key = $1',
    [deliveryKey]
  );
  return result.rows.length > 0;
}
```

**Send batched notifications with transaction:**

```typescript
async function sendBatchedNotifications(
  userId: string,
  userEmail: string,
  pendingNotifications: Array<{
    notification: Notification;
    periodKey: string;
    deliveryKey: string;
    data: any;
  }>
): Promise<void> {
  // Generate unique batch ID for this email
  const notificationBatchId = crypto.randomUUID();

  // Start transaction
  await withTransaction('userdata', async (client) => {
    // 1. Insert all delivery records in batch (acquires locks via unique constraints)
    for (const { notification, periodKey, deliveryKey, data } of pendingNotifications) {
      try {
        await runQuery(
          'userdata',
          `INSERT INTO NotificationDeliveries
           (user_id, notification_id, period_key, delivery_key, notification_batch_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            notification.id,
            periodKey,
            deliveryKey,
            notificationBatchId,
            data.metadata || {}
          ],
          client
        );
      } catch (error: any) {
        // Unique constraint violation = another process is sending this
        if (error.code === '23505') {
          console.log(`[SKIP] ${deliveryKey} - concurrent send detected`);
          throw new Error('CONCURRENT_SEND'); // Rollback entire batch
        }
        throw error;
      }
    }

    // 2. Generate unsubscribe tokens for each notification
    const unsubscribeTokens = await Promise.all(
      pendingNotifications.map(({ notification }) =>
        unsubscribeTokenRepository.create({
          userId,
          notificationId: notification.id
        }, client)
      )
    );

    // 3. Prepare consolidated email data
    const emailData = {
      user: { id: userId },
      notificationBatchId,
      notifications: pendingNotifications.map(({ notification, data }, index) => ({
        type: notification.notification_type,
        entityCui: notification.entity_cui,
        config: NOTIFICATION_TYPE_CONFIGS[notification.notification_type],
        data,
        unsubscribeUrl: `${process.env.PUBLIC_URL}/unsubscribe/${unsubscribeTokens[index].token}`
      }))
    };

    // 4. Send single consolidated email
    await emailService.send({
      to: userEmail,
      template: 'consolidated-newsletter', // Single template with sections
      data: emailData
    });

    // Transaction commits automatically on success
    console.log(`[SENT] Batch ${notificationBatchId}: ${pendingNotifications.length} notifications to ${userEmail}`);
  });
  // If any error occurs, transaction is automatically rolled back
  // No delivery records created for failed sends
}
```

**Key Benefits:**

1. **Atomic Operations**: Insert all records + Email send = all-or-nothing
2. **Single Email Per User**: Better UX - one consolidated email instead of spam
3. **Email Batch ID**: Groups related notifications, enables batch analytics
4. **No Status Field Needed**: Record exists = successfully sent
5. **Automatic Rollback**: Failures don't pollute the database
6. **Concurrent Protection**: Unique constraint prevents race conditions
7. **Clean Audit Trail**: Only successful deliveries, no noise

**Example Email Batch:**

User `user_123` has 3 active notifications:

- Monthly newsletter for Entity A
- Quarterly newsletter for Entity B
- Data series alert for County X

Result: **1 email** sent with 3 sections, all sharing `email_batch_id: "abc-def-123"`

**Database Records Created:**

```
| id | user_id  | notification_id | period_key | notification_batch_id | sent_at             |
|----|----------|-----------------|------------|----------------|---------------------|
| 1  | user_123 | 42              | 2025-01    | abc-def-123    | 2025-01-05 09:00:00 |
| 2  | user_123 | 43              | 2025-Q1    | abc-def-123    | 2025-01-05 09:00:00 |
| 3  | user_123 | 99              | 2025-01    | abc-def-123    | 2025-01-05 09:00:00 |
```

---

## Manual Execution

### CLI Script

```bash
# Dry run (no emails sent, no DB records)
CLERK_SECRET_KEY_ADMIN=sk_... npm run newsletter newsletter_entity_monthly --dry-run

# Send to specific user only
CLERK_SECRET_KEY_ADMIN=sk_... npm run newsletter newsletter_entity_monthly --user user_2abc123

# Full production send
CLERK_SECRET_KEY_ADMIN=sk_... npm run newsletter newsletter_entity_monthly

# Other types
CLERK_SECRET_KEY_ADMIN=sk_... npm run newsletter newsletter_entity_quarterly
CLERK_SECRET_KEY_ADMIN=sk_... npm run newsletter alert_data_series
```

### Script Implementation

```typescript
// src/scripts/send-newsletters.ts

interface SendNewsletterOptions {
  type: NotificationType;
  clerkToken: string;
  dryRun?: boolean;
  userId?: string; // Optional: send only to specific user
}

export async function sendNewsletters(options: SendNewsletterOptions) {
  const { type, clerkToken, dryRun = false, userId } = options;

  console.log(`Starting newsletter send: ${type} (dry run: ${dryRun})`);

  const clerk = clerkClient({ secretKey: clerkToken });

  try {
    let notifications = await notificationRepository.getActiveByType(type);

    // Filter to specific user if requested
    if (userId) {
      notifications = notifications.filter(n => n.user_id === userId);
      console.log(`Filtered to user ${userId}: ${notifications.length} notification(s)`);
    } else {
      console.log(`Found ${notifications.length} active notifications`);
    }

    // Group notifications by user (to send one email per user)
    const notificationsByUser = new Map<string, Notification[]>();
    for (const notif of notifications) {
      const userNotifs = notificationsByUser.get(notif.user_id) || [];
      userNotifs.push(notif);
      notificationsByUser.set(notif.user_id, userNotifs);
    }

    console.log(`Grouped into ${notificationsByUser.size} users`);

    let sentCount = 0;
    let skippedCount = 0;
    let emailsSent = 0;

    // Process users in batches
    const userIds = Array.from(notificationsByUser.keys());
    const batchSize = 50;

    for (let i = 0; i < userIds.length; i += batchSize) {
      const userBatch = userIds.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        userBatch.map(userId => processUserBatch(
          userId,
          notificationsByUser.get(userId)!,
          clerk,
          dryRun
        ))
      );

      results.forEach(result => {
        if (result.status === 'fulfilled') {
          sentCount += result.value.sent;
          skippedCount += result.value.skipped;
          if (result.value.emailSent) emailsSent++;
        }
      });

      console.log(
        `Batch ${Math.floor(i / batchSize) + 1}: ` +
        `${emailsSent} emails sent, ${sentCount} notifications delivered, ${skippedCount} skipped`
      );

      if (i + batchSize < userIds.length) {
        await delay(1000);
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Total notifications: ${notifications.length}`);
    console.log(`Emails sent: ${emailsSent}`);
    console.log(`Notifications delivered: ${sentCount}`);
    console.log(`Notifications skipped: ${skippedCount}`);

  } finally {
    clerk.destroy?.();
  }
}

async function processUserBatch(
  userId: string,
  notifications: Notification[],
  clerk: ReturnType<typeof clerkClient>,
  dryRun: boolean
): Promise<{ sent: number; skipped: number; emailSent: boolean }> {

  // Check which notifications haven't been sent yet
  const pendingNotifications: Array<{
    notification: Notification;
    periodKey: string;
    deliveryKey: string;
    data: any;
  }> = [];

  for (const notification of notifications) {
    const periodKey = generatePeriodKey(notification.notification_type, notification.config);
    const deliveryKey = generateDeliveryKey(userId, notification.id, periodKey);

    // Check if already sent
    if (await wasAlreadySent(deliveryKey)) {
      continue;
    }

    // Generate notification data
    const data = await generateNotificationData(notification, periodKey);
    if (!data) {
      continue;
    }

    pendingNotifications.push({ notification, periodKey, deliveryKey, data });
  }

  // If nothing to send, skip
  if (pendingNotifications.length === 0) {
    return { sent: 0, skipped: notifications.length, emailSent: false };
  }

  // Fetch user email from Clerk
  const user = await clerk.users.getUser(userId);
  const email = user.emailAddresses[0]?.emailAddress;

  if (!email) {
    console.log(`[SKIP] User ${userId} - no email`);
    return { sent: 0, skipped: notifications.length, emailSent: false };
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would send ${pendingNotifications.length} notifications to ${email}`);
    return { sent: 0, skipped: notifications.length, emailSent: false };
  }

  // Send all notifications in one email (batched)
  try {
    await sendBatchedNotifications(userId, email, pendingNotifications);
    console.log(`[SENT] ${pendingNotifications.length} notifications to ${email}`);
    return {
      sent: pendingNotifications.length,
      skipped: notifications.length - pendingNotifications.length,
      emailSent: true
    };
  } catch (error: any) {
    if (error.message === 'CONCURRENT_SEND') {
      console.log(`[SKIP] Concurrent send detected for user ${userId}`);
      return { sent: 0, skipped: notifications.length, emailSent: false };
    }
    console.error(`[ERROR] Failed to send to ${email}: ${error.message}`);
    return { sent: 0, skipped: notifications.length, emailSent: false };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**CLI Entry Point:**

```typescript
if (require.main === module) {
  const args = process.argv.slice(2);
  const type = args[0] as NotificationType;
  const clerkToken = process.env.CLERK_SECRET_KEY_ADMIN;
  const dryRun = args.includes('--dry-run');
  const userId = args.includes('--user') ? args[args.indexOf('--user') + 1] : undefined;

  if (!type || !NOTIFICATION_TYPE_CONFIGS[type]) {
    console.error('Usage: ts-node src/scripts/send-newsletters.ts <type> [--dry-run] [--user <user_id>]');
    console.error('Types:', Object.keys(NOTIFICATION_TYPE_CONFIGS).join(', '));
    process.exit(1);
  }

  if (!clerkToken) {
    console.error('Error: CLERK_SECRET_KEY_ADMIN environment variable required');
    process.exit(1);
  }

  sendNewsletters({ type, clerkToken, dryRun, userId })
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
```

---

## API Endpoints

### Notification Management

#### List User Notifications

```http
GET /api/v1/notifications
Authorization: Bearer <clerk_token>
```

#### Get Notifications for Entity

```http
GET /api/v1/entities/:cui/notifications
Authorization: Bearer <clerk_token>
```

#### Create/Update Notification

```http
PUT /api/v1/notifications
Authorization: Bearer <clerk_token>
Content-Type: application/json

{
  "entityCui": "12345678",
  "notificationType": "newsletter_entity_monthly",
  "isActive": true,
  "config": { "includeComparisons": true }
}
```

**Note:** Hash computed server-side. If notification with same hash exists, it's updated.

#### Deactivate Notification

```http
PATCH /api/v1/notifications/:id
Authorization: Bearer <clerk_token>
Content-Type: application/json

{ "isActive": false }
```

### Unsubscribe (Public)

#### Confirm Unsubscribe

```http
POST /api/v1/unsubscribe/:token
```

**Behavior:**

- Marks notification as inactive (`is_active = false`)
- Marks token as used (`used_at = NOW()`)

---

## Email Template Structure

### Consolidated Newsletter Template

Single template (`consolidated-newsletter.html`) with dynamic sections based on notification types.

**Template Data Structure:**

```typescript
interface ConsolidatedEmailData {
  user: {
    id: string;
  };
  emailBatchId: string; // UUID for this email batch
  notifications: Array<{
    type: NotificationType;
    entityCui: string | null;
    config: NotificationTypeConfig;
    data: NewsletterData | AlertData; // Specific to notification type
    unsubscribeUrl: string;
  }>;
}
```

**Template Layout:**

```html
<!DOCTYPE html>
<html>
<head>
  <title>Actualizări Bugete - {{emailBatchId}}</title>
</head>
<body>
  <header>
    <h1>Actualizările tale despre bugete</h1>
    <p>Ai primit {{notifications.length}} notificări</p>
  </header>

  {{#each notifications}}
  <section class="notification-section">
    {{#if (eq type 'newsletter_entity_monthly')}}
      {{> newsletter-entity-monthly-section this}}
    {{/if}}

    {{#if (eq type 'newsletter_entity_quarterly')}}
      {{> newsletter-entity-quarterly-section this}}
    {{/if}}

    {{#if (eq type 'newsletter_entity_annual')}}
      {{> newsletter-entity-annual-section this}}
    {{/if}}

    {{#if (eq type 'alert_data_series')}}
      {{> alert-data-series-section this}}
    {{/if}}

    <footer class="notification-footer">
      <a href="{{unsubscribeUrl}}">Dezabonează-te de la această notificare</a>
    </footer>
  </section>
  {{/each}}

  <footer class="email-footer">
    <p>Batch ID: {{emailBatchId}}</p>
    <a href="{{process.env.PUBLIC_URL}}/settings/notifications">
      Gestionează toate notificările
    </a>
  </footer>
</body>
</html>
```

**Template Partials:**

```
templates/emails/
├── consolidated-newsletter.html           # Main template
├── partials/
│   ├── newsletter-entity-monthly-section.html
│   ├── newsletter-entity-quarterly-section.html
│   ├── newsletter-entity-annual-section.html
│   └── alert-data-series-section.html
```

**Example Rendered Email:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Actualizările tale despre bugete
Ai primit 3 notificări
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────┐
│ 📅 Raport Lunar - Primăria Cluj     │
│ Ianuarie 2025                        │
├─────────────────────────────────────┤
│ Venituri: 15.2M RON (+12% vs Dec)  │
│ Cheltuieli: 14.8M RON (+8% vs Dec) │
│ Balanță: +400K RON                  │
│                                      │
│ [Vezi detalii complete]             │
│ [Dezabonează-te]                    │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 📈 Raport Trimestrial - UAT Brașov │
│ Trimestrul 4, 2024                   │
├─────────────────────────────────────┤
│ Venituri: 45M RON                   │
│ Cheltuieli: 43M RON                 │
│ Balanță: +2M RON                    │
│                                      │
│ [Vezi detalii complete]             │
│ [Dezabonează-te]                    │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 🚨 Alertă - Județ Cluj              │
│ Cheltuieli depășesc pragul          │
├─────────────────────────────────────┤
│ Prag: 100M RON                      │
│ Actual: 102.5M RON (+2.5%)          │
│ Perioada: Ianuarie 2025             │
│                                      │
│ [Vezi detalii]                      │
│ [Dezabonează-te]                    │
└─────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Batch ID: abc-def-123-456
[Gestionează toate notificările]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Repository Layer

### NotificationRepository

```typescript
export const notificationRepository = {
  getActiveByType(notificationType: NotificationType): Promise<Notification[]>;
  getByUserId(userId: string): Promise<Notification[]>;
  getByUserAndEntity(userId: string, entityCui: string): Promise<Notification[]>;
  getByHash(hash: string): Promise<Notification | null>;
  create(data: NotificationData): Promise<Notification>;
  update(id: number, data: Partial<NotificationData>): Promise<Notification>;
  deactivate(id: number): Promise<void>;
  deactivateAllForUser(userId: string): Promise<void>;
};
```

### DeliveryRepository

```typescript
export const deliveryRepository = {
  wasAlreadySent(deliveryKey: string): Promise<boolean>;
  create(data: DeliveryData, client?: PoolClient): Promise<NotificationDelivery>;
  getDeliveryHistory(userId: string, limit?: number): Promise<NotificationDelivery[]>;
  getDeliveryHistoryForNotification(notificationId: number, limit?: number): Promise<NotificationDelivery[]>;
};
```

### UnsubscribeTokenRepository

```typescript
export const unsubscribeTokenRepository = {
  create(data: TokenData, client?: PoolClient): Promise<UnsubscribeToken>;
  getByToken(token: string): Promise<UnsubscribeToken | null>;
  markUsed(token: string): Promise<void>;
  cleanupExpired(): Promise<number>;
};
```

---

## Edge Cases & Handling

### Missing Data

- **Issue:** Entity has no data for period
- **Solution:** Skip, log, no DB record

### No Email Address

- **Issue:** User has no email in Clerk
- **Solution:** Skip, log, no DB record

### Concurrent Job Runs

- **Issue:** Script run twice simultaneously
- **Solution:** First process acquires lock via unique constraint; second gets constraint violation and skips

### Email Provider Failure

- **Issue:** Email send fails
- **Solution:** Transaction rolls back, no DB record created, can retry later

### Network Timeout

- **Issue:** Email send times out
- **Solution:** Transaction rolls back, no DB record, retry on next run

### Partial Batch Failure

- **Issue:** Some emails in batch fail
- **Solution:** Each notification is independent; failures don't affect successes

---

## Security Considerations

### Email Access

- Never store emails
- Fetch from Clerk only during send
- Admin token in memory only
- Token destroyed after script completes

### Unsubscribe Tokens

- Cryptographically secure (SHA-256)
- 1-year expiration
- Single-use
- Scoped to specific notification

### API Authentication

- All notification endpoints require Clerk auth
- User can only manage own notifications
- Unsubscribe endpoints public but token-gated

### SQL Injection

- All queries use parameterized statements
- No raw SQL from user input

## Environment Variables

```bash
# Clerk
CLERK_SECRET_KEY_ADMIN=sk_...

# Email Service
EMAIL_SERVICE_PROVIDER=sendgrid
EMAIL_SERVICE_API_KEY=...
EMAIL_FROM_ADDRESS=notifications@example.com
EMAIL_FROM_NAME=Budget Transparency Platform
EMAIL_REPLY_TO=support@example.com

# Newsletter Script
NEWSLETTER_BATCH_SIZE=50
NEWSLETTER_RATE_LIMIT_MS=1000

# URLs
PUBLIC_URL=https://example.com
```

---

## Package Dependencies

```json
{
  "dependencies": {
    "@clerk/backend": "^2.9.3",
    "nodemailer": "^6.9.0",
    "handlebars": "^4.7.8"
  },
  "scripts": {
    "newsletter": "ts-node src/scripts/send-newsletters.ts"
  }
}
```

---

## Appendix

### Transaction-Based Architecture Benefits

1. **Simplicity**: No status field, no state machine
2. **Reliability**: All-or-nothing guarantees
3. **Idempotency**: Re-run script safely anytime
4. **Concurrency**: Database enforces uniqueness
5. **Clean Audit**: Only successful sends recorded
6. **No Retries Needed**: Failed sends simply don't create records; re-run script to retry

### Database Size Estimates

Assuming 10,000 active users with 5 notifications each:

| Table | Rows | Storage |
|-------|------|---------|
| Notifications | 50,000 | ~5 MB |
| NotificationDeliveries | 600,000/year | ~100 MB/year |
| UnsubscribeTokens | 50,000 | ~5 MB |

**Total:** ~110 MB/year

### Performance Considerations

- Batch size: 50 emails with 1-second delay = ~180 emails/minute
- 50,000 notifications = ~4.6 hours to send all
- Indexes ensure sub-millisecond deduplication checks
- Transactions add negligible overhead (~1-2ms per send)

---

**End of Specification**
