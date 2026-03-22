# Simplified Generic Email Store and Institution Workflow

**Status**: Draft
**Date**: 2026-03-22
**Author**: Codex

## Problem

The current `userdb` email-related storage is specialized around notifications and does not provide a clean generic email store that other product areas can reuse. That makes it awkward to build institution workflows now and future user-facing emails later without copying or adapting notification-specific delivery tables.

For institution outreach specifically, the platform also lacks a small business table that tracks one institution thread with ownership, request type, subject, and workflow status. Without that split, business workflow and raw provider data would end up mixed together.

## Context

This iteration intentionally keeps the model small:

- institution workflow lives in its own table
- raw provider data is stored in one generic Resend-backed table
- the generic table should follow the official `resend_wh_emails` schema as closely as possible
- the only app-specific addition to the generic email table is `thread_key`
- the institution table references emails by `thread_key`, not by direct foreign keys to provider rows

The current notification-delivery tables remain in the schema as legacy specialized storage. They should not be treated as the template for this new design.

## Decision

Adopt a two-table design:

### 1. `InstitutionEmailThreads`

This is the business workflow table for institution outreach. It stores:

- `entity_cui`
- nullable ownership via `owner_user_id`
- optional grouping via `campaign_ref`
- free-text `request_type`
- stable `thread_key`
- user-facing `subject`
- small workflow status set
- timestamps for latest email, latest reply, and closure
- generic metadata

The status set stays intentionally small:

- `draft`
- `waiting_reply`
- `replied`
- `closed`
- `failed`

### 2. `resend_wh_emails`

This is the generic shared email store. It follows the official Resend webhook ingester schema for email events and adds only:

- `thread_key TEXT NULL`

`thread_key` is extracted from outbound tags or inbound processing so institution workflow can fetch all related provider rows through one app-owned key.

This table stores provider payload history only. It does not own workflow state.

## Alternatives Considered

### 1. Reuse the notification-delivery model

Rejected because:

- it is specialized for notification subscriptions and periodic deliveries
- it introduces delivery-specific concepts that are not a clean base for generic email storage
- it would keep pushing new features toward notification-shaped tables

### 2. Keep the previous three-table institution correspondence design

Rejected because:

- it added an app-owned message table too early
- it overfit the institution use case instead of creating a reusable email base
- it increased schema surface without clear immediate value

### 3. Point institution workflow directly at provider rows by foreign key

Rejected because:

- raw provider rows are event-shaped, not business-shaped
- one provider email can produce multiple rows over time
- the institution workflow only needs a stable thread key, not direct provider-row ownership

## Consequences

**Positive**

- The platform gets one clean generic Resend-backed email store for future reuse.
- Institution workflow remains simple and business-oriented.
- The schema stays small while preserving a stable join key through `thread_key`.
- Multiple provider events for the same `email_id` remain valid without complicating business data.

**Negative**

- Workflow still depends on application logic to tag and extract `thread_key`.
- The generic table is provider-shaped, so richer app-level email modeling may still be added later if needed.
- Notification-specific legacy tables remain alongside the new generic email table until they are revisited separately.

## References

- `src/infra/database/user/schema.sql`
- `src/infra/database/user/types.ts`
- `src/infra/email/client.ts`
- <https://resend.com/docs/webhooks/ingester>
- <https://github.com/resend/resend-webhooks-ingester/blob/main/schemas/postgresql.sql>
