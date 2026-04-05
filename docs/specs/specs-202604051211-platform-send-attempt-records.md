# First-Class Platform Send Attempt Records

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

Platform-send attempts are still modeled indirectly through thread metadata plus
thread correspondence entries.

That is enough for the current single-send flow, but it is not a durable source
of truth for:

- multiple outbound emails in one thread
- retrying one logical send without confusing it with a new send
- reconciling provider evidence to one precise send attempt
- future reminder or follow-up behavior

The thread is a conversation container, not a send-attempt record.

## Context

- The recent idempotency fix added `providerSendAttemptId` to thread metadata and
  uses it as the provider idempotency key.
- Webhook and recovery flows still infer send state from:
  - thread metadata
  - correspondence entries
  - provider evidence
- This second-pass spec is intentionally later than the orchestrator and metadata
  cleanup so those lower-risk refactors can land first.
- This is the only spec in this set that may require a DB migration.

## Decision

Introduce a first-class platform-send attempt model backed by a new table and a
dedicated repository.

### 1. Add a dedicated attempt repository

Create a new port in `src/modules/institution-correspondence/core/ports.ts`:

```ts
PlatformSendAttemptRepository;
```

Required methods:

- `createPlatformSendAttempt(...)`
- `markPlatformSendAttemptSent(...)`
- `markPlatformSendAttemptFailed(...)`
- `findLatestPlatformSendAttemptForThread(threadId)`
- `findPlatformSendAttemptByIdempotencyKey(providerIdempotencyKey)`
- `findPlatformSendAttemptByResendEmailId(resendEmailId)`

Create a shell implementation:

- `src/modules/institution-correspondence/shell/repo/platform-send-attempt-repo.ts`

### 2. Add a dedicated table

Add a user DB migration creating:

- `institutionemailsendattempts`

Columns:

- `id UUID PRIMARY KEY`
- `thread_id UUID NOT NULL REFERENCES institutionemailthreads(id) ON DELETE CASCADE`
- `provider_idempotency_key UUID NOT NULL UNIQUE`
- `status TEXT NOT NULL`
- `from_address TEXT NOT NULL`
- `to_addresses JSONB NOT NULL`
- `cc_addresses JSONB NOT NULL`
- `bcc_addresses JSONB NOT NULL`
- `subject TEXT NOT NULL`
- `text_body TEXT NULL`
- `html_body TEXT NULL`
- `headers JSONB NOT NULL`
- `attachments JSONB NOT NULL`
- `resend_email_id TEXT NULL UNIQUE`
- `provider_message_id TEXT NULL`
- `sent_at TIMESTAMPTZ NULL`
- `failure_message TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

`status` values for this spec:

- `pending`
- `sent`
- `failed`

### 3. Request path creates the attempt first

Update `sendPlatformRequest(...)` so that it:

1. creates the thread
2. creates a `pending` attempt row with the outbound payload snapshot
3. sends the provider request with `provider_idempotency_key`
4. marks the attempt `sent` or `failed`
5. continues reconciling the thread from the attempt record

The provider idempotency key is taken from the attempt row, not from thread
metadata.

### 4. Reconcile, webhook, and recovery use attempts as source of truth

Update reconcile and webhook flows so they load the relevant attempt first:

- immediate send success path passes the newly created attempt id
- webhook success looks up by `resend_email_id`
- recovery looks up the latest attempt for the thread

The attempt row becomes the canonical source of:

- provider idempotency key
- outbound email payload snapshot
- provider message id
- resend email id
- final send state

Thread state remains derived conversation state.

### 5. Keep thread metadata as transitional compatibility only

Thread metadata remains during rollout, but only as a compatibility layer.

New writes:

- still populate metadata for backward compatibility with existing code paths and
  observability

New reads:

- prefer attempt rows
- fall back to legacy metadata only when no attempt exists yet

### 6. Lazy legacy materialization instead of bulk backfill

Do not run a one-shot backfill migration over all historical rows.

Instead, add a lazy materialization helper:

- `materializeLegacyPlatformSendAttemptFromThread(thread)`

When recovery or webhook handling encounters a legacy thread with:

- no attempt rows
- enough existing metadata/correspondence evidence

the code creates one synthetic `sent` attempt row from the thread’s stored
outbound evidence and continues with the new flow.

This keeps rollout safe without a separate batch job.

## Alternatives Considered

### Keep thread metadata as the long-term source of truth

Rejected because it cannot cleanly model multiple attempts per thread and keeps
send state mixed with thread state.

### Add more metadata fields but no new table

Rejected because it only deepens the current ambiguity. The missing concept is a
first-class attempt record, not more metadata keys.

### Perform a mandatory bulk backfill migration

Rejected because the existing historical volume and rollout timing do not justify
a large one-shot migration when lazy materialization can preserve correctness.

## Consequences

**Positive**

- One logical outbound send has one durable record.
- Multiple outbound emails in one thread become modelable without abusing thread
  metadata.
- Retry semantics become explicit and provider correlation becomes simpler.
- Recovery and webhook logic can target one canonical attempt row.

**Negative**

- This is the highest-risk change in the set and requires a schema migration.
- Correspondence flows will temporarily support both attempt rows and legacy
  metadata.
- Repository and test surface area increase substantially.

## References

- `src/modules/institution-correspondence/core/usecases/send-platform-request.ts`
- `src/modules/institution-correspondence/core/usecases/reconcile-platform-send-success.ts`
- `src/modules/institution-correspondence/core/usecases/recover-platform-send-success-confirmation.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/modules/institution-correspondence/core/usecases/platform-send-success-confirmation.ts`
- `src/infra/database/user/migrations`
- `docs/specs/specs-202604051208-platform-send-metadata-boundary.md`
