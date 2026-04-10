# Advanced Map Dataset Consistency Boundary

**Status**: Accepted
**Date**: 2026-04-09
**Author**: Codex

## Problem

Uploaded map datasets and advanced-map snapshots share write-time invariants:

- a deleted dataset must not remain newly referenced by a map snapshot
- a private dataset must not become a dependency of a public map
- deleting or privatizing a dataset must fail when a conflicting map write wins

Simple pre-checks in routes and use cases are not enough under concurrency.
Without a shared lock/recheck boundary, two requests can both validate against
stale state and commit an invalid final combination.

## Decision

Enforce these invariants with transaction-scoped advisory locks on dataset IDs,
plus repository-level rechecks inside the same write transaction.

### Locking model

- Each uploaded dataset ID maps to a Postgres transaction-scoped advisory lock.
- Every write that can create, remove, or depend on a dataset reference must
  acquire those dataset locks in sorted order before its decisive recheck.
- Route/use-case validation still exists for fast feedback, but correctness
  depends on the repository recheck, not on the optimistic pre-check.

### Covered write paths

- `advanced-map-datasets` repository:
  - `softDeleteDataset(...)`
  - `updateDatasetMetadata(...)` when downgrading visibility to `private`
- `advanced-map-analytics` repository:
  - `appendSnapshot(...)`
  - `updateMap(...)` when promoting a map to `public`

### Recheck rules inside the lock boundary

- Dataset delete:
  - lock the dataset ID
  - re-scan referencing snapshots/maps
  - delete only when no references remain
- Dataset private downgrade:
  - lock the dataset ID
  - re-scan public referencing snapshots/maps
  - downgrade only when no public references remain
- Snapshot save:
  - lock all removed and added dataset IDs
  - re-check that all added dataset IDs still exist and are accessible to the
    writer
  - if the resulting map is public, re-check that all added dataset IDs are
    `public` or `unlisted`
- Map publication:
  - lock all dataset IDs referenced by the current snapshot
  - re-check that those datasets still exist and are shareable

## Why This Design

- It closes the real race without introducing triggers or a new reference table.
- It keeps enforcement explicit in repository code and easy to test locally.
- It scopes contention to the dataset IDs involved in a write instead of using a
  coarse global lock.
- It works with the existing JSONB snapshot model and current reference scans.

## Non-Goals

- Replacing JSONB snapshot payloads
- Adding immutable dataset revisions
- Introducing a normalized dataset-reference table in this change

Those may still be useful later for performance or analytics, but they are not
required to make the current invariants atomic.

## Consequences

**Positive**

- Dataset delete/private-downgrade and map publish/save now serialize on shared
  dataset IDs.
- Correctness no longer depends on request timing between modules.
- Existing route-level validation remains useful for fast user feedback.

**Negative**

- Repository writes are more complex and now depend on Postgres advisory locks.
- Historical-reference checks still use JSONB scans, so enforcement is atomic
  but not yet as cheap as a normalized reference index would be.

## Follow-Ups

- If reference-scan cost becomes material, add a normalized reference table as a
  performance optimization, not as the primary correctness mechanism.
- If dataset revisions are introduced later, keep the same locking approach but
  move the lock key to the referenced dataset revision ID.

## References

- `src/infra/database/user/advisory-locks.ts`
- `src/modules/advanced-map-datasets/core/usecases/delete-dataset.ts`
- `src/modules/advanced-map-datasets/core/usecases/update-dataset-metadata.ts`
- `src/modules/advanced-map-datasets/shell/repo/advanced-map-datasets-repo.ts`
- `src/modules/advanced-map-analytics/shell/repo/advanced-map-analytics-repo.ts`
- `src/modules/advanced-map-analytics/shell/rest/routes.ts`
