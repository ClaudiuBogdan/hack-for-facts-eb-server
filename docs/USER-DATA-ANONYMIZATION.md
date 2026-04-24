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

## PII Inventory and Treatment

| Store                           | PII / user-generated data                                                                                                         | Treatment on `user.deleted`                                                                                                                                | Retention pattern                                                      |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| `ShortLinks`                    | `user_ids`; URLs and metadata must not be used for user PII                                                                       | Delete links owned only by the deleted user; remove the deleted user ID from shared links                                                                  | Hard-delete user-only links; preserve shared links                     |
| `Notifications`                 | `user_id`, user-owned notification preferences/config                                                                             | Replace `user_id` with the anonymized ID, disable the notification, replace config with an anonymized no-email config, replace hash with `anonymized:<id>` | Preserve decoupled preference history                                  |
| `NotificationOutbox`            | `user_id`, `to_email`, rendered subject/html/text, content hash, delivery keys, metadata                                          | Replace `user_id`, clear email/body/hash fields, replace scope and delivery keys, redact metadata, mark pending/sending rows as `skipped_no_email`         | Preserve delivery ledger without personal content                      |
| `UserInteractions`              | `user_id`, submitted values, source URLs, review actor IDs, audit event payloads                                                  | Replace `user_id`, set `record.value` to null, remove source URL, remove private result/review fields, clear audit events, redact metadata-like fields     | Preserve minimal action state                                          |
| `CampaignNotificationRunPlans`  | actor user ID and generated JSON run plans that can contain user data                                                             | Delete plans where the actor or JSON payload references the deleted/anonymized user                                                                        | Hard-delete short-lived generated plans                                |
| `InstitutionEmailThreads`       | owner user ID, requester org, correspondence addresses, subjects, bodies, headers, attachments, admin response text, review notes | Replace owner/actor IDs, redact correspondence content and addresses for owner-owned threads, clear requester org and notes, sanitize metadata             | Preserve thread shell and workflow state without user identity/content |
| `resend_wh_emails`              | address lists, subject, message ID, attachments, bounce diagnostics, click IP/link/user-agent, metadata                           | Redact addresses and subject, clear message ID/attachments/bounce/click fields, sanitize metadata                                                          | Preserve provider event correlation without personal data              |
| `AdvancedMapAnalyticsMaps`      | `user_id`, user-created map title/description/public ID/snapshots                                                                 | Replace `user_id`, placeholder title, clear description/public ID/snapshots, set private, soft-delete                                                      | Preserve decoupled map record                                          |
| `AdvancedMapAnalyticsSnapshots` | user-created snapshot title/description/body                                                                                      | Placeholder title, clear description, replace snapshot with `{ "anonymized": true }`                                                                       | Preserve snapshot row without content                                  |
| `AdvancedMapDatasets`           | `user_id`, user-created dataset title/description/markdown/unit/public ID                                                         | Replace `user_id`, placeholder title, clear descriptive fields, set private, row count 0, soft-delete                                                      | Preserve decoupled dataset record                                      |
| `AdvancedMapDatasetRows`        | user-uploaded dataset row values                                                                                                  | Delete rows for datasets owned by the deleted user                                                                                                         | Hard-delete generated/user-uploaded values                             |
| `UserDataAnonymizationAudit`    | anonymization execution evidence                                                                                                  | Store user ID hash, anonymized user ID, first/latest Svix IDs, event type/timestamp, run count, and summary                                                | Preserve non-PII audit trail                                           |

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

Operational ledgers are retained only after identity-bearing fields are removed:

- notification outbox rows
- Resend webhook event rows
- anonymization audit rows

## Idempotency

The anonymizer is safe to run more than once for the same Clerk user because:

- the anonymized ID is deterministic
- updates match both the raw user ID and the anonymized user ID
- destructive operations target rows that still match the deletion criteria
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
