# Newsletter & Alerts Implementation

## Overview

This document provides a quick reference for the implemented newsletter and alerts subscription system. For full technical specification, see [NEWSLETTER_SPEC.md](./NEWSLETTER_SPEC.md).

## Implementation Structure

### Database Schema
- **Notifications**: User subscription preferences with hash-based uniqueness
- **NotificationDeliveries**: Success-only audit trail with batch ID tracking
- **UnsubscribeTokens**: Token management for email unsubscribe links

Location: [`src/db/schema-userdata.sql`](../src/db/schema-userdata.sql)

### Core Services

#### Type System
[`src/services/notifications/types.ts`](../src/services/notifications/types.ts)
- Notification type definitions
- Configuration interfaces
- Hash and key generation utilities

#### Repository Layer
- [`src/db/repositories/notificationsRepository.ts`](../src/db/repositories/notificationsRepository.ts) - Subscription CRUD
- [`src/db/repositories/notificationDeliveriesRepository.ts`](../src/db/repositories/notificationDeliveriesRepository.ts) - Delivery tracking
- [`src/db/repositories/unsubscribeTokensRepository.ts`](../src/db/repositories/unsubscribeTokensRepository.ts) - Token management

#### Service Layer
- [`src/services/notifications/notificationService.ts`](../src/services/notifications/notificationService.ts) - Business logic
- [`src/services/notifications/emailService.ts`](../src/services/notifications/emailService.ts) - Email sending with batching

### API Endpoints
[`src/routes/notifications.ts`](../src/routes/notifications.ts)

- `POST /api/v1/notifications/subscribe` - Subscribe to notifications
- `POST /api/v1/notifications/:id/unsubscribe` - Unsubscribe (requires auth)
- `GET /api/v1/notifications` - Get user's notifications
- `GET /api/v1/notifications/entity/:cui` - Get entity-specific notifications
- `PATCH /api/v1/notifications/:id/config` - Update notification config
- `GET /api/v1/notifications/deliveries` - Get delivery history
- `GET /api/v1/notifications/unsubscribe/:token` - Unsubscribe via email link (no auth)

### Send Script
[`scripts/send-newsletters.ts`](../scripts/send-newsletters.ts)

Manual CLI script for sending batched notifications.

**Usage:**
```bash
# Send monthly newsletters
yarn newsletters:send --type newsletter_entity_monthly --clerk-token <token>

# Send to specific user (testing)
yarn newsletters:send --type newsletter_entity_yearly --clerk-token <token> --user <user_id>

# Dry run (no actual sending)
yarn newsletters:send --type alert_data_series --clerk-token <token> --dry-run

# Use specific date for period calculation
yarn newsletters:send --type newsletter_entity_monthly --clerk-token <token> --date 2025-01-01
```

### Email Templates
- [`src/templates/email/consolidated-notification.hbs`](../src/templates/email/consolidated-notification.hbs) - Main template
- [`src/templates/email/partials/entityNewsletter.hbs`](../src/templates/email/partials/entityNewsletter.hbs) - Newsletter section
- [`src/templates/email/partials/alertNotification.hbs`](../src/templates/email/partials/alertNotification.hbs) - Alert section

## Key Features

### Transaction-Based Sending
All delivery records and email sending happen in a single database transaction. If email sending fails, all records are rolled back automatically.

### Batched Emails
Multiple notifications for the same user are combined into a single consolidated email with an `email_batch_id` UUID.

### Deduplication
- Hash-based uniqueness prevents duplicate subscriptions
- Delivery key checking prevents duplicate sends
- Safe to re-run scripts multiple times

### Success-Only Audit Trail
Only successfully delivered notifications are recorded. No status field - presence in `NotificationDeliveries` means success.

## Next Steps

1. **Implement data fetching logic** in `scripts/send-newsletters.ts` (currently placeholder)
2. **Integrate email provider** (SendGrid, AWS SES, etc.) in `emailService.ts`
3. **Set up Handlebars rendering** for email templates
4. **Configure scheduled execution** (cron, scheduled job, etc.)
5. **Add frontend integration** for entity page subscriptions

## Testing

```bash
# Type check
yarn typecheck

# Dry run with test user
yarn newsletters:send --type newsletter_entity_monthly --clerk-token <token> --user <test_user_id> --dry-run
```
