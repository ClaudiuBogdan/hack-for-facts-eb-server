# Public Debate Institution Send Hardening

**Status**: Implemented
**Date**: 2026-04-03
**Author**: Codex

## Problem

The public-debate institution send flow had three operational gaps:

- failed institution sends were notifying end users instead of only the internal audit audience
- provider send success could still fail to produce a user confirmation if the post-send thread transition or notification publish path partially failed
- the confirmation-recovery logic had become harder to reason about because confirmation state, metadata access, and recovery naming were spread across several files

These issues made the flow noisy for users, brittle after provider success, and harder to maintain safely.

## Context

- Institution sends use the `platform_send` correspondence path and persist thread state in `institutionemailthreads`.
- User-facing success notifications still flow through the entity-update notification pipeline and outbox deduplication.
- Provider evidence is available from two places:
  - immediate send success in the request path
  - persisted Resend webhook rows in `resend_wh_emails`
- Recovery must remain idempotent because webhook delivery, queue retries, and reconciliation can all revisit the same thread.

## Decision

Harden the institution send flow in three coordinated steps.

### 1. Admin-only failed-send alerts

- `thread_failed` no longer fans out to entity subscribers.
- Failed institution sends now enqueue an admin-only notification to the configured audit CC recipients.
- A dedicated admin failure email template carries the triage context:
  - entity name and CUI
  - institution email
  - subject
  - failure time
  - thread ID
  - provider error

### 2. Eventual-success confirmation reconciliation

- Successful provider sends are reconciled into thread state through a dedicated correspondence use case.
- Reconciliation:
  - appends the outbound platform-send entry if needed
  - updates the thread to `awaiting_reply`
  - stores provider-send metadata on the thread
  - best-effort publishes `thread_started`
- Webhook success events (`email.sent`, `email.delivered`) can reconcile a thread after the original request path has already partially failed.
- A correspondence recovery runtime periodically revisits platform-send threads whose success confirmation is still pending.
- Recovery can rebuild reconciliation input from stored thread state when webhook evidence is unavailable but the outbound entry and provider metadata already exist.

### 3. Internal cleanup of confirmation state

- Platform-send confirmation metadata now lives behind shared typed helpers instead of raw string-key access.
- The old “stuck in sending” recovery naming was replaced with “pending success confirmation” naming, which matches the actual behavior.
- Reconciliation now returns one explicit `confirmationState` instead of multiple booleans:
  - `not_requested`
  - `already_confirmed`
  - `published_and_marked`
  - `pending_retry`
- Best-effort publish behavior is shared through one helper for both:
  - `thread_started`
  - `thread_failed`

## Consequences

**Positive**

- Users only receive the intended success confirmation for institution sends.
- Failed sends still surface immediately to the internal audit/admin audience.
- Provider success is eventually consistent: a successful institution send can still recover into `awaiting_reply` plus one user confirmation even after partial failures.
- The correspondence code now has clearer naming and one typed source of truth for platform-send confirmation metadata.

**Trade-offs**

- The correspondence module now owns a small recovery runtime in addition to the notification runtime.
- Confirmation state remains internal and thread-metadata-based rather than becoming a first-class DB column.
- The shared runtime tests must mock the correspondence recovery runtime to avoid accidental Redis usage in pure app-factory tests.

## References

- `src/modules/institution-correspondence/core/usecases/send-platform-request.ts`
- `src/modules/institution-correspondence/core/usecases/reconcile-platform-send-success.ts`
- `src/modules/institution-correspondence/core/usecases/recover-platform-send-success-confirmation.ts`
- `src/modules/institution-correspondence/core/usecases/platform-send-success-confirmation.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/modules/institution-correspondence/shell/queue/recovery-runtime.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-admin-failure-notifications.ts`
- `src/modules/email-templates/shell/templates/public-debate-admin-failure.tsx`
- `docs/specs/specs-202603311900-institution-email-flow.md`
