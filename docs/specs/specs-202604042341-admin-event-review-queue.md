# Admin Event Review Queue

**Status**: Draft
**Date**: 2026-04-04
**Author**: Codex

## Implementation update

As of 2026-04-11, `learning_progress.review_pending` has been retired. The
live queue-backed workflow retained from this design is
`institution_correspondence.reply_review_pending`. References below to the
learning-progress queue remain historical design context unless reintroduced by
a future spec.

## Problem

The server already has multiple places where admin work accumulates, but it does
not have one consistent contract for turning those pending conditions into a
reviewable queue.

Today the actionable data is spread across canonical tables such as:

- `UserInteractions`
- `InstitutionEmailThreads`
- `resend_wh_emails`
- notification delivery and outbox tables

The application is missing a shared way to:

- enqueue an admin task from a minimal event reference
- re-scan canonical tables when queue publish fails or is skipped
- read queued items without consuming them
- export complete AI-ready context locally for manual review
- validate a machine-readable admin outcome before applying it
- re-read live DB state and safely mutate the canonical rows that resolve the task

Without a written contract, each admin workflow would invent its own queue
payloads, lookup logic, review artifacts, and apply semantics. That would make
the module hard to extend and unsafe to automate.

## Context

- The source of truth must remain the existing canonical tables. This direction
  intentionally does not add a dedicated `admin_tasks` table.
- Most admin events are row-backed and can be referenced by stable identifiers
  such as `threadId`, `userId + recordKey`, `storedEventId`, or `outboxId`.
- Admin work in this module is not fire-and-forget background processing. The
  operator must inspect the exported context and manually review the result
  before any write is applied.
- Reading an event must not remove it from the queue.
- The operator model is explicitly single-operator in v1, so no shared leasing,
  claiming, or reviewer-assignment state is required yet.
- Local JSON files are needed as review artifacts for AI-assisted processing,
  but those files must not become the authoritative workflow state.
- The codebase already has queue modules that use a core/shell split and
  deterministic BullMQ job ids:
  - `user-events`
  - `notification-delivery`
- Existing admin flows already re-read current state before mutating it:
  - learning-progress review resolves a pending record only after checking the
    live row and `expectedUpdatedAt`
  - institution reply review mutates the current thread phase only when the
    thread is still reviewable

## Decision

Adopt a row-referenced admin-event module where:

- canonical state stays in existing DB tables
- the queue stores only minimal event references
- event definitions own their own scan, context-load, and apply logic
- local JSON exports are review artifacts only
- validated `outcome` files drive deterministic apply logic

### 1. Introduce an `admin-events` module with a registry of event definitions

Each admin event type will be declared independently and registered in one
central module.

Each definition must declare:

- `eventType` constant
- `payload` TypeBox schema
- `outcome` TypeBox schema
- top-of-file comments that explain when the event is used
- deterministic `jobId` builder
- `scanPending(...)`
- `loadContext(...)`
- `validateStillActionable(...)`
- `buildExportBundle(...)`
- `applyOutcome(...)`

The registry is the one place that maps an event type to its validation,
loading, export, and resolution behavior.

Example shape:

```ts
interface AdminEventDefinition<TPayload, TContext, TOutcome> {
  readonly eventType: AdminEventType;
  readonly payloadSchema: TSchema;
  readonly outcomeSchema: TSchema;

  getJobId(payload: TPayload): string;
  scanPending(deps: AdminEventDeps): Promise<readonly TPayload[]>;
  loadContext(deps: AdminEventDeps, payload: TPayload): Promise<Result<TContext, AdminEventError>>;
  validateStillActionable(
    deps: AdminEventDeps,
    payload: TPayload
  ): Promise<Result<void, AdminEventError>>;
  buildExportBundle(input: {
    payload: TPayload;
    context: TContext;
  }): AdminEventExportBundle<TPayload, TContext>;
  applyOutcome(
    deps: AdminEventDeps,
    input: { payload: TPayload; outcome: TOutcome }
  ): Promise<Result<AdminEventApplyResult, AdminEventError>>;
}
```

### 2. Keep queue payloads minimal and reference-only

The queue is not a secondary content store. It stores only enough data to find
the canonical record again.

Required queue envelope fields:

- `eventType`
- `schemaVersion`
- `payload`

The payload should contain only stable references, for example:

- learning-progress review item: `userId`, `recordKey`
- institution reply review item: `threadId`, `basedOnEntryId`
- unmatched inbound email item: `storedEventId`
- notification delivery recovery item: `outboxId`

The queue must not carry copied email bodies, full thread aggregates, rendered
HTML, or other bulky personal-data-heavy snapshots.

### 3. Use deterministic queue identity and non-destructive reads

Each event definition will derive a stable `jobId` from the canonical reference.
This allows:

- idempotent enqueue
- repeatable reconciliation scans
- safe re-queue after failures without duplicate active items

In v1, admin-event jobs are not auto-consumed by a resident application worker.
They remain in the queue until one of two things happens:

- the operator exports and reviews them, then applies a valid outcome
- the item is found to be no longer actionable and is explicitly removed or skipped

Listing or exporting queue items must not remove them from the queue.

### 4. Give each event type its own canonical-table scanner

Because there is no dedicated admin-event table, each event definition must own
its own reconciliation query.

`scanPending(...)` must:

- query the canonical table(s) for still-actionable rows
- convert each row into the minimal event payload
- enqueue the event using the same validation and `jobId` logic as direct publish

This scan path is the recovery mechanism when a producer fails to enqueue an
event at write time.

### 5. Export a local JSON bundle with full AI-ready context

The operator workflow starts from a queue item and creates a local export bundle.

The export bundle must contain:

- queue metadata:
  - `jobId`
  - `eventType`
  - `schemaVersion`
- the minimal queue `payload`
- the fully loaded event `context`
- export metadata:
  - `exportedAt`
  - `workspace`
  - optional `environment`
- the expected `outcomeSchema`, serialized to JSON Schema form
- optional event-specific processing instructions for the AI agent

The bundle must contain enough context for the AI to prepare a complete
resolution outcome without making ad hoc extra reads during the review step.

Local artifact layout is CLI-configurable. The default should be an untracked
local directory with one folder per exported job, for example:

- `input.json`
- `outcome.json`
- optional notes or logs

These files are review artifacts only. They do not replace the queue or the DB
as the system of record.

### 6. The AI result is called `outcome`

Each event type owns its own `outcome` schema. That schema should be explicit
enough that the apply step can validate it mechanically before any DB write is
attempted.

The `outcome` should be machine-readable and deterministic. Free-form reasoning
may be included as optional notes, but the apply path must depend only on
validated structured fields.

Examples:

- learning-progress review:
  - `decision: 'approve' | 'reject'`
  - `feedbackText?: string`
- institution reply review:
  - `resolutionCode`
  - `reviewNotes?: string | null`
- unmatched inbound email:
  - `resolution: 'link_to_thread' | 'create_thread' | 'ignore'`
  - event-specific references needed to perform that resolution

### 7. Apply outcomes against live state, not exported state

`applyOutcome(...)` must never trust only the exported bundle.

Before mutating anything, it must:

- re-read the live canonical row(s)
- confirm the event is still actionable
- validate concurrency and state preconditions
- reject stale outcomes safely

Typical preconditions include:

- current phase is still `pending`
- current thread phase is still `reply_received_unreviewed`
- current row still matches the referenced entry id
- for thread-based reply review, the referenced reply is still the latest inbound
  reply that owns the pending decision for that thread
- current `updatedAt` or equivalent freshness marker has not changed in a way
  that invalidates the reviewed outcome

If the current state is stale, `applyOutcome(...)` must return a non-applied
result and leave the queue item in place for refresh or manual dismissal.

### 8. Remove queue items only after successful canonical writes

Queue removal happens only after the authoritative DB mutation succeeds.

The apply flow is therefore:

1. validate the outcome against the event-specific `outcomeSchema`
2. re-read live context
3. run event-specific mutation logic, preferably transactionally
4. remove the queue job only after the mutation commits successfully

If outcome validation fails or the live state is stale:

- no canonical write occurs
- the queue item remains available

If the canonical write already happened earlier but queue cleanup fails on a
retry path:

- the apply flow returns success with `queueCleanupPending = true`
- a later retry may perform queue cleanup only
- retries must not turn an already-applied outcome back into an error

### 9. Keep event-specific table knowledge inside the event definition

The central queue module should not know how to inspect every domain table.

Instead:

- the queue adapter knows only how to validate payloads and enqueue/list/remove jobs
- each event definition knows how to:
  - scan its canonical tables
  - load context from those tables
  - apply its own outcome

This keeps the design independent and readable while avoiding a giant
cross-domain admin switch statement.

## Alternatives Considered

### 1. Add a dedicated `admin_tasks` table

Rejected for v1 because:

- it would duplicate pending-work state outside the canonical tables
- the queue plus canonical row references are sufficient for the current
  single-operator workflow
- most actionable items already exist naturally as unresolved rows in domain tables

This may be revisited later if the workflow needs shared reviewer state, audit
history for review sessions, or multi-operator coordination.

### 2. Store full context snapshots in the queue payload

Rejected because:

- the payload would become large and stale quickly
- it would duplicate personal and correspondence data in Redis
- event handlers already need to trust live DB state at apply time anyway

### 3. Let a background worker consume and resolve admin items automatically

Rejected because:

- the operator must manually review exported context before writes happen
- reading the queue must not destroy the pending item
- AI-generated outcomes must be validated and reviewed before mutation

### 4. Use local JSON files as the workflow source of truth

Rejected because:

- local files are operator artifacts, not shared canonical state
- they can drift from the live database
- they are appropriate for review input/output, but not for authoritative task state

## Consequences

**Positive**

- canonical data remains in the existing domain tables
- queue payloads stay small and privacy-aware
- each event definition becomes self-contained and readable
- export bundles can include enough context and the exact expected outcome schema
  for AI-assisted review
- reconciliation scans make queueing recoverable when direct publish fails
- apply logic remains safe because it re-checks live state before writing
- the design fits the existing core/shell and queue patterns in the codebase

**Negative**

- BullMQ is being used as a review queue index rather than a normal
  auto-consuming job stream, so the tooling must make that contract explicit
- without a dedicated table, reviewer state is not shared; in v1 that is
  acceptable only because the workflow is single-operator
- each event type must implement its own scan, context loader, and apply logic,
  so there is more per-event code than a generic table-driven approach
- local export artifacts are operationally useful but not centrally visible
- stale exported bundles are expected and must be handled as a first-class case

## References

- `src/modules/user-events/core/ports.ts`
- `src/modules/user-events/shell/queue/publisher.ts`
- `src/modules/user-events/shell/queue/job-options.ts`
- `src/modules/learning-progress/core/usecases/update-interaction-review.ts`
- `src/modules/learning-progress/shell/rest/admin-routes.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `src/modules/institution-correspondence/shell/rest/admin-routes.ts`
- `src/modules/institution-correspondence/core/usecases/review-reply.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/app/public-debate-self-send-context-lookup.ts`
- `docs/specs/specs-202603311636-user-events-module.md`
- `docs/specs/specs-202603311900-institution-email-flow.md`
- `docs/specs/specs-20260325-public-debate-correspondence-v1.md`
