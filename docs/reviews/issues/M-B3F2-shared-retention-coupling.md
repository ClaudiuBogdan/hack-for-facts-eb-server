# B3-F2 — Retention worker deletes ALL >90d rows from the shared `resend_wh_emails` table used by other consumers for correlation

|                       |                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Original severity** | Medium                                                                                                                                                                                                                                                                                                       |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium)                                                                                                                                                                                                                                                                      |
| **Confidence**        | CONFIRMED                                                                                                                                                                                                                                                                                                    |
| **Domain**            | correctness · architecture · privacy                                                                                                                                                                                                                                                                         |
| **Modules / files**   | `src/modules/notification-platform/shell/retention/apply-retention.ts:51-60`, `src/modules/institution-correspondence/shell/repo/platform-send-success-evidence-lookup.ts`, `src/modules/campaign-admin-stats/shell/repo/campaign-admin-stats-repo.ts:555-565`, `src/infra/database/user/schema.sql:387-426` |
| **Fix effort**        | M                                                                                                                                                                                                                                                                                                            |
| **Merge-blocker?**    | owner-call                                                                                                                                                                                                                                                                                                   |

## TL;DR

The notification-platform retention worker unconditionally deletes every `resend_wh_emails` row older than its own 90-day "detailed retention" cutoff. But `resend_wh_emails` is explicitly a **"generic shared Resend email event store"** (schema comment) read by at least two _other_ subsystems that need a longer correlation window: institution-correspondence reconciliation (looks up the latest successful send by `thread_key`) and campaign-admin-stats (joins engagement events by `email_id` for lifetime campaign stats). One module's retention policy is silently applied to a shared table it doesn't own, deleting rows the other consumers still depend on. Fix: gate deletion on "no consumer still needs this row" (or give each consumer its own retention horizon), rather than a blanket 90-day sweep.

## Evidence (re-verified against current code)

The blanket delete — `apply-retention.ts:51-60`:

```
const providerWebhooks = await sql`
  DELETE FROM resend_wh_emails
  WHERE id IN (
    SELECT id FROM resend_wh_emails
    WHERE webhook_received_at < ${detailedCutoff}   -- now - 90 days
    ORDER BY webhook_received_at, id
    LIMIT ${input.batchLimit}
  )`.execute(db);
```

`detailedCutoff = now - DETAILED_RETENTION_MS`, and `DETAILED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000` (`apply-retention.ts:9,37`). The predicate is purely age-based — **no `NOT EXISTS` guard** checking whether any other consumer still references the row (contrast the _other_ deletes in the same file, e.g. `notification_deliveries` at lines 77-91 and `logical_notifications` at 114-133, which _do_ guard with `NOT EXISTS`). The shared table is the one table deleted with no such guard.

The table is declared shared — `schema.sql:387-388`: `-- resend_wh_emails: generic shared Resend email event store`.

Consumer 1 — institution-correspondence reconciliation reads it by `thread_key` for send evidence — `platform-send-success-evidence-lookup.ts:26-44`:

```
.selectFrom('resend_wh_emails')
.select(['thread_key','email_id','message_id','email_created_at', ... 'subject'])
.where('thread_key', '=', threadKey)
.where('event_type', 'in', ['email.sent', 'email.delivered'])
.orderBy('email_created_at', 'desc')
```

This is `findLatestSuccessfulSendByThreadKey`, feeding `reconcile-platform-send-success` — reconstructing send confirmation for correspondence threads. A thread older than 90 days loses its send evidence.

Consumer 2 — campaign-admin-stats joins engagement events by `email_id` for campaign lifetime stats — `campaign-admin-stats-repo.ts:559-565`:

```
left join resend_wh_emails as emails
  on emails.email_id = outbox.resend_email_id
group by outbox.id
```

computing `has_delivered/has_complained/has_opened/has_clicked` per outbox message. Campaigns older than 90 days silently lose all engagement signal (opens/clicks/complaints), understating delivered/engagement counts.

Other touchers confirm shared ownership: `resend-webhooks/.../resend-webhook-email-events-repo.ts` (writer), `clerk-webhooks/.../user-data-anonymizer.ts` (anonymizes rows on account deletion). The `institutionemailthreads` table (`institution-correspondence-repo.ts`) correlates by `thread_key` — the same key `resend_wh_emails` is indexed on (`idx_resend_wh_emails_thread_key`, `schema.sql:426`), reinforcing that correspondence reconciliation is meant to join against these rows.

## Root cause

`resend_wh_emails` has no single owning module, but the retention logic lives inside `notification-platform` and reuses that module's `DETAILED_RETENTION_MS` (a policy meaningful for _its own_ `notification_delivery_attempts`) as the deletion horizon for the shared table. The delete is written as a pure age sweep, omitting the `NOT EXISTS`-style "still referenced?" guard that every other delete in the same worker uses. So a policy scoped to one subsystem is enforced globally on a cross-cutting table.

## Blast radius & impact

- Affected data: all Resend webhook events (`email.sent/delivered/opened/clicked/complained/bounced`) older than 90 days, deleted regardless of downstream need.
- Consumer 1 (institution-correspondence): reconciliation of any correspondence thread whose last successful send is >90 days old returns `null` send evidence → send-success confirmation cannot be recovered after a crash/gap for long-running threads. Public-debate correspondence threads are exactly the kind that stay open for months.
- Consumer 2 (campaign-admin-stats): lifetime campaign engagement metrics silently decay — a campaign's delivered/opened/clicked/complained counts drop as its webhook rows age out past 90 days, producing wrong historical stats with no error.
- Compliance-adjacent: `email.complained` (spam-complaint) and bounce events are suppression-relevant; deleting them at 90 days can also lose the record needed to justify not re-emailing an address.
- Fires: every retention run (whenever the worker is scheduled) once rows cross 90 days. It is a steady data-loss drip, not a one-off.
- Bounding: the two documented consumers mostly _tend_ to query recent rows, so many workloads never notice; the harm concentrates on long-lived threads and historical/lifetime aggregates. Hence Medium, not High. Note the delete is also `LIMIT`-batched, so loss is gradual rather than instantaneous.

## Reproduction / falsifiable scenario

1. Insert a `resend_wh_emails` row (`event_type='email.delivered'`, `thread_key='T1'`, `webhook_received_at = now - 100d`).
2. Run `applyRetention({ batchLimit: 1000, now })`.
3. `findLatestSuccessfulSendByThreadKey('T1')` now returns `null` (evidence gone); a campaign-admin-stats query joining that `email_id` now reports `has_delivered=false`.
   Contrast: the same scenario against `notification_deliveries` is safe because that delete guards `NOT EXISTS (delivery_attempts...)` — the shared-table delete has no analogous guard.

## Additional context discovered

- The worker already demonstrates the correct pattern for shared/referenced rows (`NOT EXISTS` guards on `notification_deliveries`, `notification_digest_batches`, `logical_notifications`) — the shared-table delete is the outlier that skips it.
- `clerk-webhooks/user-data-anonymizer.ts` already _anonymizes_ (not deletes) `resend_wh_emails` on account erasure, i.e. there is an established, less-destructive treatment for PII in this table that retention could mirror (redact PII columns, keep correlation keys) instead of hard-deleting.
- Longer horizons are clearly intended elsewhere: `digestBatches` uses a **2-year** window (`apply-retention.ts:98`). The 90-day figure is specific to `notification_delivery_attempts`, not to a shared event store.
- No test covers cross-consumer correlation survival (`grep` shows no retention test asserting institution-correspondence/campaign-stats still resolve after a retention run).

## Fix options

**Option A (recommended) — guard the delete on "no consumer still needs it."**
Add a `NOT EXISTS` (or reference-count) predicate so a `resend_wh_emails` row is only deleted when it is not the latest send evidence for any open `institutionemailthreads`/correspondence thread and not referenced by a within-retention campaign outbox. Mirrors the existing guarded deletes in the same file. Trade-off: the correlation predicate spans modules — either encode it in SQL here (couples the worker to other schemas) or expose a shared "retainable email ids" view.

**Option B — separate retention horizons / redact instead of delete.**
Give the shared store its own, longer retention (e.g. align with the correspondence/stats needs, or the 2-year digest horizon) and/or _redact_ PII columns (`from_address`, `to_addresses`, `subject`) after 90 days while keeping correlation keys (`email_id`, `thread_key`, `event_type`, timestamps) — the same anonymize-don't-delete approach `user-data-anonymizer.ts` already uses on this table. Preserves reconciliation + stats while satisfying the privacy intent behind the 90-day cut. Prefer B if the 90-day cutoff was motivated by PII minimization rather than storage.

Pin with a test: seed a >90d delivered row that is the latest evidence for an open thread + referenced by a campaign; run retention; assert the row survives (Option A) or that only PII columns are nulled (Option B).

## Related

- Sibling notification-platform retention findings (B3 cluster) — same worker.
- Erasure findings (A3/H1) — both concern what actually gets removed vs. retained across shared Resend tables; Option B ties this to the existing anonymizer approach.
- Main report: notification-platform retention / shared-table ownership section.
