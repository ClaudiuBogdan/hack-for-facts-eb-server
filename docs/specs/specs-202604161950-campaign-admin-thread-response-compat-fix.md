# Campaign Admin Thread Response Compatibility Fix

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex

## Problem

The campaign-admin manual response append flow writes `record.adminWorkflow` but
does not keep shared low-level correspondence lifecycle fields aligned with the
parts of the system that still read them directly.

Two concrete problems exist today:

- terminal manual admin responses can leave low-level lifecycle state stale,
  which makes legacy readers continue to treat threads as open
- manual admin responses incorrectly advance `lastEmailAt`, even though that
  timestamp represents outbound send time rather than inbound reply time

This creates observable regressions in downstream readers, stats, and
background recovery/snapshot flows.

## Context

### Target Scope and Objectives

This change is limited to the campaign-admin institution-thread manual response
write path and the narrow shared readers needed to keep existing behavior
consistent.

Objectives:

- preserve the campaign-admin institution-thread DTO contract
- preserve optimistic concurrency and append-only admin response history
- restore correct timestamp semantics for manual admin responses
- make terminal manual admin responses surface as terminal to existing
  low-level lifecycle readers
- prevent stale `thread_started` / `reply_reviewed` background derivation for
  admin-resolved threads

Primary code areas:

- [`src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts)
- [`src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts)
- existing tests around append-response behavior, snapshot derivation, and
  downstream readers

### Constraints and Limitations

- keep the external campaign-admin institution-thread API unchanged
- do not introduce new privileged routes, env vars, or auth behavior
- do not invent a low-level compatibility mapping for
  `registration_number_received` in this patch
- do not synthesize fake `latestReview` data for manual admin responses
- prefer the narrowest reader changes needed to close confirmed regressions
- prioritize security and simplicity over broad lifecycle redesign

### Security Requirements

- preserve campaign scope verification and optimistic concurrency checks on the
  write path
- do not broaden data exposure or return additional raw correspondence fields
- do not manufacture fake review provenance that could be mistaken for a real
  reviewed reply
- keep background notification/snapshot behavior fail-closed when lifecycle
  state is not safely derivable
- avoid changes that could reopen or bypass the retired standalone admin
  surface

### Why This Matters Now

The new campaign-admin institution-thread API is already in the working tree and
introduces manual admin response recording. If shipped as-is, terminal admin
responses would be stored in `record.adminWorkflow` while several existing
readers continue to consume stale low-level phase data and stale outbound-send
timestamps.

## Decision

### Implementation Strategy

1. Keep `record.adminWorkflow` as the admin-facing source of truth for the new
   campaign-admin institution-thread API.
2. Preserve the current optimistic concurrency and append-only response-event
   model.
3. Fix manual response timestamp semantics:
   - never update `lastEmailAt`
   - always update `lastReplyAt` with `max(existing, responseDate)`
4. Apply low-level compatibility writes only for terminal admin response
   statuses:
   - `request_confirmed`:
     - `phase = resolved_positive`
     - `nextActionAt = null`
     - `closedAt = responseDate`
   - `request_denied`:
     - `phase = resolved_negative`
     - `nextActionAt = null`
     - `closedAt = responseDate`
5. Leave `registration_number_received` as an admin-workflow-only pending
   state:
   - append the admin response event
   - update `lastReplyAt`
   - do not change low-level `phase`, `nextActionAt`, `closedAt`, or
     `lastEmailAt`
6. Close the shared-reader gap by updating snapshot derivation to short-circuit
   when the latest admin workflow status is terminal, so those threads do not
   fall back into the legacy `thread_started` / `reply_reviewed` derivation
   paths and do not depend on `latestReview`.

### Testing Strategy

#### Unit Tests

- update append-response unit tests to reflect corrected lifecycle and
  timestamp semantics
- add unit coverage for:
  - terminal mappings clearing stale `nextActionAt`
  - `registration_number_received` preserving low-level lifecycle fields
  - historical-date behavior where `responseDate` is older than both
    `updatedAt` and existing `lastReplyAt`
- add snapshot derivation coverage proving terminal admin responses do not
  reuse the legacy `thread_started` / `reply_reviewed` derivation path

#### Integration Tests

- validate downstream reader behavior where raw low-level lifecycle fields are
  still consumed, especially campaign-admin interaction summary/filtering and
  stats surfaces

#### E2E / Real DB Tests

- update repo/e2e tests for manual response persistence so they assert:
  - `lastEmailAt` stays unchanged
  - `lastReplyAt` advances correctly
  - terminal statuses update low-level lifecycle fields
  - terminally updated threads are excluded from success-confirmation recovery

### Acceptance Criteria

- manual admin responses no longer modify outbound-send timestamps
- terminal manual admin responses surface as terminal to existing raw-phase
  readers
- terminal admin responses do not route through stale
  `thread_started` / `reply_reviewed` snapshot derivation
- `registration_number_received` remains a safe admin-workflow-only pending
  state for this patch
- optimistic concurrency, scope enforcement, and DTO shape remain unchanged

### Definition of Done

- implementation matches the strategy above without expanding scope
- targeted unit, integration, and e2e tests pass
- no new security concerns or privileged-surface changes are introduced
- final code review confirms the implementation matches the plan and fixes the
  two confirmed findings

## Alternatives Considered

- Map `registration_number_received` to `manual_follow_up_needed`.
  Rejected because that low-level phase currently implies reply-review state and
  `latestReview`, which manual admin responses do not produce.
- Synthesize fake `latestReview` data for terminal admin responses.
  Rejected because it would blur the distinction between reviewed inbound
  correspondence and manual admin workflow updates.
- Leave low-level lifecycle state untouched and rely only on
  `record.adminWorkflow`.
  Rejected because confirmed downstream readers still consume raw low-level
  fields and would remain stale.
- Migrate every remaining raw-phase reader in the same patch.
  Rejected because it broadens scope unnecessarily and increases risk.

## Consequences

**Positive**

- Fixes the two confirmed correctness issues with a narrow compatibility change
- Preserves the new admin workflow model without broad API churn
- Avoids manufacturing fake reply-review metadata
- Keeps stale background recovery/snapshot behavior from misclassifying
  terminal admin-updated threads

**Negative**

- Leaves `registration_number_received` as a split model where admin workflow
  and low-level lifecycle differ intentionally
- Requires a targeted reader guard in snapshot derivation instead of a single
  universal lifecycle mapping
- Does not redesign older low-level readers beyond what is needed for the
  confirmed regressions

## References

- [`src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts)
- [`src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts)
- [`src/modules/learning-progress/shell/repo/learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [`src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts)
- [`tests/unit/institution-correspondence/append-campaign-admin-thread-response.test.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/unit/institution-correspondence/append-campaign-admin-thread-response.test.ts)
- [`tests/e2e/campaign-admin-institution-threads-repo.test.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/e2e/campaign-admin-institution-threads-repo.test.ts)
- [`docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md)
