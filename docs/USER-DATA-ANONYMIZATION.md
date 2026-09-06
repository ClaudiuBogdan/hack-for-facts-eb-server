# User Data Anonymization

This document describes the implemented anonymization strategy for Clerk
`user.deleted` webhook events.

The handler is intentionally scoped to account-holder data in the user database.
It preserves product and operational history where possible, but removes or
decouples identity-bearing data so the deleted Clerk user can no longer be
identified from retained rows.

## Entry Point

Clerk deletion events enter through:

- `src/modules/clerk-webhooks/shell/rest/routes.ts`
- `src/modules/clerk-webhooks/shell/handlers/user-deleted-anonymization-handler.ts`
- `src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts`

The handler only processes verified `user.deleted` events. The raw Clerk
`data.id` is used inside the transaction, but logs and audit records avoid
storing the raw ID.

## Identity Decoupling

Deleted users are replaced with a deterministic pseudonymous ID:

```text
deleted-user:<sha256(clerk_user_id)>
```

This makes the operation idempotent and lets related retained rows remain
joinable for internal consistency without retaining the original Clerk user ID.

The raw Clerk user ID is not written to the anonymization audit table. The audit
table stores a one-way SHA-256 hash instead.

This deterministic tombstone deliberately differs from the notification architecture document's
"random tombstone" phrasing so the platform remains consistent with the existing idempotent
anonymizer and keeps retained related rows joinable without the original Clerk user ID.

## PII Inventory and Treatment

| Store                                  | PII / user-generated data                                                                                                         | Treatment on `user.deleted`                                                                                                                                                                                                                   | Retention pattern                                                                                       |
| :------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `ShortLinks`                           | `user_ids`; URLs and metadata must not be used for user PII                                                                       | Delete links owned only by the deleted user; remove the deleted user ID from shared links                                                                                                                                                     | Hard-delete user-only links; preserve shared links                                                      |
| `Notifications`                        | `user_id`, user-owned notification preferences/config                                                                             | Replace `user_id` with the anonymized ID, disable the notification, replace config with an anonymized no-email config, replace hash with `anonymized:<id>`                                                                                    | Preserve decoupled preference history                                                                   |
| `NotificationOutbox`                   | `user_id`, `to_email`, rendered subject/html/text, content hash, delivery keys, metadata                                          | Replace `user_id`, clear email/body/hash fields, replace scope and delivery keys, redact metadata, mark pending/sending rows as `skipped_no_email`                                                                                            | Preserve delivery ledger without personal content                                                       |
| `UserInteractions`                     | `user_id`, submitted values, source URLs, review actor IDs, audit event payloads                                                  | Replace `user_id`, set `record.value` to null, remove source URL, remove private result/review fields, clear audit events, redact metadata-like fields                                                                                        | Preserve minimal action state                                                                           |
| `CampaignNotificationRunPlans`         | actor user ID and generated JSON run plans that can contain user data                                                             | Delete plans where the actor or JSON payload references the deleted/anonymized user                                                                                                                                                           | Hard-delete short-lived generated plans                                                                 |
| `InstitutionEmailThreads`              | owner user ID, requester org, correspondence addresses, subjects, bodies, headers, attachments, admin response text, review notes | Replace owner/actor IDs, redact correspondence content and addresses for owner-owned threads, clear requester org and notes, sanitize metadata                                                                                                | Preserve thread shell and workflow state without user identity/content                                  |
| `resend_wh_emails`                     | address lists, subject, message ID, attachments, bounce diagnostics, click IP/link/user-agent, metadata                           | Redact addresses and subject, clear message ID/attachments/bounce/click fields, sanitize metadata                                                                                                                                             | Preserve provider event correlation without personal data                                               |
| `AdvancedMapAnalyticsMaps`             | `user_id`, user-created map title/description/public ID/snapshots                                                                 | Replace `user_id`, placeholder title, clear description/public ID/snapshots, set private, soft-delete                                                                                                                                         | Preserve decoupled map record                                                                           |
| `AdvancedMapAnalyticsSnapshots`        | user-created snapshot title/description/body                                                                                      | Placeholder title, clear description, replace snapshot with `{ "anonymized": true }`                                                                                                                                                          | Preserve snapshot row without content                                                                   |
| `AdvancedMapDatasets`                  | `user_id`, user-created dataset title/description/markdown/unit/public ID                                                         | Replace `user_id`, placeholder title, clear descriptive fields, set private, row count 0, soft-delete                                                                                                                                         | Preserve decoupled dataset record                                                                       |
| `AdvancedMapDatasetRows`               | user-uploaded dataset row values                                                                                                  | Delete rows for datasets owned by the deleted user                                                                                                                                                                                            | Hard-delete generated/user-uploaded values                                                              |
| `ins_dataset_requests`                 | `clerk_user_id`, `contact_email`, free-text `note`                                                                                | Replace `clerk_user_id` with the anonymized ID, clear `contact_email` and `note`; retain `dataset_code`, `siruta`, `created_at`                                                                                                               | Preserve the aggregate demand signal without requester identity                                         |
| `AgentConversations` / `AgentMessages` | Clerk `user_id`, user prompts, generated answers, and tool history                                                                | Delete conversations owned by the raw or deterministic anonymized user ID; `ON DELETE CASCADE` deletes all messages                                                                                                                           | Hard-delete the complete chat history                                                                   |
| `notification_events`                  | Canonical event facts; no recipient/account ownership field                                                                       | No change; recipient-specific data is stored on logical notifications, not event facts                                                                                                                                                        | Preserve until normal two-year retention; then delete when unreferenced or scrub facts while referenced |
| `notification_source_watermarks`       | Source ingestion cursor; no user data                                                                                             | No change                                                                                                                                                                                                                                     | Preserve restart-safe ingestion progress                                                                |
| `notification_subscriptions`           | `user_id`, subject choice, and user-owned subscription config                                                                     | Delete rows for the raw or deterministic anonymized user ID                                                                                                                                                                                   | Hard-delete user intent/config                                                                          |
| `notification_global_preferences`      | `user_id` and global optional-notification state                                                                                  | Delete rows for the raw or deterministic anonymized user ID                                                                                                                                                                                   | Hard-delete user preference state                                                                       |
| `notification_channel_preferences`     | `user_id`, channel enabled state, and cadence                                                                                     | Delete rows for the raw or deterministic anonymized user ID                                                                                                                                                                                   | Hard-delete user preference state                                                                       |
| `logical_notifications`                | `user_id`, recipient facts, rendered inbox content/action, visibility, read/archive state                                         | Replace `user_id`; set eligibility reason to `user_anonymized`; clear recipient facts/action/read/archive; replace title/body with non-personal placeholders; set `inbox_visible=false`                                                       | Preserve hidden, redacted history only until normal two-year row deletion                               |
| `notification_channel_destinations`    | `user_id`, destination fingerprint, generation, and suppression state                                                             | Delete rows for the raw or deterministic anonymized user ID                                                                                                                                                                                   | Hard-delete contact-point state                                                                         |
| `notification_deliveries`              | `user_id`, destination fingerprint/generation, rendered email content/hash, provider identifiers, errors, and claims              | Replace `user_id`; clear destination, rendered, provider, message, and claim fields; set `user_anonymized`; cancel only `pending_render`, `scheduled`, `ready`, `sending`, and `retry_wait`; keep `accepted` and terminal statuses unchanged  | Preserve redacted ledger only until normal two-year row deletion                                        |
| `notification_delivery_attempts`       | Destination fingerprint, provider reference, and error details for a user-owned delivery                                          | Clear destination fingerprint, provider reference, and error code/message for attempts whose delivery belongs to the deleted user                                                                                                             | Preserve redacted attempt number/timing/classification                                                  |
| `notification_digest_batches`          | `user_id`, rendered logical-ID snapshot, overflow count, delivery link, and claim                                                 | Replace `user_id`; scrub `rendered_item_ids` to `[]` and overflow/claim fields; cancel `open`/`materializing`; keep `rendered` (and already `cancelled`) status unchanged; linked pre-provider deliveries are cancelled by delivery treatment | Preserve redacted relationship only until normal two-year row deletion                                  |
| `notification_digest_members`          | Links a digest batch to logical notifications; no direct user field                                                               | Preserve membership rows; linked batch and logical rows are pseudonymized and scrubbed                                                                                                                                                        | Delete with expired logical notifications during normal retention                                       |
| `notification_audit_log`               | User/actor IDs, free-text reason, and structured audit details                                                                    | Replace matching `user_id` and `actor` with the deterministic anonymized ID; clear reason and replace details with `{}`                                                                                                                       | Preserve redacted lifecycle/action audit                                                                |
| `UserDataAnonymizationAudit`           | anonymization execution evidence                                                                                                  | Store user ID hash, anonymized user ID, first/latest Svix IDs, event type/timestamp, run count, and summary                                                                                                                                   | Preserve non-PII audit trail                                                                            |

## User Data Store v2

The v2 store is erased through the verified Clerk `user.deleted` flow after the legacy-table
transaction succeeds. Its erasure runs in a separate idempotent transaction; a failure fails the
webhook handling so Clerk retries rather than silently leaving v2 data behind.

| Category            | Current record treatment                                                                                                          | Event treatment                                                                                                                                    | Receipt treatment                                             |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| `funky.interaction` | `owner_id` → deterministic pseudonym; payload → the category v1 redactor (`{}`); annotations → each registered namespace redactor | Same owner/payload/annotation treatment; `client_occurred_at`, `source_event_id`, and `source_occurred_at` → `NULL`; `privacy_redacted_at` stamped | Delete every receipt whose `requester_id` is the deleted user |
| `learning.progress` | `owner_id` → deterministic pseudonym; payload → the category v1 redactor (`{}`); annotations → each registered namespace redactor | Same owner/payload/annotation treatment; `client_occurred_at`, `source_event_id`, and `source_occurred_at` → `NULL`; `privacy_redacted_at` stamped | Delete every receipt whose `requester_id` is the deleted user |

The event ledger remains append-only for ordinary application code. The erasure transaction sets
the local `app.user_data_maintenance` GUC; the trigger permits exactly the privacy-redaction column
set above and still rejects event deletion or changes to immutable identity/revision fields.

**A category MUST have a field-treatment row in this section before it is enabled.** At launch the
two categories declare no annotation namespaces; when a namespace is introduced, its redactor and
field treatment must be reviewed here before deployment. Unknown persisted namespaces are
fail-closed to `{}` by the erasure adapter.

## Soft Delete vs Hard Delete

Soft delete is used when a durable product object may still be needed for
internal consistency, historical counts, or references:

- advanced maps
- advanced datasets

Hard delete is used for short-lived or content-heavy generated data that should
not survive user deletion:

- single-user short links
- campaign notification run plans
- advanced dataset row values
- agent conversations and their cascaded messages

Operational ledgers are retained after identity-bearing fields are removed, subject to their
documented normal retention windows:

- notification outbox rows
- notification platform logical, delivery, digest, and audit rows
- Resend webhook event rows
- anonymization audit rows
- INS dataset request rows

For the notification platform, normal retention then deletes delivery attempts and raw provider
webhooks after 90 days and dependency-ordered digest members, deliveries, digest batches, logical
notifications, and unreferenced events after two years. Referenced expired event facts are scrubbed
until their logical notifications expire. The redacted `notification_audit_log` is the sole
indefinite notification-platform record.

## Anonymous Submissions Never Persist PII

`ins_dataset_requests` accepts submissions from signed-out users. The Clerk
`user.deleted` event identifies the account **only by user ID** — it carries no
email address — so the anonymizer can only match rows on `clerk_user_id`. A row
written without a `clerk_user_id` is therefore structurally unreachable by the
deletion handler: no `WHERE` clause could ever find it, and any PII it held
would survive account deletion forever.

The fix is at the write path, not the deletion path. When a dataset request has
no authenticated Clerk user, the usecase does not persist `contact_email` or
`note` at all; it stores only `dataset_code`, `siruta` and `created_at`. The
request is still accepted — that tuple carries the aggregate "N people asked for
this dataset" signal, which is the product value. Authenticated submissions
persist both fields, because `clerk_user_id` makes them anonymizable on
`user.deleted`.

Consequently every `contact_email` and `note` in this table belongs to a row
that the anonymizer can find.

The same invariant is enforced against deployment topology. The Clerk webhook —
and therefore the anonymization handler — only registers when
`CLERK_WEBHOOK_SIGNING_SECRET` is configured, while the dataset-request route
mounts as soon as a user database exists. `makeInsRoutes` therefore takes a
`userDeletionHandlerConfigured` flag: when the webhook is absent the route
refuses to attach a Clerk user id at all, so a deploy without deletion wiring
records only the aggregate signal and never personal data. Startup logs a
warning in that state.

> **Systemic note.** The notifications and share routes mount under the same
> `userDb` guard and store `user_id` / email data without checking that the
> Clerk webhook is registered. They have the same exposure and are not covered
> by this flag.

## Idempotency

The anonymizer is safe to run more than once for the same Clerk user because:

- the anonymized ID is deterministic
- updates match both the raw user ID and the anonymized user ID
- destructive operations target rows that still match the deletion criteria
- agent deletion matches both the raw and deterministic anonymized user IDs
- user-interaction conflicts are removed before rewriting to the anonymized ID
- audit writes use `ON CONFLICT (user_id_hash)` and increment `run_count`

The e2e test in `tests/e2e/user-data-anonymizer.test.ts` runs the anonymizer
twice and verifies the replay succeeds.

## Audit and Logging

When an anonymization run starts, the anonymizer first writes or updates a
non-PII audit row. Notification send workers check this audit marker after
claiming a delivery and again immediately before calling the email provider, so
in-flight deliveries are skipped once deletion handling has started.

Successful runs write to `UserDataAnonymizationAudit` with:

- `user_id_hash`
- `anonymized_user_id`
- `first_svix_id`
- `latest_svix_id`
- `clerk_event_type`
- `clerk_event_timestamp`
- `completed_at`
- `run_count`
- `summary`

The webhook route hashes `event.data.id` for `user.deleted` logs. The anonymizer
logs the Svix ID, anonymized user ID, and mutation summary. Errors log the user
ID hash, not the raw Clerk ID.

When email is enabled, successful anonymization also sends a fire-and-forget
admin alert to the configured admin/campaign sender address. The alert includes
the Svix ID, user ID hash, anonymized user ID, and mutation summary. It must not
include the raw Clerk user ID.

## Static Misuse Guard

The anonymizer factory is deliberately not exported from
`src/modules/clerk-webhooks/index.ts`. ESLint also restricts imports of
`src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts` to the
approved composition and handler files.

If another caller needs deletion behavior, route it through the verified Clerk
`user.deleted` webhook handler instead of importing the destructive factory
directly.

## Adding New User-Generated Tables

Any new table or JSON document that stores user-generated data, user-owned
configuration, user-linked operational state, or copied account data must include
a deletion/anonymization plan before it is merged.

Required checklist:

1. Identify all direct user references, copied contact fields, free-text fields,
   rendered content, metadata blobs, provider payloads, and audit fields.
2. Decide whether each field is retained, nullified, replaced with a placeholder,
   replaced with the anonymized user ID, hashed, soft-deleted, or hard-deleted.
3. Add the table to `makeUserDataAnonymizer` or route it through a module-owned
   anonymization helper called from that handler.
4. Add tests that prove a Clerk `user.deleted` replay is idempotent.
5. Update this document with the table and field treatment.

Do not add durable copies of Clerk-owned identity or contact data unless there is
a documented product and retention requirement.

## References

- `docs/specs/specs-202604012011-personal-data-minimization-strategy.md`
- `src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts`
- `src/modules/clerk-webhooks/shell/handlers/user-deleted-anonymization-handler.ts`
- `src/infra/database/user/migrations/202604241200_add_user_data_anonymization_audit.sql`
- `tests/e2e/user-data-anonymizer.test.ts`

### Saved-map write fencing (2026-09-06)

All eight owner mutations in the map and uploaded-dataset repositories acquire
the existing owner advisory lock first, then check any matching
`UserDataAnonymizationAudit.user_id_hash` row in the same READ COMMITTED
transaction. A started or failed deletion is already a permanent write ban;
these audit tombstones must never expire during routine cleanup. The runtime
user DB role requires SELECT on this audit table.

The verified deletion handler commits the started marker before its deletion
transaction takes the same owner lock. An admitted writer finishes before
deletion clears its data; a waiting or later writer sees the marker and receives
Forbidden. Neither cached JWTs nor direct repository calls bypass this boundary.
The public-view counter is exempt because it cannot recreate user content.

`tests/e2e/map-owner-deletion.test.ts` exercises all eight direct mutation paths,
both race orderings, started markers, replay, and an unrelated owner against
the actual schema in a unique disposable PostgreSQL namespace. This guarantee
covers map/dataset writers; unrelated legacy product runtimes remain unmounted
in the native dev app.
