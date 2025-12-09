# Notifications Module Specification

## Purpose

The notifications module enables users to stay informed about public budget data they care about. Instead of manually checking for updates, users subscribe to notifications and receive updates when relevant data changes.

There are two notification categories:

1. **Entity Newsletters** — Periodic summaries of a public institution's budget execution
2. **Series Alerts** — Threshold-based alerts on custom data queries

---

## Entity Newsletters

### Concept

Users can subscribe to any public institution (entity) and receive periodic budget execution summaries. This is useful for citizens, journalists, or analysts who want to track specific institutions without manually checking the platform.

### Subscription Frequencies

| Frequency | Use Case                                          |
| --------- | ------------------------------------------------- |
| Monthly   | Track institutions with frequent budget activity  |
| Quarterly | Balance between detail and notification frequency |
| Yearly    | High-level annual budget overview                 |

### What Users Receive

Each newsletter summarizes the entity's budget execution for the period:

- Total income and expenses
- Budget balance (surplus/deficit)
- Comparison with previous period
- Year-over-year comparison
- Top spending categories
- Spending trend

### Subscription Rules

- A user can subscribe to multiple entities
- A user can have different frequencies for different entities
- A user can have multiple frequencies for the same entity (e.g., monthly AND yearly)
- Each unique combination of (user, entity, frequency) creates one subscription
- **One subscription per user/entity/frequency** — subscribing again reactivates the existing subscription

---

## Series Alerts

### Concept

Series alerts allow advanced users to monitor specific data patterns. Users define a custom analytics query and optionally set threshold conditions. When the data meets those conditions, the user receives a notification.

### Use Cases

- **Budget Monitoring** — Get notified when a ministry's spending exceeds a threshold
- **Comparative Analysis** — Track when a county's per-capita spending changes significantly
- **Category Tracking** — Monitor specific functional categories (education, healthcare) across entities

### Alert Types

| Type            | Data Source                          | Example                                                               |
| --------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Analytics Alert | Dynamic query using platform filters | "Notify me when Bucharest's transportation spending exceeds 100M RON" |
| Static Alert    | Pre-defined dataset series           | "Notify me when CPI inflation index changes"                          |

### Threshold Conditions

Users can define conditions that determine when an alert triggers:

| Operator | Meaning               |
| -------- | --------------------- |
| `gt`     | Greater than          |
| `gte`    | Greater than or equal |
| `lt`     | Less than             |
| `lte`    | Less than or equal    |
| `eq`     | Equal to              |

Each condition specifies:

- **Operator** — The comparison type
- **Threshold** — Must be a finite number
- **Unit** — Required, non-empty string (e.g., "RON", "EUR", "% of GDP")

### Alert Configuration

**Analytics Alert** requires:

- `filter` — Analytics filter defining the data query (required)
- `title` — Optional display name (max 200 chars)
- `description` — Optional description (max 1000 chars)
- `conditions` — Array of threshold conditions (can be empty)

**Static Alert** requires:

- `datasetId` — ID of the static dataset to monitor (required)
- `title` — Optional display name
- `description` — Optional description
- `conditions` — Array of threshold conditions (can be empty)

### Alert Behavior

- Alerts without conditions send informational updates on data changes
- Alerts with conditions only trigger when **all** conditions are met
- Users can create multiple alerts with different configurations

---

## Subscription Lifecycle

### Creating Subscriptions

The creation behavior differs between newsletters and alerts:

**For Entity Newsletters:**

1. Look for existing subscription by (user, type, entity)
2. If found (active or inactive) → reactivate it and return
3. If not found → create new subscription

**For Series Alerts:**

1. Generate hash from (user, type, entity, config)
2. If hash exists → return the existing subscription (no error)
3. If hash doesn't exist → create new subscription

This means:

- Newsletter subscriptions are unique per (user, entity, frequency) — config is ignored
- Alert subscriptions are unique per (user, config) — same config = same subscription

### Subscription Identity (Hash)

The uniqueness hash is SHA-256 of:

```
{userId}:{notificationType}:{entityCui || ''}:{sortedJsonConfig || ''}
```

JSON keys are sorted alphabetically before hashing to ensure consistent comparison regardless of key order.

### Subscription States

| State    | Behavior                                   |
| -------- | ------------------------------------------ |
| Active   | User receives notifications                |
| Inactive | Subscription paused, no notifications sent |

Users can toggle states without losing their configuration.

### Updating Subscriptions

When config is updated:

1. Validate config against notification type
2. Recalculate hash with new config
3. Update hash if it changed
4. Update `updatedAt` timestamp

### Deletion Options

- **Soft delete** — Set `isActive` to false (reversible)
- **Hard delete** — Permanently remove subscription and cascade delete:
  1. Delete all delivery records for this subscription
  2. Delete all unsubscribe tokens for this subscription
  3. Delete the subscription itself

---

## Unsubscribe Flow

### Token-Based Unsubscribe

Every notification email includes a unique unsubscribe link, allowing one-click unsubscribe without authentication.

**Token Properties**:

- 64-character random hex string (32 bytes)
- Valid for 1 year from creation
- Single-use only
- Tied to a specific subscription

**Unsubscribe Process**:

1. User clicks unsubscribe link in email
2. System validates token exists, is not expired, and is unused
3. System marks token as used (`used_at` timestamp)
4. System deactivates the subscription (`isActive = false`)
5. User sees confirmation message

---

## Delivery Tracking

The system tracks every notification sent:

- Which subscription triggered it
- When it was sent
- Which period it covered
- Batch ID for grouping multiple notifications sent together
- Delivery key for duplicate prevention

### Period Keys

Notifications cover the **previous** period, not the current one:

| Notification Type | Period Covered   | Example (if today is Feb 15, 2024) |
| ----------------- | ---------------- | ---------------------------------- |
| Monthly           | Previous month   | `2024-01` (January 2024)           |
| Quarterly         | Previous quarter | `2023-Q4` (Q4 2023)                |
| Yearly            | Previous year    | `2023`                             |

**Alert period keys**: Both analytics and static alerts use monthly period keys.

### Delivery Key

Format: `{userId}:{notificationId}:{periodKey}`

Used to prevent sending the same notification twice for the same period.

---

## REST API

### Endpoints

| Action                    | Endpoint                                       | Auth     |
| ------------------------- | ---------------------------------------------- | -------- |
| Create subscription       | `POST /api/v1/notifications`                   | Required |
| List all subscriptions    | `GET /api/v1/notifications`                    | Required |
| List entity subscriptions | `GET /api/v1/notifications/entity/:cui`        | Required |
| Update subscription       | `PATCH /api/v1/notifications/:id`              | Required |
| Delete subscription       | `DELETE /api/v1/notifications/:id`             | Required |
| List delivery history     | `GET /api/v1/notifications/deliveries`         | Required |
| Unsubscribe via token     | `GET /api/v1/notifications/unsubscribe/:token` | None     |

### Response Format

Success:

```json
{ "ok": true, "data": <result> }
```

Error:

```json
{ "ok": false, "error": "<ErrorType>", "message": "<error description>" }
```

Where `error` is a machine-readable error code (e.g., `EntityRequired`, `InvalidConfig`) and `message` is a human-readable description.

### Creating Subscriptions

**Entity Newsletter:**

```json
{
  "notificationType": "newsletter_entity_monthly",
  "entityCui": "4267117"
}
```

**Analytics Alert:**

```json
{
  "notificationType": "alert_series_analytics",
  "entityCui": null,
  "config": {
    "title": "Bucharest Transportation Budget",
    "description": "Alert when spending exceeds threshold",
    "conditions": [{ "operator": "gt", "threshold": 100000000, "unit": "RON" }],
    "filter": {
      "account_category": "ch",
      "county_codes": ["B"],
      "functional_prefixes": ["84"],
      "report_period": {
        "type": "YEAR",
        "selection": { "interval": { "start": "2020", "end": "2024" } }
      }
    }
  }
}
```

**Static Alert:**

```json
{
  "notificationType": "alert_series_static",
  "entityCui": null,
  "config": {
    "title": "CPI Inflation Monitor",
    "conditions": [],
    "datasetId": "ro.economics.cpi.yearly"
  }
}
```

### Listing Subscriptions

**GET /api/v1/notifications** — Returns **all** user subscriptions (active and inactive)

**GET /api/v1/notifications/entity/:cui** — Returns user's subscriptions for the specified entity

### Updating Subscriptions

```json
{
  "isActive": true,
  "config": { ... }
}
```

- `isActive` — Enable/disable notifications
- `config` — Modify alert parameters (validated against notification type)

For newsletter types, setting `config` will set it to `null`.

### Delivery History

**GET /api/v1/notifications/deliveries**

Query parameters:

- `limit` — Number of records (default: 50)
- `offset` — Pagination offset (default: 0)

### Validation Rules

| Notification Type             | Entity Required | Config Required        |
| ----------------------------- | --------------- | ---------------------- |
| `newsletter_entity_monthly`   | Yes             | No                     |
| `newsletter_entity_quarterly` | Yes             | No                     |
| `newsletter_entity_yearly`    | Yes             | No                     |
| `alert_series_analytics`      | No              | Yes (with `filter`)    |
| `alert_series_static`         | No              | Yes (with `datasetId`) |

**Condition Validation:**

- `unit` — Required, non-empty string
- `threshold` — Required, must be a finite number

---

## Error Handling

| Scenario                       | HTTP Status | Error Code             |
| ------------------------------ | ----------- | ---------------------- |
| Subscription not found         | 404         | `NotificationNotFound` |
| User doesn't own subscription  | 403         | `Forbidden`            |
| Invalid configuration          | 400         | `InvalidConfig`        |
| Newsletter missing entity      | 400         | `EntityRequired`       |
| Alert missing required field   | 400         | `MissingConfig`        |
| Condition threshold not finite | 400         | `InvalidThreshold`     |
| Condition unit empty           | 400         | `MissingUnit`          |
| Unsubscribe token not found    | 404         | `TokenNotFound`        |
| Token expired or already used  | 400         | `InvalidToken`         |

---

## Data Model

### Notification

| Field              | Type           | Description                           |
| ------------------ | -------------- | ------------------------------------- |
| `id`               | UUID           | Unique identifier                     |
| `userId`           | string         | Subscription owner (from auth)        |
| `entityCui`        | string \| null | Entity fiscal code (newsletters only) |
| `notificationType` | string         | Type of notification                  |
| `isActive`         | boolean        | Whether notifications are sent        |
| `config`           | object \| null | Alert configuration (alerts only)     |
| `hash`             | string         | SHA-256 uniqueness hash               |
| `createdAt`        | timestamp      | Creation time                         |
| `updatedAt`        | timestamp      | Last modification time                |

### Notification Delivery

| Field            | Type      | Description                         |
| ---------------- | --------- | ----------------------------------- |
| `id`             | bigint    | Unique identifier                   |
| `userId`         | string    | Recipient                           |
| `notificationId` | UUID      | Source subscription                 |
| `periodKey`      | string    | Period covered (e.g., "2024-01")    |
| `deliveryKey`    | string    | Unique key for duplicate prevention |
| `emailBatchId`   | UUID      | Groups deliveries sent together     |
| `sentAt`         | timestamp | When notification was sent          |
| `metadata`       | jsonb     | Additional delivery metadata        |
| `createdAt`      | timestamp | Record creation time                |

### Unsubscribe Token

| Field            | Type              | Description                    |
| ---------------- | ----------------- | ------------------------------ |
| `token`          | string            | 64-character hex string (PK)   |
| `userId`         | string            | Token owner                    |
| `notificationId` | UUID              | Subscription to deactivate     |
| `createdAt`      | timestamp         | Token creation time            |
| `expiresAt`      | timestamp         | Expiration (creation + 1 year) |
| `usedAt`         | timestamp \| null | When used (null if unused)     |

---

## Implementation Notes

### Module Location

`src/modules/notifications/`

### Database

Uses the user database (`userDb`). Tables: `Notifications`, `NotificationDeliveries`, `UnsubscribeTokens`.

### Authentication

All endpoints except token-based unsubscribe require authentication via the auth module.

### Null-Safe Entity Comparison

When querying by entity, use `IS NOT DISTINCT FROM` for proper null handling:

```sql
WHERE entity_cui IS NOT DISTINCT FROM $1
```

---

## Out of Scope

- Email delivery and templates
- Scheduled batch processing
- Alert condition evaluation
- Delivery record creation (handled by email service)
- Token generation (handled by email service)
