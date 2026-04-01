# Personal Data Minimization and Clerk Boundary Strategy

**Status**: Draft
**Date**: 2026-04-01
**Author**: Codex

## Problem

The current system stores user-linked personal data in multiple places outside Clerk, and the same data is often copied across the database, Redis-backed queues, webhook journals, and JSON metadata blobs.

The main gaps are:

- Clerk is already the identity system, but notification delivery still snapshots recipient email addresses and full rendered email bodies in `NotificationOutbox`.
- Public debate flows duplicate user-submitted and correspondence data across `UserInteractions`, `InstitutionEmailThreads`, `NotificationOutbox.metadata`, and `resend_wh_emails`.
- Resend webhook persistence stores more personal data than the application needs for correlation and recovery, including address lists, subject lines, click IP addresses, and user agents.
- Some user-facing APIs do not need the stored personal data they currently load, which means the storage is an implementation choice rather than a product requirement.
- Budget-side scraped profiles mix operationally useful institution data with higher-risk fields such as political affiliation and a full raw scrape blob.

The desired state is:

- Clerk is the only source of truth for account-holder identity and contact data.
- User DB tables store only product state keyed by `user_id`, unless the personal data itself is the domain artifact and cannot be recomputed from `user_id`.
- Domain data that must exist outside Clerk is stored once, in a dedicated canonical table, with explicit retention and minimization rules.
- Queues, caches, webhook journals, and metadata blobs do not become secondary personal-data stores.

## Context

The current codebase already contains some good building blocks for minimization:

- Auth is centered on Clerk-backed user IDs, not local user profile tables.
- The send worker already supports just-in-time Clerk email lookup through `makeClerkUserEmailFetcher`.
- BullMQ job payloads are already relatively small in the notification pipeline:
  - `SendJobPayload` contains only `outboxId`
  - `ComposeJobPayload` contains only `notificationId` or `outboxId`
  - `UserEventJobPayload` contains `userId`, `eventId`, and `recordKey`
- The public notifications REST API does not expose stored rendered bodies or recipient email addresses in delivery history responses.

The main personal-data write paths found in the code review are:

| Area                                            | Current behavior                                                                                                                                                  | Why it matters                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NotificationOutbox`                            | Stores `to_email`, `rendered_subject`, `rendered_html`, `rendered_text`, and event metadata copied from correspondence flows                                      | Creates a durable duplicate of Clerk email data and message content                                 |
| `compose-subscription.ts` / `compose-outbox.ts` | Writes full rendered email content into the outbox before send                                                                                                    | Makes the outbox a content store, not only a control-plane queue                                    |
| `send-worker.ts`                                | Fetches Clerk email if `toEmail` is null, then writes the resolved email address back to the outbox                                                               | Reintroduces Clerk data into the DB even though it can be fetched on demand                         |
| `resend_wh_emails`                              | Persists full webhook payload details including address lists, subject, click IP, and click user-agent                                                            | Stores more personal data than correlation logic needs                                              |
| `InstitutionEmailThreads.record`                | Stores owner user ID, institution email, full correspondence entries, full bodies, and duplicate `rawMessage` blobs in metadata                                   | This is a justified canonical correspondence store, but it currently contains avoidable duplication |
| `UserInteractions.record`                       | Stores generic text/URL/JSON payloads, including public debate request payloads with institution email, NGO sender email, prepared subject, and organization name | Some of this is domain-required, but some is only kept to support lookup shortcuts                  |
| `public-debate-self-send-context-lookup.ts`     | Resolves self-send context by querying raw `UserInteractions.record` JSON for `ngoSenderEmail` and `preparedSubject`                                              | Couples a durable generic interaction store to temporary matching data                              |
| `EntityProfiles`                                | Stores institutional contact data plus `leader_party` and `full_profile`                                                                                          | Not Clerk-related, but still personal data and in one case special-category data                    |

Important constraint: not all personal data belongs in Clerk.

- Account-holder identity/contact data belongs in Clerk.
- User-authored content and correspondence do not belong in Clerk and need dedicated product tables.
- Institution and public-official profile data are a separate privacy problem from end-user identity data and need separate minimization rules.

## Decision

### 1. Use a three-class personal-data model

The system should treat personal data in three different ways instead of applying one rule everywhere.

| Class                     | Examples                                                                                                                      | Storage rule                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Clerk-owned identity data | user email, user name, phone number                                                                                           | Store only in Clerk. Application DB may keep `user_id` and short-lived in-memory caches, but not durable copies.            |
| Canonical domain content  | correspondence text, user-submitted challenge/request content, institution contact address needed to send or review a request | Store only in a dedicated domain table that exists for that content, not in secondary copies.                               |
| Operational telemetry     | webhook correlation data, queue payloads, rate-limit keys, provider IDs                                                       | Keep only the minimum fields required for correlation, retries, and abuse protection. Hash, redact, or delete aggressively. |

This means the boundary is not “all personal data goes to Clerk.” The boundary is “all account identity/contact data goes to Clerk; everything else must justify itself as canonical product data.”

### 2. Make `NotificationOutbox` a control-plane table, not a content store

Target state for `NotificationOutbox`:

- Keep:
  - `id`
  - `user_id`
  - `notification_type`
  - `reference_id`
  - `scope_key`
  - `delivery_key`
  - `status`
  - `attempt_count`
  - `last_attempt_at`
  - `sent_at`
  - `last_error`
  - `created_at`
  - optionally `template_name`, `template_version`, and `content_hash` if they are needed for observability
- Remove:
  - `to_email`
  - `rendered_subject`
  - `rendered_html`
  - `rendered_text`
- Restrict `metadata` to routing keys and canonical foreign references, not copied personal content

Practical consequences:

- `compose-subscription.ts` should stop persisting rendered bodies. It should persist only a minimal compose plan, or skip durable compose output entirely.
- `compose-outbox.ts` should stop copying correspondence-derived personal fields such as `institutionEmail`, `replyTextPreview`, and `reviewNotes` into outbox metadata.
- `send-worker.ts` should always fetch the current recipient email from Clerk just before send and should not write that email address back to the DB.

For public debate update notifications specifically, outbox metadata should contain only enough data to reload the canonical thread and review context, for example:

- `threadId`
- `eventType`
- `replyEntryId`
- `basedOnEntryId`
- `occurredAt`

The compose stage should derive previews and user-visible content from `InstitutionEmailThreads`, not from duplicated outbox metadata.

### 3. Recompute notification content on retry instead of snapshotting it in the DB

The current design stores full rendered content for retry safety. The strategy changes that tradeoff:

- Retries should re-run composition from canonical data sources.
- Deterministic sources:
  - `Notifications`
  - period keys
  - analytics/newsletter source data
  - `InstitutionEmailThreads`
- Non-deterministic or short-lived compose inputs should be stored only in their canonical tables, not in the outbox.

This is acceptable because:

- The public delivery-history API does not require stored bodies.
- Queue payloads already use IDs, not bodies.
- Content drift between initial compose and retry is a better tradeoff than durable duplication of personal data in a general-purpose outbox.

If exact replay is later required for a specific legal or support workflow, it should use a separate restricted evidence store, not the general notification outbox.

### 4. Reduce `resend_wh_emails` to a minimal event journal

Target state for the generic webhook event table:

- Keep only fields needed for deduplication, correlation, and high-level status reconciliation.
- Do not use the generic webhook journal as a durable mailbox mirror.

Recommended keep-set:

- `svix_id`
- `event_type`
- `event_created_at`
- `webhook_received_at`
- `email_id`
- `message_id` when present
- correlation tags or extracted keys such as `thread_key`
- bounce/suppression reason fields when needed for state transitions
- a small `metadata` object for match status and bounded diagnostics

Recommended remove or stop writing:

- `from_address`
- `to_addresses`
- `cc_addresses`
- `bcc_addresses`
- `subject`
- `click_ip_address`
- `click_user_agent`
- `attachments_json`

For `email.received`, the side effect already fetches the full received message from Resend by `email_id`. That means:

- full inbound addresses and bodies do not need to be persisted in `resend_wh_emails`
- unmatched diagnostics should store structured reasons and stable identifiers, not `rawMessage` with full HTML/text

### 5. Keep correspondence data only in `InstitutionEmailThreads`, and minimize it there

`InstitutionEmailThreads` is the right canonical store for public-debate correspondence. It is the one place where message-related personal data can be justified because the product needs it for:

- audit and support
- admin review
- user-facing thread updates
- matching replies to the correct thread

But the stored shape should be tightened:

- Keep canonical thread-level fields:
  - `ownerUserId`
  - `institutionEmail`
  - `requesterOrganizationName` when supplied
  - lifecycle timestamps
- Keep canonical message-level fields needed to operate the flow:
  - `direction`
  - `source`
  - `resendEmailId`
  - `messageId`
  - `fromAddress`
  - `toAddresses`
  - `ccAddresses`
  - `subject`
  - `textBody`
  - attachment metadata
  - `occurredAt`
- Remove duplicated `rawMessage` from entry metadata
- Prefer not storing `htmlBody` and raw headers long-term unless there is a specific reviewed requirement for them
- Do not copy correspondence content into `NotificationOutbox` or webhook-journal metadata

If exact raw inbound message preservation is a product requirement, add a separate restricted evidence table and retention policy instead of embedding full raw content in thread metadata.

### 6. Split temporary self-send matching data out of `UserInteractions`

The public-debate self-send flow currently depends on storing `ngoSenderEmail` and `preparedSubject` inside generic `UserInteractions.record` JSON and then searching that JSON later.

That should be replaced with a dedicated, minimal lookup table such as `PublicDebateSelfSendContexts`:

- `interaction_key_hash`
- `user_id`
- `record_key`
- `entity_cui`
- `institution_email`
- `requester_organization_name`
- `created_at`
- `expires_at`
- `consumed_at`

Rules:

- Store only a normalized hash of `(ngoSenderEmail, preparedSubject)` for matching.
- Use the table only for pending self-send correlation.
- Delete or mark consumed once the thread is created or the matching window expires.
- After migration, `UserInteractions` should keep the canonical interaction state and review history, but not carry extra long-lived lookup fields solely for correlation.

### 7. Treat `UserInteractions` as canonical user-submitted content, but add lifecycle scrubbing

`UserInteractions` is a justified canonical store for user-submitted content that cannot be derived from `user_id`.

That table should remain allowed to store:

- free text the user entered
- URLs the user submitted
- structured JSON that represents the interaction result
- review and audit history

But it should gain explicit lifecycle rules:

- pending and under-review records may keep full submitted content
- once a record has been consumed into a canonical downstream artifact, it should be scrubbed to the minimum needed for product behavior and audit
- records used only for workflow correlation should move to dedicated, TTL-backed tables instead of remaining in generic JSON forever

For the public debate request flow, the canonical downstream artifact is the thread. Once the request is successfully turned into a thread or a self-send context is consumed, the interaction record should retain only:

- the fact that the action occurred
- review/result metadata
- references to the canonical thread or correlation record

### 8. Keep `Notifications`, `ShortLinks`, and `AdvancedMapAnalyticsMaps` largely as-is

These tables are already close to the desired boundary:

- `Notifications` stores user-owned preference state that cannot be derived from Clerk
- `ShortLinks.user_ids` stores only user IDs
- `AdvancedMapAnalyticsMaps.user_id` stores only user IDs

No Clerk-owned contact data should be added to these tables.

### 9. Keep Clerk caches in-memory only, and hash operational keys where possible

Current cache stance should be formalized:

- Clerk email cache remains in-memory only, with short TTL and bounded size
- auth token cache remains keyed by token hash, not raw token
- rate-limit keys should use hashed user/session identifiers when feasible
- no Clerk email or user profile data should be written to Redis or Postgres unless a canonical product workflow explicitly requires it

### 10. Separate end-user identity policy from budget-domain profile policy

`EntityProfiles` is not a Clerk problem, because it stores institution and public-official data, not account-holder identity. It still needs minimization.

Recommended split:

- Keep a public profile surface with fields the product clearly uses:
  - `institution_type`
  - `website_url`
  - `official_email` if needed for the public debate flow
  - `address_locality`
  - county fields
  - `scraped_at`
  - `extraction_confidence`
- Reconsider or move to a restricted store:
  - `phone_primary`
  - `address_raw`
  - `leader_name`
  - `leader_title`
  - `leader_party`
  - `full_profile`

Specific rule for `leader_party`:

- treat it as special-category/sensitive data
- do not expose it by default through general GraphQL entity profile reads unless there is a documented lawful basis and product requirement

Specific rule for `full_profile`:

- it should not live in the main serving table if it is only retained for internal debugging or scraper audit
- move it to a restricted archival table or drop it if the product does not use it

### 11. Add retention and deletion policy per store

The target state needs explicit retention rules, not only schema changes.

Recommended defaults:

- `NotificationOutbox`: retain operational status only; no personal content to scrub
- `resend_wh_emails`: short retention for minimal event journal, for example 30 to 90 days
- `PublicDebateSelfSendContexts`: expire aggressively, for example 7 to 30 days, or immediately after consumption
- `UserInteractions`: keep only while the record is still product-relevant; scrub fields after resolution where possible
- `InstitutionEmailThreads`: keep according to campaign/audit needs, but avoid duplicated raw payload storage

### 12. Roll out in phases

#### Phase 1: Stop creating new duplicated data

- stop writing `to_email` and rendered bodies into `NotificationOutbox`
- stop writing correspondence-derived personal fields into outbox metadata
- stop writing `rawMessage` into correspondence entry metadata
- stop storing full webhook address and click telemetry fields in `resend_wh_emails`

#### Phase 2: Introduce dedicated minimal lookup structures

- add `PublicDebateSelfSendContexts`
- migrate self-send matching off `UserInteractions.record`

#### Phase 3: Shrink canonical stores

- remove or null legacy outbox columns
- scrub resolved `UserInteractions` records where allowed
- split or restrict `EntityProfiles.full_profile` and `leader_party`

#### Phase 4: Enforce the policy

- add schema comments and code review rules for “Clerk-owned”, “canonical domain”, and “operational” fields
- add tests that prevent notification code from persisting rendered bodies or resolved recipient email addresses
- add retention jobs for webhook events and temporary self-send contexts

## Alternatives Considered

### 1. Keep the current model and encrypt sensitive columns

Rejected because encryption reduces exposure after compromise but does not reduce the privacy footprint, duplication, or lawful-basis surface area. The same personal data would still exist in too many places.

### 2. Move all personal data into Clerk

Rejected because user-generated content, correspondence history, and institution-domain data do not belong in an identity provider. Clerk should own identity and contact data, not product artifacts.

### 3. Keep outbox body snapshots for replay safety

Rejected as the default because it turns the outbox into a general personal-content store. Exact replay, if needed, should use a dedicated restricted evidence store instead.

### 4. Leave `UserInteractions` as the catch-all store for workflow data

Rejected because it keeps temporary correlation fields forever inside a generic JSON store and makes later minimization hard. Dedicated TTL-backed lookup tables are clearer and safer.

## Consequences

**Positive**

- Clerk becomes the single source of truth for account-holder contact data.
- The user DB keeps product state and canonical artifacts, not avoidable copies.
- Notification delivery becomes easier to reason about from a privacy perspective because the outbox stops carrying bodies and recipient emails.
- Public debate flows keep the data they truly need while dropping redundant copies in outbox and webhook metadata.
- Budget-domain profile data gets a clearer separation between public product fields and restricted or sensitive scraper output.

**Negative**

- Retries will re-compose content instead of replaying stored bodies, so a resend may not be byte-for-byte identical to the first attempt.
- Some support/debug workflows will need new tooling because raw payloads will no longer be spread across generic tables.
- The self-send correlation flow needs a small schema addition and migration instead of relying on existing `UserInteractions` JSON.
- Tightening `InstitutionEmailThreads` may require explicit decisions about whether HTML bodies and raw headers are truly needed long-term.

## References

- `src/modules/notification-delivery/shell/clerk/user-email-fetcher.ts`
- `src/modules/notification-delivery/shell/repo/delivery-repo.ts`
- `src/modules/notification-delivery/shell/queue/workers/compose-subscription.ts`
- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`
- `src/modules/notification-delivery/shell/queue/workers/send-worker.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notifications/shell/repo/deliveries-repo.ts`
- `src/modules/notifications/shell/rest/schemas.ts`
- `src/modules/resend-webhooks/core/mappers.ts`
- `src/modules/resend-webhooks/shell/repo/resend-webhook-email-events-repo.ts`
- `src/modules/institution-correspondence/core/types.ts`
- `src/modules/institution-correspondence/core/usecases/send-platform-request.ts`
- `src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/modules/learning-progress/core/types.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `src/app/public-debate-self-send-context-lookup.ts`
- `src/infra/database/user/schema.sql`
- `src/infra/database/budget/schema.sql`
- `src/modules/entity/shell/repo/entity-profile-repo.ts`
- `src/modules/entity/shell/graphql/schema.ts`
