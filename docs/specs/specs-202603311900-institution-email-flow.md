# Institution Email Flow — Design

**Status**: Draft
**Date**: 2026-03-31

## Overview

The system sends public debate request emails to institutions on behalf of users, and captures emails sent by third-party NGOs who CC our system address. Each institution receives at most one platform-sent email per campaign. Multiple users can subscribe to follow the same institution's correspondence thread.

## Design Principles

- **One email per institution from our system.** We send at most one public debate request to a given institution. If another user requests the same institution, we subscribe them to the existing thread instead of sending a duplicate.
- **Third-party NGOs can also send.** When another association sends the email themselves and CCs our system email, we capture that as a separate `self_send_cc` thread in the institution correspondence table.
- **Non-blocking submission.** The user interaction endpoint stores the payload and returns immediately. Processing happens asynchronously via a BullMQ queue.

## Correspondence Thread Model

Each institution correspondence is stored as a row in `InstitutionEmailThreads` with a JSONB `record` aggregate containing the full thread history (correspondence entries, review state, metadata).

Two triggers for starting a thread:

- **Platform send (`request_platform`):** Our system sends the email to the institution.
- **Self-send CC (`self_send_cc`):** A third-party association sends the email and uses our system email as CC. We capture the inbound email and create a thread.

After the thread is started, we capture follow-ups (institution replies) via Resend webhooks and append them to the thread. An admin API allows reviewing institution replies and updating thread state.

## Email Sending Flow (request_platform)

Triggered when a user submits a public debate request via `PUT /api/v1/learning/progress` with `submissionPath: 'request_platform'`:

1. **User interaction stored.** The endpoint persists the interaction record in `pending` phase and publishes an event to the BullMQ `user-events` queue.
2. **Handler picks up the event.** The `public-debate-request` handler re-reads the record from the DB, checks eligibility (campaign, entity-scoped, pending phase).
3. **Email validation.** The handler compares the user-submitted institution email (`primariaEmail`) against the entity's `official_email` from the entity profile:
   - **Format invalid** -> reject the interaction (`failed` phase, `rejected` review).
   - **Match** -> proceed to send.
   - **Mismatch** -> flag the interaction for manual review (stays in `pending` phase, review metadata set with mismatch reason). A future admin action (out of scope) can approve held mismatches and trigger the send.
4. **Idempotency check.** Before sending, the system checks for an existing non-failed thread for that entity+campaign. If found, subscribes the user to notifications and approves the interaction without sending a duplicate email. A DB partial unique index enforces this at the database level as well.
5. **Send email.** Creates a thread (phase `sending`), renders the template, sends via Resend with an idempotency key, then transitions to `awaiting_reply`. On failure, marks the thread as `failed`.
6. **Approve interaction.** On success, the handler transitions the user interaction to `resolved` (review `approved`).

## Self-Send Capture Flow (send_yourself)

When a user chooses `submissionPath: 'send_yourself'`, the handler validates the prepared subject and NGO sender email, subscribes the user to entity notifications, and returns. The actual email is sent by the user/NGO themselves. When our system email receives the CC, the Resend webhook side-effect matches the inbound email to the entity and creates a `self_send_cc` thread.

## Duplicate Prevention

Three layers prevent duplicate institution emails:

1. **Application check:** `findPlatformSendThreadByEntity` queries for existing non-failed threads before sending.
2. **DB unique index:** Partial unique index on `(entity_cui, campaign_key)` for `platform_send` threads where `phase <> 'failed'`.
3. **Conflict recovery:** If a race condition causes a `CorrespondenceConflictError`, the handler reloads the existing thread and returns without sending.

Additionally, the Resend API call uses `idempotencyKey: thread.id` to prevent duplicate delivery at the provider level.

## User Subscriptions Per Institution

- Users are auto-subscribed to `campaign_public_debate_entity_updates` for the entity when they submit a public debate request (both `request_platform` and `send_yourself`).
- Subscriptions are stored in the `notifications` table, scoped by `(userId, notificationType, entityCui)`.
- On each thread event (started, failed, reply received, reply reviewed), the system queries all active subscribers for that entity and enqueues notification deliveries.
- Users can disable notifications for this campaign via the standard notification preferences.

## Key Files

| Area                  | Files                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Queue pipeline        | `user-events/shell/queue/publisher.ts`, `worker.ts`, `learning-progress-sync-hook.ts`      |
| Handler               | `user-events/shell/handlers/public-debate-request-handler.ts`                              |
| Idempotent send       | `institution-correspondence/core/usecases/request-public-debate-platform-send.ts`          |
| Core send             | `institution-correspondence/core/usecases/send-platform-request.ts`                        |
| Thread repo           | `institution-correspondence/shell/repo/institution-correspondence-repo.ts`                 |
| Webhook capture       | `institution-correspondence/shell/webhook/resend-side-effect.ts`                           |
| Subscriptions         | `notifications/core/usecases/subscribe-to-public-debate-entity-updates.ts`                 |
| Notification delivery | `notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts` |
| DB idempotency index  | `infra/database/user/migrations/202603311700_harden_public_debate_thread_idempotency.sql`  |
| Wiring                | `app/build-app.ts`                                                                         |

## Related Specs

- `docs/specs/specs-20260325-public-debate-correspondence-v1.md` — Thread data model
- `docs/specs/specs-202603311636-user-events-module.md` — User events queue design
- `docs/specs/specs-202603311900-public-debate-email-flow.md` — Implementation spec for email validation and flag-for-review
