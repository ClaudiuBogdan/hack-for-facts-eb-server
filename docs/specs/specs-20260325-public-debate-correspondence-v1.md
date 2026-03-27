# Public Debate Correspondence V1

**Status**: Draft
**Date**: 2026-03-25
**Author**: Codex

## Problem

The server can capture provider email events, but it still lacks a clean business record for institution correspondence workflows such as the public-debate campaign.

The current draft solves that gap with a normalized thread-plus-message model. That adds schema surface, review-state duplication, and migration overhead before the feature has proven it needs message-level relational storage.

For this campaign, the main business object is the institution thread. We still need strong validation, reply review, self-send capture, and correlation of follow-up emails, but we do not need a complex relational message schema to get them.

## Context

- The immediate user of this storage is the `public_debate` campaign, but the thread shape should remain generic enough to carry a `campaignKey` and support future campaign reuse.
- `resend_wh_emails` remains the standard Resend event-capture table and is not redesigned by this feature.
- Resend `email.received` webhooks still require a follow-up fetch from the Receiving API to obtain the body, headers, and attachments.
- The system still needs both platform-send and self-send capture flows in v1, but they are internal automation/use-case flows rather than public institution HTTP endpoints.
- The budget database now includes `EntityProfiles.official_email`, which can be used as the institution email source of truth when matching inbound mail.
- Validation strength is still required, but it moves to application-level TypeBox schemas and `Value.Check()` on every JSONB read and write.
- PostgreSQL should only enforce the small scalar invariants that matter for identity, deduplication, and review queue lookups.
- The correspondence tables and Resend changes have not been deployed yet, so the SQL can be rewritten to the final v1 shape instead of evolved through compatibility layers.

## Decision

Adopt a generic thread-centered JSONB model with two storage roles:

### 1. `InstitutionEmailThreads`

This is the correspondence business table. It stores one authoritative thread per institution request.

The table keeps only the scalar columns needed for identity and queries:

- `id`
- `entity_cui`
- `campaign_key`
- `thread_key`
- `phase`
- `last_email_at`
- `last_reply_at`
- `next_action_at`
- `closed_at`
- `record JSONB`
- `created_at`
- `updated_at`

`thread_key` is the authoritative generated request key. It is embedded in the controlled subject line and mirrored in the thread record so inbound messages can be correlated without a tokenized alias.

`phase` remains the operational queue field. Valid phase values are enforced in application code, not by DB checks, so campaigns can evolve without SQL churn.

The current public-debate implementation uses these operational phases:

- `sending`
- `awaiting_reply`
- `reply_received_unreviewed`
- `manual_follow_up_needed`
- `resolved_positive`
- `resolved_negative`
- `closed_no_response`
- `failed`

`record JSONB` is the validated thread aggregate. V1 uses this contract:

- `version: 1`
- `campaign: string`
- `campaignKey: string | null`
- `ownerUserId: string | null`
- `subject: string`
- `submissionPath: string`
- `institutionEmail: string`
- `ngoIdentity: string`
- `requesterOrganizationName: string | null`
- `budgetPublicationDate: string | null`
- `consentCapturedAt: string | null`
- `contestationDeadlineAt: string | null`
- `captureAddress: string | null`
- `correspondence: CorrespondenceEntry[]`
- `latestReview: ThreadReview | null`
- `metadata: Record<string, unknown>`

`captureAddress` now refers to the fixed shared correspondence mailbox used for self-send capture and reply handling, not to a tokenized per-thread alias.

`CorrespondenceEntry` is a validated snapshot object stored inside `record.correspondence`:

- `id`
- `campaignKey`
- `direction`
- `source`
- `resendEmailId`
- `messageId`
- `fromAddress`
- `toAddresses`
- `ccAddresses`
- `bccAddresses`
- `subject`
- `textBody`
- `htmlBody`
- `headers`
- `attachments`
- `occurredAt`
- `metadata`

For inbound entries, `metadata.rawMessage` stores the full fetched raw message snapshot returned by the receiving flow when the inbound email is successfully matched to a thread.

`ThreadReview` is a thread-level review object stored in `record.latestReview`:

- `basedOnEntryId`
- `resolutionCode`
- `notes`
- `reviewedAt`

`resolutionCode` keeps the existing v1 set:

- `debate_announced`
- `already_scheduled`
- `request_refused`
- `wrong_contact`
- `auto_reply`
- `not_actionable`
- `other`

Operational rules:

- Multiple threads per entity and campaign are allowed. Deduplication is an application concern, not a database uniqueness rule.
- The review queue is thread-based, not message-based.
- Multiple inbound emails before review are preserved in `record.correspondence`, but they still produce one pending thread decision.
- Manual review updates the thread phase and stores the latest review snapshot in the aggregate.
- Message history is append-only within the aggregate, even if the thread is reviewed later.
- Inbound matching uses headers first (`In-Reply-To` / `References`) through known message IDs.
- If headers do not match, inbound matching falls back to extracting the controlled `thread_key` from the subject.
- If a thread with that `thread_key` exists, the inbound email is attached to it.
- If no thread exists yet, self-send capture can create the thread using the `thread_key` from the subject plus `EntityProfiles.official_email` as the institution email source of truth.
- If matching fails or is ambiguous, the raw fetched message and diagnostics are stored in `resend_wh_emails.metadata` for later review.

### 2. `resend_wh_emails`

This table stays exactly as the standard Resend event store already defined in the schema.

It is used for:

- immutable provider event capture
- webhook idempotency
- operational audit history

It is not used as the business source of truth for correspondence state, but it gains one generic extension:

- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

`metadata` is used only for unmatched inbound raw messages and routing diagnostics such as:

- `matchStatus`
- `matchReason`
- `rawMessage`

## Alternatives Considered

### 1. Keep the thread-plus-message relational model

Rejected because:

- the campaign does not yet need message-level relational querying
- review state would be split across thread and message records
- schema complexity would increase before there is evidence that a separate message table pays for itself

### 2. Store the whole workflow directly in `resend_wh_emails`

Rejected because:

- provider events are not the same thing as business workflow state
- one logical email can produce several provider events
- the public-debate workflow needs one authoritative thread aggregate, not a provider-shaped source of truth

### 3. Keep capture tokens as the primary routing mechanism

Rejected because:

- header- and subject-based matching can cover the required routing flow
- `EntityProfiles.official_email` reduces the need for a separate prepare-context store
- removing the token table keeps the data model smaller while still preserving unmatched raw mail in the provider log

## Consequences

**Positive**

- The business model is reduced to one correspondence-owned record: the thread.
- The schema stays small while preserving strong runtime validation through TypeBox.
- The thread model stays generic enough to carry campaign context without adding more relational tables.
- Both platform-send and self-send can converge into the same thread aggregate after header- or subject-based correlation, without exposing institution-facing REST endpoints.
- The Resend event store remains standard and reusable.
- Message history is preserved without committing to a separate relational message table.
- Unmatched or ambiguous inbound messages can be retained for later review without polluting the thread aggregate.

**Negative**

- Admin review cannot query individual messages relationally in v1.
- Aggregate updates must be handled carefully in application code to avoid clobbering correspondence history.
- Header- and subject-based routing is more heuristic than token-based routing and needs careful validation and fallback handling.
- Some future analytics or search use cases may eventually justify extracting parts of the aggregate into dedicated tables.

## References

- `src/infra/database/user/schema.sql`
- `src/infra/database/user/migrations/202603251630_add_public_debate_correspondence_v1.sql`
- `docs/specs/specs-202603221720-institution-correspondence-module.md`
- `src/modules/institution-correspondence/`
- `src/modules/resend-webhooks/`
- `src/infra/email/client.ts`
- <https://resend.com/docs/api-reference/emails/send-email>
- <https://resend.com/docs/api-reference/emails/retrieve-received-email>
- <https://resend.com/docs/webhooks/emails/received>
- <https://legislatie.just.ro/Public/DetaliiDocument/185898>
