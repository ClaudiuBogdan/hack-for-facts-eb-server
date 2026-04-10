# Advanced Map Public-Write Permissions

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Codex

## Problem

Advanced Map Analytics exposes anonymous public map URLs. That makes `public`
visibility a privileged boundary, not just a cosmetic setting.

The product requirement is strict:

- any authenticated user may manage their own non-public map work
- creating or editing a `public` advanced map must require the Clerk-backed
  permission check

Without that gate, an unprivileged user can move private or unlisted map
content onto the anonymous public surface.

## Decision

Use the existing Clerk-backed permission checker for `public` map writes, and
enforce it only when a write crosses or operates on the public boundary.

The required permission string is:

- `advanced_map:public_write`

The checker reads it from Clerk user `private_metadata`:

```json
{
  "permissions": ["advanced_map:public_write"]
}
```

No organization membership lookup is used for this boundary.

### Privileged map writes

The Clerk permission is required for:

- create with `visibility = public`
- patch when the current map visibility is `public`
- patch when the requested new visibility is `public`
- delete when the current map visibility is `public`
- snapshot save when the effective visibility is `public`
  - this includes publishing a private map via `mapPatch.visibility = public`
  - this also includes editing an already public map without changing
    `mapPatch.visibility`

### Non-privileged map writes

The Clerk permission is not required for:

- create with `visibility = private`
- patch when both current and requested visibility stay private
- snapshot save when the effective map visibility stays private

## Enforcement Boundary

Enforce this in the advanced-map REST routes, where the request already knows:

- the authenticated user
- the requested visibility
- the current map visibility for patch and snapshot save

Core map use cases remain permission-agnostic. The REST boundary decides when a
write touches the anonymous public surface and therefore needs the privileged
check.

The repository write path still re-checks current/effective public visibility
under the transaction using the `allowPublicWrite` signal from the route. If a
concurrent request promotes the same map to `public` after the route pre-read,
the unprivileged write fails closed with `403` instead of mutating a now-public
map.

## References

- `src/modules/advanced-map-analytics/shell/rest/routes.ts`
- `tests/integration/advanced-map-analytics-rest.test.ts`
- `docs/specs/specs-202604101200-advanced-map-dataset-public-write-permissions.md`
