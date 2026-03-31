# Global Unsubscribe and One-Click Email Unsubscribe

**Status**: Accepted
**Date**: 2026-03-30
**Author**: Claude

## Problem

The notification system had two gaps:

1. **No global email opt-out.** Users could only unsubscribe from individual notification subscriptions (newsletters, alerts). There was no way to suppress all email delivery for a user at once. CAN-SPAM and GDPR require a mechanism for users to stop all commercial email with a single action.

2. **Welcome emails had no one-click unsubscribe.** The compose worker set `unsubscribeUrl` to the preferences page URL for welcome emails, and stored `unsubscribeToken: null` on the outbox row. This meant:
   - The HTML body footer link pointed to the preferences page, not a token-based unsubscribe endpoint.
   - The `List-Unsubscribe` email header also fell back to the preferences page URL.
   - RFC 8058 one-click unsubscribe did not work for welcome emails.

## Context

- The existing `UnsubscribeTokens` table stores opaque UUID tokens, each referencing a single `notification_id` in the `Notifications` table. The token-based unsubscribe endpoint (`POST /api/v1/notifications/unsubscribe/:token`) sets `is_active: false` on the referenced notification row.
- Newsletter and alert emails already had working per-notification tokens and one-click unsubscribe.
- The `DeliveryStatus` enum already included `'skipped_unsubscribed'` but no code path ever set it.
- All email templates share a single `EmailLayout` component that renders the unsubscribe link in the footer.
- The email client already sets `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers from the `unsubscribeUrl` parameter.

## Decision

### Global unsubscribe as a notification row

Reuse the existing `Notifications` table with a new notification type `'global_unsubscribe'`. One row per user, no entity, optional JSONB config for channel preferences.

**Row schema:**

| Column              | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `notification_type` | `'global_unsubscribe'`                                                   |
| `entity_cui`        | `NULL`                                                                   |
| `is_active`         | `true` = receiving emails (default), `false` = all email suppressed      |
| `config`            | `{ "channels": { "email": true }, "reason": "...", "updatedAt": "..." }` |

**isActive semantics** follow the same convention as other notification types: `is_active: true` means the user is subscribed (receiving emails). The existing `unsubscribeViaToken` use case already sets `is_active: false`, which naturally means "unsubscribed" for this row too.

**Two levels of suppression:**

1. `is_active = false` -- master kill switch, suppresses ALL email delivery.
2. `config.channels.email = false` -- fine-grained, suppresses email only (future-proofs for push/SMS channels).

### Row creation

Created lazily on-demand by the compose worker when composing a welcome email (`getOrCreateGlobalUnsubscribeRow`). No backfill migration needed. Race conditions are handled by catching unique constraint violations and retrying the find.

### Welcome email fix

The compose worker now:

1. Calls `getOrCreateGlobalUnsubscribeRow(userId)` to get or create the global row.
2. Calls `getOrCreateActive(userId, globalRow.id)` to get a token pointing to the global row.
3. Passes the token URL (`/api/v1/notifications/unsubscribe/{token}`) as `unsubscribeUrl` to the template.
4. Stores the token on the outbox row for the send worker to use in `List-Unsubscribe` headers.

### Send-worker guard

Before every email send, the send worker calls `isUserGloballyUnsubscribed(userId)`. If the user is globally unsubscribed, the delivery is marked as `skipped_unsubscribed` and no email is sent.

```
Trigger -> Collect -> Compose -> Send
                                  |
                      [global unsubscribe check]
                                  |
                      skipped_unsubscribed OR proceed
```

### Config JSONB shape

```json
{
  "channels": { "email": true },
  "reason": "one_click",
  "updatedAt": "2026-03-30T12:00:00Z"
}
```

The `channels` map enables future per-channel preferences without schema changes. The `reason` and `updatedAt` fields support analytics and support workflows.

## Alternatives Considered

### Separate user preferences table

A dedicated `UserEmailPreferences` table with columns like `email_opt_out BOOLEAN`. Rejected because:

- Requires a new table, migration, and separate repository.
- The `Notifications` table already supports the exact shape needed (per-user rows with type, active flag, and JSONB config).
- The unsubscribe token mechanism already references `notification_id`, so reusing the notifications table means the existing token flow works without modification.

### Inverted isActive semantics

`is_active: true` on the global row meaning "user IS globally unsubscribed" (the preference is active). Rejected because:

- The existing `unsubscribeViaToken` use case sets `is_active: false` unconditionally. With inverted semantics, clicking unsubscribe on the global row would set `is_active: false`, which would mean "not unsubscribed" -- the opposite of the intended action.
- Maintaining consistent semantics across all notification types is simpler to reason about.

### JWT-signed tokens instead of database-backed tokens

Stateless tokens with expiry encoded in the signature. Rejected because:

- Cannot be revoked after issuance.
- Cannot be marked as "used" to prevent replay.
- The existing `UnsubscribeTokens` table and flow work well and support audit trails.

### Exposing global_unsubscribe in the subscribe API

Adding `'global_unsubscribe'` to the `SubscribeBodySchema` so users can create the row via `POST /api/v1/notifications`. Rejected because:

- The row should be system-managed (created lazily by the compose worker).
- Users manage it via `PATCH /api/v1/notifications/:id` once it exists.
- Prevents users from creating arbitrary global unsubscribe rows via the API.

## Consequences

**Positive**

- Welcome emails now have RFC 8058 compliant one-click unsubscribe.
- Users can opt out of all emails with a single click.
- No new database table or migration required.
- The existing token and endpoint infrastructure is fully reused.
- `skipped_unsubscribed` delivery status is now actually used, enabling audit and analytics.
- Channel preferences JSONB future-proofs for push/SMS without schema changes.

**Negative**

- The `global_unsubscribe` row appears in `GET /api/v1/notifications` responses. Frontend needs to handle or filter this type.
- The send worker makes one additional database query per email send to check global unsubscribe status. This is a simple indexed lookup and should not impact performance.
- The compose worker for welcome emails now makes two additional queries (get/create global row + get/create token). These are one-time operations per user.

## References

- `src/modules/notifications/core/types.ts` -- `NotificationType` union, `GlobalUnsubscribeConfig`
- `src/modules/notifications/core/validation.ts` -- type guard and validation
- `src/modules/notification-delivery/core/ports.ts` -- `ExtendedNotificationsRepository` interface
- `src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts` -- Kysely implementation
- `src/modules/notification-delivery/shell/queue/workers/compose-worker.ts` -- welcome email compose fix
- `src/modules/notification-delivery/shell/queue/workers/send-worker.ts` -- global unsubscribe check
- `src/modules/notifications/shell/rest/routes.ts` -- `POST /api/v1/notifications/unsubscribe/:token`
- `src/modules/email-templates/shell/templates/email-layout.tsx` -- shared email footer with unsubscribe link
- `src/infra/email/client.ts` -- `List-Unsubscribe` and `List-Unsubscribe-Post` headers
- `docs/specs/specs-202603281430-notification-system-complete.md` -- notification system spec
