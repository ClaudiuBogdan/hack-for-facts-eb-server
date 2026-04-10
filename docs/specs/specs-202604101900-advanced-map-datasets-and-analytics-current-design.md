# Advanced Map Datasets and Analytics Current Design

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Codex

## Problem

The Advanced Map datasets feature has accumulated multiple important decisions:

- dataset ownership and sharing rules
- public-write permission boundaries
- typed dataset value storage
- grouped-series export behavior
- concurrency and consistency guarantees
- CSV safety constraints for series identifiers

Those decisions were implemented incrementally across code and several narrower
specs. Without a consolidated feature-level reference, it is hard to answer:

- what the current product requirements are
- which behaviors are intentional versus incidental
- where the security and consistency boundaries actually live

## Context

Advanced Map Analytics consumes grouped-series data as a wide UAT matrix and
serializes it to CSV for client use. Uploaded Advanced Map datasets are one of
the grouped-series sources.

This feature has several constraints:

- datasets are owned by individual users, not organizations
- some datasets may be anonymously readable through public or unlisted sharing
- Advanced Map grouped-series payloads remain numeric at the matrix/export
  boundary
- generic dataset storage must support richer value types over time
- public exposure is a privileged boundary
- concurrent dataset and map writes must not produce invalid public/private
  combinations

The current implementation keeps the generic dataset module more flexible than
the map export layer. The map layer reads a numeric projection from uploaded
datasets and treats everything else as missing data.

## Decision

Use the following design as the current accepted contract for Advanced Map
datasets and their analytics integration.

### 1. Dataset identity and ownership

- Every dataset has:
  - `id`: internal UUID used by owner APIs and internal references
  - `publicId`: stable external UUID used for unlisted/public sharing
- Datasets are user-owned.
- Public anonymous contracts must use `publicId`, not internal `id`.

### 2. Dataset visibility model

- Supported visibility values are:
  - `private`
  - `unlisted`
  - `public`
- `private` datasets are owner-only.
- `unlisted` datasets are readable by link using `publicId`, but do not appear
  in public browse/list endpoints.
- `public` datasets are readable by `publicId` and appear in public browse/list
  endpoints.

### 3. Dataset metadata contract

- Metadata includes:
  - `title`
  - `description`
  - `markdown`
  - `unit`
  - `visibility`
- `markdown` is stored as sanitized markdown text.
- `unit` is nullable and optional for all datasets.

### 4. Dataset value model

- Dataset typing is row-level, not dataset-level.
- Each row may store:
  - `valueNumber: string | null`
  - `valueJson: { type, value } | null`
- At least one of `valueNumber` or `valueJson` must be non-null.
- Both fields may coexist on the same row.
- `valueJson` uses a shared code-defined schema registry with the initial item
  set:
  - `text`
  - `link`
  - `markdown`

### 5. Dataset row storage model

- Rows are keyed by `dataset_id + siruta_code`.
- Storage uses dual value columns:
  - `value_number NUMERIC NULL`
  - `value_json JSONB NULL`
- At least one of `value_number` or `value_json` must be set for each row.
- `value_json` must match one of the accepted typed payload shapes.
- The current typed JSON payload contract is:

```json
{
  "type": "text",
  "value": {
    "text": "Example"
  }
}
```

### 6. Upload and validation rules

- CSV upload remains numeric-only.
- CSV contract:
  - `siruta_code,value`
- CSV uploads populate `valueNumber` only.
- JSON payloads are managed through the dataset JSON APIs.
- Validation rules:
  - only non-county UAT `siruta_code` rows are accepted
  - duplicate `siruta_code` rows are rejected
  - `valueNumber`, when present, must be finite numeric text
  - `valueJson`, when present, must match a supported code-defined schema
  - `link.value.url` must use `http` or `https`
  - `markdown` payloads and metadata are sanitized before persistence
  - `unit` is optional metadata and is not tied to row shape

### 7. Advanced Map Analytics integration

- Uploaded datasets are a valid grouped-series source through
  `type: "uploaded-map-dataset"`.
- Advanced Map grouped-series output remains numeric:
  - matrix values are always `number | undefined`
  - if no numeric value is defined, grouped-series returns `undefined`
- Numeric projection rules:
  - `valueNumber` projects to a number when it round-trips safely through the
    grouped-series numeric path
  - rows without `valueNumber` produce `undefined`
  - `valueJson` is ignored by grouped-series export
- Wide CSV serialization keeps the existing contract:
  - numeric values serialize as numeric cells
  - `undefined` serializes as `null`

This means JSON-only rows are valid dataset content and valid uploaded series
inputs, but they contribute missing values to the grouped-series CSV.

### 7a. Dataset write APIs

- Numeric CSV create:
  - `POST /api/v1/advanced-map-datasets`
- JSON create for mixed `valueNumber`/`valueJson` rows:
  - `POST /api/v1/advanced-map-datasets/json`
- Numeric CSV replace:
  - `POST /api/v1/advanced-map-datasets/:id/file`
  - this replaces the numeric layer while preserving existing `valueJson`
    payloads by `siruta_code`
- Full row replacement:
  - `PUT /api/v1/advanced-map-datasets/:id/rows`
- Dataset detail/query APIs return both `valueNumber` and `valueJson`.

### 8. Public-write permission boundary

- Public visibility is the privileged boundary for both datasets and maps.
- All authenticated users may manage their own non-public resources:
  - `private`
  - `unlisted`
- The permission required for public writes is:
  - `advanced_map:public_write`
- The permission is read from Clerk user `private_metadata`:

```json
{
  "permissions": ["advanced_map:public_write"]
}
```

- No organization membership lookup is used for this feature.

### 9. Consistency and concurrency boundary

- Route-level validation exists for fast feedback, but correctness does not rely
  on route checks alone.
- Repository write paths enforce shared invariants under transaction-scoped
  advisory locks on dataset IDs.
- The following invariants must hold atomically:
  - a deleted dataset must not become newly referenced by a map snapshot
  - a private dataset must not become a dependency of a public map
  - deleting or privatizing a dataset must fail when conflicting map references
    exist at commit time

### 10. Public API and CSV safety

- Public dataset responses must not expose internal `id` or owner `userId`.
- Public map reads rewrite uploaded dataset references from internal `datasetId`
  to `datasetPublicId`.
- Grouped-series series IDs are validated for CSV/header safety:
  - reserved system prefixes such as `group_` are rejected
  - unsafe spreadsheet prefixes `=`, `+`, `-`, `@` are rejected

## Alternatives Considered

### Single JSONB value column for all row types

Rejected because it makes generic storage flexible but weakens constraints and
slows the numeric hot path for grouped-series extraction.

### Keep dataset-level homogeneous value types

Rejected because the product needs mixed row content such as numeric values plus
typed comments on the same dataset row.

### Reject non-numeric datasets when used by grouped-series

Rejected because it couples generic dataset validity to one consumer. The
current design keeps datasets flexible and lets the grouped-series layer project
only `valueNumber`.

### Require privileged permission for all dataset writes

Rejected because the product requirement is that authenticated users may manage
their own private and unlisted datasets and maps without elevated permission.

### Rely only on route-level pre-checks for public/private consistency

Rejected because concurrent writes can pass optimistic checks and still commit
an invalid final state.

## Consequences

**Positive**

- The dataset module can evolve beyond numeric-only content without breaking the
  current map CSV contract.
- The grouped-series layer stays simple: it emits numbers when it can and
  `undefined` when it cannot.
- Public exposure remains tightly controlled through one explicit permission.
- Concurrency-sensitive invariants are enforced at the repository boundary.
- Public APIs avoid leaking owner/internal identifiers.

**Negative**

- The grouped-series layer still depends on JavaScript-safe numeric projection,
  so some valid stored numeric values may remain unusable for map export.
- Generic dataset validity and map export compatibility are intentionally not
  the same thing, which adds one conceptual layer for maintainers.
- The feature is now documented across one consolidated spec plus several
  narrower supporting specs.

## Open Questions and Backlog

- System-defined dataset identity
  - Define how a system dataset is identified beyond the internal UUID.
  - Clarify whether this should be a dedicated stable `systemId`/`systemKey`,
    what format it uses, where it is unique, and how application code queries
    it for internal meaning.

- System-defined dataset visibility
  - Define how visibility works for system-generated datasets.
  - Clarify default visibility, whether it is mutable, and whether system
    datasets follow the same `private | unlisted | public` model or need a
    separate internal/system state.

- Grouping support for AI-assisted review
  - Evaluate adding a dataset grouping column or grouping/version concept.
  - If introduced, define how AI review can operate per grouping version, how
    grouping is indexed, and how grouping affects dataset lifecycle and search.

- Richer map layers and geography sources
  - Expand the map model to support more advanced GeoJSON and geographic layers,
    including roads, geography, and other non-UAT overlays.
  - Define layer storage, lazy loading, caching, permissions, and rendering
    rules for these heavier map assets.

- Lazy loading for non-numeric dataset series
  - Add lazy loading support for `text` and `json` dataset-backed series so the
    map does not eagerly load richer non-numeric payloads.
  - Define the loading contract, cache strategy, and UI triggers for these
    series types.

- Shared JSON schema for rich dataset values
  - Introduce a shared JSON schema contract for `json` dataset values that both
    client and server understand.
  - The schema must be explicit enough for the client to know how to render the
    value in the UI and for the server to validate and version it safely.

## References

- `docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md`
- `docs/specs/specs-202604101200-advanced-map-dataset-public-write-permissions.md`
- `docs/specs/specs-202604101330-advanced-map-public-write-permissions.md`
- `docs/specs/specs-202604101500-advanced-map-dataset-typed-values.md`
- `src/modules/advanced-map-datasets/core/types.ts`
- `src/modules/advanced-map-datasets/core/usecases/helpers.ts`
- `src/modules/advanced-map-datasets/shell/repo/advanced-map-datasets-repo.ts`
- `src/modules/advanced-map-datasets/shell/rest/routes.ts`
- `src/modules/advanced-map-datasets/shell/utils/parse-uploaded-dataset-csv.ts`
- `src/modules/advanced-map-analytics/grouped-series/core/usecases/get-grouped-series-data.ts`
- `src/modules/advanced-map-analytics/grouped-series/shell/providers/extract-uploaded-dataset-series.ts`
- `src/modules/advanced-map-analytics/grouped-series/shell/rest/wide-csv.ts`
- `src/modules/advanced-map-analytics/shell/rest/routes.ts`
- `src/modules/advanced-map-analytics/shell/repo/advanced-map-analytics-repo.ts`
- `src/infra/database/user/advisory-locks.ts`
