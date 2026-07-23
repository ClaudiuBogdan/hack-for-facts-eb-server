# H1 — Clerk erasure never redacts `resend_wh_emails` rows for platform-sent emails

|                       |                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | High                                                                                                                                                                                   |
| **Verified verdict**  | Confirmed · Severity unchanged                                                                                                                                                         |
| **Confidence**        | CONFIRMED                                                                                                                                                                              |
| **Domain**            | erasure · privacy                                                                                                                                                                      |
| **Modules / files**   | `src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts`; `src/infra/database/user/schema.sql`; `src/modules/notification-platform/shell/retention/apply-retention.ts` |
| **Fix effort**        | S                                                                                                                                                                                      |
| **Merge-blocker?**    | yes                                                                                                                                                                                    |

## TL;DR

On Clerk `user.deleted`, the anonymizer redacts `resend_wh_emails` rows only for emails sent through the two **legacy** paths (`notificationsoutbox`, `institutionemailthreads`). Emails sent through the **new notification platform** land their Resend id in `notification_deliveries.provider_ref` / `notification_delivery_attempts.provider_ref`, and that id is **never** collected into the redaction set. So a deleted user's raw recipient address (`to_addresses`) and email `subject` survive in `resend_wh_emails` until the 90-day retention sweep deletes the row — a GDPR erasure miss that directly contradicts `docs/USER-DATA-ANONYMIZATION.md:51`. Fix: collect `provider_ref` from platform deliveries+attempts before nulling them and feed those ids into `updateResendWebhookEvents`.

## Evidence (re-verified against current code)

**The redaction set is built from legacy sources only.** `anonymizeDeletedUserInTransaction` builds `resendEmailIds` at `user-data-anonymizer.ts:867-877` from exactly two sources:

- `notificationsoutbox.resend_email_id` (the row set selected at `:832-836`)
- `institutionemailthreads.record` → any `resendEmailId` string key (`:873-876`, via `collectStringValuesByKey`)

There is no third source. `notification_deliveries.provider_ref` and `notification_delivery_attempts.provider_ref` are never read into this set.

**Redaction only touches rows whose `email_id` is in that set.** `updateResendWebhookEvents` (`:543-586`) does `where('email_id', 'in', emailIds)` (`:556`) and returns `0` immediately if the set is empty (`:549-551`). Any `resend_wh_emails` row not keyed by a legacy id is left fully intact.

**The platform path's Resend id lives in `provider_ref`, and that column is nulled — not harvested.** `anonymizeNotificationPlatformRows` (`:699-822`) NULLs `notification_delivery_attempts.provider_ref` (`:708`) and `notification_deliveries.provider_ref` (`:730`). It never collects those values first.

**How a platform email's Resend id reaches `resend_wh_emails` (chain confirmed end-to-end):**

1. Platform send → `email-channel-adapter.ts:288-290` returns `{ classification: 'accepted', providerRef: sent.value.emailId }` (the Resend email id).
2. That `providerRef` is persisted to `notification_deliveries.provider_ref` (`dispatch-delivery.ts:306,319`; written via `delivery-repo.ts:44,204`) and to attempts (`delivery-attempt-repo.ts:48`).
3. Resend then POSTs webhook events for the **same** email id; the resend-webhooks module inserts one `resend_wh_emails` row per event, keyed by `email_id = event.data.email_id` (`resend-webhook-email-events-repo.ts:129-133`, mapper populates `email_id`, `to_addresses`, `subject`, …).
4. So `resend_wh_emails.email_id == notification_deliveries.provider_ref`. The only join key that would let the anonymizer find these rows is `provider_ref` — the exact value it discards.

**PII columns on `resend_wh_emails` that survive** (schema `src/infra/database/user/schema.sql:388-416`), i.e. everything `updateResendWebhookEvents` _would_ have cleared but doesn't for platform rows:

- `to_addresses TEXT[] NOT NULL` (`:396`) — the deleted user's raw recipient email
- `from_address TEXT NOT NULL` (`:395`)
- `cc_addresses`, `bcc_addresses` (`:397-398`)
- `subject TEXT NOT NULL` (`:400`) — often contains user/notification context
- `message_id` (`:399`), `attachments_json` (`:405`), `bounce_message`/`bounce_diagnostic_code` (`:408-409`), `click_ip_address`/`click_link`/`click_user_agent` (`:410-413`), and `metadata` (`:415`).
- Note: there is **no** email body column on this table, so message body is not exposed here — only headers/addresses/subject/click telemetry.

**The 90-day TTL is the only thing that ever deletes them.** `apply-retention.ts:9` `DETAILED_RETENTION_MS = 90 days`; `:51-60` deletes `resend_wh_emails WHERE webhook_received_at < now-90d`. The cutoff is per-row on `webhook_received_at`, so PII lingers ~90 days from the _last_ webhook event for that email (longer if a late `email.clicked`/bounce event lands, since each event is its own row with its own `webhook_received_at`).

**Doc it contradicts:** `docs/USER-DATA-ANONYMIZATION.md:51` states `resend_wh_emails` is treated on `user.deleted` by "Redact addresses and subject, clear message ID/attachments/bounce/click fields, sanitize metadata." That promise holds only for legacy-linked rows; it is silently false for every platform-sent email.

## Root cause

The anonymizer predates (or was never re-wired for) the notification-platform delivery ledger. Its `resend_wh_emails` join was designed around the legacy correlation keys (`notificationsoutbox.resend_email_id`, thread `resendEmailId`). When the platform introduced a second producer of Resend ids (`notification_deliveries.provider_ref`), the redaction set was not extended, and the same function that would have exposed those ids instead nulls them (`:708`, `:730`) — so the correlation key is destroyed inside the same transaction.

## Blast radius & impact

- **Who:** every deleted user who was ever sent at least one email through the notification platform (`email-channel-adapter`). Legacy-only recipients are unaffected (their rows redact correctly).
- **What survives:** raw recipient email address + subject (+ from/cc/bcc, click IP/UA, attachments metadata) in `resend_wh_emails`.
- **How many rows:** one row **per webhook event per email** (`email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, …), so typically several rows per delivered email, multiplied by every platform email the user received.
- **Duration:** up to ~90 days past the last webhook event; the row is not erased at deletion time as required, only swept later by retention.
- **Read exposure before TTL:** these rows are actively queried by live surfaces, so the un-redacted PII is reachable, not merely at-rest:
  - `institution-correspondence/shell/repo/platform-send-success-evidence-lookup.ts:26-63` selects `from_address`, `to_addresses`, `cc/bcc_addresses`, `subject` by `thread_key`.
  - `campaign-admin-stats/shell/repo/campaign-admin-stats-repo.ts:560-561` joins `resend_wh_emails.email_id = outbox.resend_email_id` (admin stats).
- **Bounding:** self-heals after ≤90 days via retention; requires the user to have received a platform email. Does not require config drift.

## Reproduction / falsifiable scenario

1. User `U` receives a notification-platform email → `notification_deliveries.provider_ref = re_abc`.
2. Resend posts `email.delivered` → `resend_wh_emails` row with `email_id='re_abc'`, `to_addresses=['u@example.com']`, `subject='Your ANAF alert'`.
3. Clerk `user.deleted` for `U` runs the anonymizer. `resendEmailIds` is built only from outbox/threads → does **not** contain `re_abc`. `updateResendWebhookEvents` skips the row.
4. Query `SELECT to_addresses, subject FROM resend_wh_emails WHERE email_id='re_abc'` → still returns `{u@example.com}` / `Your ANAF alert`.

**Existing test proves the blind spot rather than catching it.** `tests/e2e/user-data-anonymizer.test.ts`:

- The redacted `resend_wh_emails` fixture (`:291-304`, `email_id='email-<suffix>'`) is correlated via the **legacy** `notificationsoutbox.resend_email_id='email-<suffix>'` (`:121`). The assertions at `:852-862` (`to_addresses` → `[]`, etc.) pass because of the legacy linkage.
- The platform fixture inserts `notification_deliveries.provider_ref='private-provider-<suffix>'` (`:579`) and asserts only that the delivery's own `provider_ref` becomes `null` (`:988`, `:1016`). **No** `resend_wh_emails` row is seeded with `email_id='private-provider-<suffix>'`, so nothing exercises the platform→webhook correlation. The suite is green with the bug present.

## Additional context discovered

- **Same bug-class for cc/bcc?** No — within a _matched_ row, `updateResendWebhookEvents:562-580` already clears `cc_addresses`/`bcc_addresses`. The defect is purely _which rows match_, not which columns; once a platform row is matched, redaction is complete.
- **Other webhook-event tables?** `resend_wh_emails` is the only Resend webhook event store. `notification_delivery_attempts.provider_ref` is correctly nulled (`:708`); no sibling table leaks the same way.
- **Retries produce multiple ids.** Each delivery attempt can carry its own `provider_ref` (`delivery-attempt-repo.ts:48`), and a retry yields a new Resend email id → a distinct `resend_wh_emails` row. A correct fix must harvest `provider_ref` from **both** `notification_deliveries` and `notification_delivery_attempts`.
- **Ordering matters for the fix.** `updateResendWebhookEvents` runs at `:1013`, _before_ `anonymizeNotificationPlatformRows` (`:1018`) nulls `provider_ref`. Collecting the ids anywhere before `:1018` (e.g. alongside the outbox/thread collection at `:867-877`) is safe; doing it after would read only NULLs.

## Fix options

**Option A (recommended) — extend the redaction set with platform provider_refs.**
Before line `:1018`, collect `provider_ref` for the deleted user's deliveries and attempts and merge into `resendEmailIds`. Concrete query (Kysely `sql`, runs inside `trx`, uses the existing `matchingUserIds`):

```sql
SELECT DISTINCT provider_ref FROM (
  SELECT provider_ref
    FROM notification_deliveries
   WHERE user_id IN (:matchingUserIds) AND provider_ref IS NOT NULL
  UNION
  SELECT a.provider_ref
    FROM notification_delivery_attempts a
    JOIN notification_deliveries d ON d.id = a.delivery_id
   WHERE d.user_id IN (:matchingUserIds) AND a.provider_ref IS NOT NULL
) refs;
```

Add each non-empty `provider_ref` to the existing `resendEmailIds` set (dedupe is free — it's a `Set`). `updateResendWebhookEvents` then redacts platform rows exactly as it already does for legacy rows. Minimal, localized, no schema change.

**Option B — redact by a stored user linkage.** Persist `user_id` (or a fingerprint) onto `resend_wh_emails` at insert and redact `WHERE user_id IN (...)`. More robust against future producers but requires a schema/migration + backfill + write-path change; heavier and out of scope for a hotfix.

**Test to pin it (must fail before the fix):** in `tests/e2e/user-data-anonymizer.test.ts`, seed a `resend_wh_emails` row whose `email_id` equals a `notification_deliveries.provider_ref` (and one matching a `notification_delivery_attempts.provider_ref`) for the deleted user, with **no** legacy outbox/thread linkage, then assert `to_addresses === []` and `subject === 'Anonymized email'` after anonymization.

## Related

- Sibling: [H2](H2-erasure-false-success-audit.md) (erasure audit records success even when steps are incomplete) — compounds this: the audit row will report `resendWebhookEventsUpdated` reflecting only legacy rows, masking the gap.
- Main report: Erasure/privacy cluster.
