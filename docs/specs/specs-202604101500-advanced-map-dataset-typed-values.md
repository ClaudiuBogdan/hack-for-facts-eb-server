# Advanced Map Dataset Number and JSON Values

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Codex

## Decision

Refactor advanced map datasets from a dataset-level value enum to a row-level
dual-field model.

Each dataset row may contain:

- `valueNumber`
- `valueJson`

At least one must be present. Both may be present on the same row.

Dataset metadata no longer declares a single dataset-wide value type.

## Storage Model

Datasets:

- keep optional `unit`
- remove dataset-level `value_type`

Rows:

- use:
  - `value_number NUMERIC NULL`
  - `value_json JSONB NULL`
- enforce:
  - at least one of `value_number` or `value_json` must be non-null
  - `value_json` must match a supported typed payload schema

Initial supported JSON payloads use a typed-item shape:

```json
{
  "type": "text",
  "value": {
    "text": "Example"
  }
}
```

Initial payload types:

- `text`
- `link`
- `markdown`

## API Contract

Dataset metadata includes:

- nullable `unit`

Dataset rows use:

```json
{
  "sirutaCode": "1001",
  "valueNumber": "123.45",
  "valueJson": {
    "type": "markdown",
    "value": {
      "markdown": "Some note"
    }
  }
}
```

CSV upload remains numeric-only and populates only `valueNumber`.

JSON dataset writes use explicit row payloads and may populate:

- only `valueNumber`
- only `valueJson`
- both

## Validation Rules

- each row requires at least one of `valueNumber` or `valueJson`
- `valueNumber`, when present, must be finite and is normalized through
  `decimal.js`
- `valueJson`, when present, must match a supported typed payload schema
- `text` requires non-empty trimmed text
- `markdown` requires non-empty sanitized markdown
- `link` requires `http/https` URL and optional nullable label
- `unit` remains optional metadata for all datasets

## Advanced Map Analytics

Grouped-series and wide CSV use only `valueNumber`.

- if `valueNumber` is present and safely projectable, grouped-series emits a
  number
- if `valueNumber` is absent or not safely projectable, grouped-series emits
  `undefined`
- `valueJson` never contributes to grouped-series numeric output
- wide CSV serializes grouped-series `undefined` values as `null`

This allows datasets to carry richer row annotations without changing the map
CSV contract.

## Write Paths

- `POST /api/v1/advanced-map-datasets`
  - multipart CSV create
  - numeric-only rows
- `POST /api/v1/advanced-map-datasets/json`
  - JSON create
  - supports `valueNumber`, `valueJson`, or both
- `POST /api/v1/advanced-map-datasets/:id/file`
  - CSV numeric replacement
  - replaces only numeric values and preserves existing JSON payloads by
    `sirutaCode`
- `PUT /api/v1/advanced-map-datasets/:id/rows`
  - full JSON row replacement

## Rollout

1. Add `value_number` and convert legacy numeric row columns into it.
2. Convert legacy `string` rows to typed `text` payloads.
3. Convert legacy `link` rows to typed `link` payloads.
4. Drop dataset-level `value_type` and old typed row columns.

## Out of Scope

- payload versioning
- DB-driven schema registry
- arbitrary unvalidated JSON payloads
- map rendering directly from `valueJson`
- non-UAT map datasets
