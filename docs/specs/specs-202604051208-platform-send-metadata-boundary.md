# Typed Platform Send Metadata Boundary

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

Platform-send state is still stored as ad hoc keys inside `thread.record.metadata`.

Even after the recent attempt-id addition, the behavior relies on a mix of:

- exported string constants
- bespoke read helpers
- bespoke write helpers
- direct knowledge of persisted metadata keys

This makes the persistence boundary harder to evolve safely and increases the
chance of partial updates or mismatched assumptions when more code paths start
depending on the same metadata.

## Context

- `CorrespondenceThreadRecordSchema` intentionally keeps `metadata` as an open
  `Record<string, unknown>`.
- Platform-send confirmation state currently uses these keys:
  - provider send attempt id
  - provider send email id
  - provider send observed-at timestamp
  - provider send message id
  - `threadStartedPublishedAt`
- Existing public exports such as
  `readPlatformSendSuccessMetadata(...)` are already used in tests and recovery
  flows and should not break immediately.
- This spec must stay migration-free and must remain backward-compatible with
  legacy rows.

## Decision

Introduce one typed metadata boundary dedicated to platform-send thread state,
and make all existing helpers delegate to it.

### 1. Add one metadata module in `core/`

Create:

- `src/modules/institution-correspondence/core/platform-send-thread-metadata.ts`

Export:

- `PlatformSendThreadMetadataSchema`
- `PlatformSendThreadMetadata`
- `PlatformSendThreadMetadataPatchSchema`
- `readPlatformSendThreadMetadata(record)`
- `writePlatformSendThreadMetadata(record, patch)`

The raw persisted key names are defined only in this module and are not exported.

### 2. The schema models the known subset only

`PlatformSendThreadMetadataSchema` represents only the platform-send-owned
fields:

- `providerSendAttemptId`
- `providerSendEmailId`
- `providerSendObservedAt`
- `providerSendMessageId`
- `threadStartedPublishedAt`

The schema validates the extracted subset after key filtering. It does not claim
ownership over unrelated metadata fields stored on the same thread record.

### 3. Read and write behavior

`readPlatformSendThreadMetadata(record)`:

- filters `record.metadata` down to the known keys
- validates values
- normalizes invalid or missing fields to `null`
- never throws

`writePlatformSendThreadMetadata(record, patch)`:

- starts from the current typed read result
- applies the patch
- writes only normalized known keys back into `record.metadata`
- preserves unrelated metadata keys unchanged

### 4. Existing confirmation helpers become wrappers

Keep the current public helpers, but reimplement them as thin wrappers over the
typed metadata module:

- `readPlatformSendSuccessMetadata(...)`
- `withPlatformSendAttemptMetadata(...)`
- `withPlatformSendSuccessMetadata(...)`
- `markPlatformSendSuccessConfirmed(...)`
- `hasPlatformSendSuccessConfirmation(...)`
- `buildReconcilePlatformSendSuccessInputFromThread(...)`

This preserves the current module API while making the typed metadata boundary
the only owner of serialization details.

### 5. Module ownership rules

After this refactor:

- no other module reads raw platform-send metadata keys directly
- no other module writes platform-send metadata keys directly
- tests that need platform-send metadata use the public typed helpers or the
  wrapper helpers

## Alternatives Considered

### Leave the current helper set as-is

Rejected because it still leaks persistence details through exported constants
and helper-specific write behavior.

### Move metadata into dedicated DB columns now

Rejected for this spec because that belongs to the later first-class send
attempt design. This iteration intentionally preserves the existing persisted
JSON shape.

### Replace the existing public helper names immediately

Rejected because it would force a broad API churn without functional benefit.
Wrapper compatibility is cheaper and safer in this pass.

## Consequences

**Positive**

- There is one owned serialization boundary for platform-send metadata.
- Invalid or partial persisted values are handled in one place.
- Future migration work can target one module instead of many scattered helpers.
- Existing consumers can keep their current helper imports during the transition.

**Negative**

- The module adds an extra abstraction layer before the later send-attempt model
  supersedes some of this state.
- Wrapper compatibility means two naming layers exist temporarily.
- The boundary must be kept tightly scoped so it does not turn into a general
  metadata dumping ground.

## References

- `src/modules/institution-correspondence/core/usecases/platform-send-success-confirmation.ts`
- `src/modules/institution-correspondence/core/usecases/send-platform-request.ts`
- `src/modules/institution-correspondence/core/usecases/reconcile-platform-send-success.ts`
- `src/modules/institution-correspondence/core/usecases/recover-platform-send-success-confirmation.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/modules/institution-correspondence/core/types.ts`
