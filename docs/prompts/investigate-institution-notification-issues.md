# Investigation & Fix Plan: Institution Email Notification System

## Background & Context

We have a public debate request system where users can request our platform to send emails to public institutions (city halls) on their behalf. The system enforces a **"one email per institution per campaign"** constraint to prevent spam.

### Key Components

1. **Institution Correspondence Module** (`src/modules/institution-correspondence/`)
   - Manages email threads with institutions
   - Stores thread state in `InstitutionEmailThreads` table
   - Enforces unique constraint: `(entity_cui, campaign_key)` for `platform_send` threads

2. **Notification Delivery Pipeline** (`src/modules/notification-delivery/`)
   - 3-stage queue system: COLLECT → COMPOSE → SEND
   - Rate limited to 2 req/sec (Resend API limit)
   - Uses outbox pattern for idempotency

3. **Public Debate Entity Updates** (`funky:notification:entity_updates`)
   - Users subscribe to receive updates about institution correspondence
   - Events: `thread_started`, `thread_failed`, `reply_received`, `reply_reviewed`

## Issues Identified

### Issue 1: Late Subscribers Don't Receive Current State Email

**Problem**: When a user subscribes to an institution after the initial email has been sent, they are NOT notified of the current thread state. They only receive emails for future events.

**Current Behavior**:

- User subscribes via `ensureSubscribed()` → creates notification subscription record
- No immediate email is sent about current thread state
- User only receives `reply_received`, `reply_reviewed` events going forward

**Expected Behavior**:

- If thread is in `awaiting_reply` phase → send "Email sent, awaiting response"
- If thread is `closed` with reply → send email with final state
- If thread `failed` → send "Email failed to send"
- Must NOT re-send to users who already received a previous status update

**Key Files**:

- `src/modules/notifications/core/usecases/ensure-public-debate-auto-subscriptions.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts`

### Issue 2: Idempotency Key Blocks Follow-up Emails to Institution

**Problem**: The system uses `thread.id` as the Resend idempotency key when sending emails to institutions. This blocks any follow-up emails (reminders, additional messages) within the same thread.

**Current Code** (`src/modules/institution-correspondence/core/usecases/send-platform-request.ts:140`):

```typescript
idempotencyKey: thread.id,  // Only allows ONE email per thread
```

**Expected Behavior**:

- Each unique email send attempt should have a unique idempotency key
- Should support follow-up emails if business logic requires them
- Must still prevent duplicate sends of the same email

**Potential Solutions**:

- Option A: Use correspondence entry ID in idempotency key: `${thread.id}:${entryId}`
- Option B: Use timestamp + sequence: `${thread.id}:${Date.now()}:${sequence}`
- Option C: Use UUID per email attempt: `randomUUID()` (with delivery record tracking)

### Issue 3: Missing Compose Job Enqueue When Runtime Unavailable

**Problem**: In `build-app.ts`, the `composeJobScheduler` is conditionally passed. If the runtime is unavailable, outbox records are created but no compose job is enqueued, causing delays until the recovery worker picks them up.

**Current Code** (`src/app/build-app.ts:1552-1554`):

```typescript
...(notificationDeliveryRuntime?.composeJobScheduler !== undefined
  ? { composeJobScheduler: notificationDeliveryRuntime.composeJobScheduler }
  : {}),
```

**Expected Behavior**:

- Always enqueue compose jobs when notifications are created
- Either ensure runtime is always available, or implement fallback

## Investigation Tasks

1. **Trace the Late Subscriber Flow**:
   - Start at `ensureSubscribed()` in `build-app.ts`
   - Follow through to `ensurePublicDebateAutoSubscriptions()`
   - Identify where the "current state snapshot" email should be triggered
   - Check if we need to query the thread state at subscription time

2. **Analyze Idempotency Key Usage**:
   - Review all places where `idempotencyKey` is set
   - Understand Resend's idempotency behavior (24-hour window?)
   - Determine if the unique constraint on threads is sufficient protection
   - Decide on best idempotency key strategy

3. **Review Queue Pipeline**:
   - Understand the 3-stage pipeline: COLLECT → COMPOSE → SEND
   - Check the rate limiting in `send-worker.ts`
   - Verify that `composeJobScheduler.enqueue()` is always called

4. **Check Delivery Key Uniqueness**:
   - Review `generateDeliveryKey()` function
   - Ensure it properly prevents duplicate notifications
   - Verify `scopeKey` includes event-specific identifiers

## Deliverables

Please provide:

1. **Root Cause Analysis** (2-3 paragraphs per issue)
   - Why each issue occurs
   - What assumptions in the current design led to these gaps

2. **Fix Plan** with the following for each issue:
   - **Option A**: Minimal change approach
   - **Option B**: Robust approach (recommended)
   - **Selected approach** with justification
   - **Files to modify**
   - **New files to create** (if any)
   - **Database changes** (if any)
   - **Test cases** to add/update

3. **Implementation Order**:
   - Priority ranking (which issue to fix first)
   - Dependencies between fixes
   - Risk assessment for each fix

4. **Verification Strategy**:
   - How to test each fix
   - Edge cases to consider
   - Monitoring/alerting recommendations

## Constraints & Considerations

- The system uses **Result<T,E> pattern** (neverthrow) - no throws in core/
- **No floats** - use decimal.js for calculations
- **Strict booleans** - always use explicit checks (`amount !== 0`)
- **Database unique index**: `(entity_cui, campaign_key)` for active platform_send threads
- **Resend API limit**: 2 requests/second
- **Architecture**: `core/` = pure logic, `shell/` = adapters, `infra/` = infrastructure

## Key Files Reference

```
src/modules/institution-correspondence/
  core/usecases/send-platform-request.ts          (Issue 2)
  core/usecases/request-public-debate-platform-send.ts
  shell/repo/institution-correspondence-repo.ts

src/modules/notifications/
  core/usecases/ensure-public-debate-auto-subscriptions.ts  (Issue 1)
  core/usecases/subscribe-to-public-debate-entity-updates.ts

src/modules/notification-delivery/
  core/usecases/enqueue-public-debate-entity-update-notifications.ts  (Issue 1)
  shell/queue/workers/send-worker.ts                  (rate limiting verification)
  shell/queue/compose-job-scheduler.ts

src/app/build-app.ts                                  (Issue 3)
```

## Success Criteria

- [ ] Late subscribers receive immediate "current state" email upon subscription
- [ ] Idempotency keys allow for potential future follow-up emails (even if not used now)
- [ ] Compose jobs are always enqueued when notifications are created
- [ ] All fixes follow the existing architecture patterns (Result types, no throws in core)
- [ ] Unit tests cover edge cases (duplicate prevention, race conditions)
- [ ] Integration tests verify end-to-end flow

---

Please investigate thoroughly and provide a detailed, actionable fix plan.
