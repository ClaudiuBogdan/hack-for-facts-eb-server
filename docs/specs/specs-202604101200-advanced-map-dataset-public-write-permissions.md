# Advanced Map Dataset Public-Write Permissions

**Status**: Accepted
**Date**: 2026-04-10
**Author**: Codex

## Problem

Uploaded datasets have two different concerns:

- ownership: authenticated users should be able to manage their own datasets
- public exposure: making a dataset part of the public surface is privileged

The initial implementation applied the Clerk-backed dataset write permission to
all create, edit, replace, and delete operations. That was too strict for the
product requirement that every authenticated user may manage their own
`private` and `unlisted` datasets.

## Decision

Keep the existing Clerk-backed permission checker, but enforce it only for
write paths that involve `public` dataset visibility.

The required permission string is:

- `advanced_map:public_write`

The checker reads it from Clerk user `private_metadata`:

```json
{
  "permissions": ["advanced_map:public_write"]
}
```

No organization membership lookup is used for this feature.

### Privileged writes

The Clerk permission is required for these cases:

- create with `visibility = public`
- patch when the current dataset visibility is `public`
- patch when the requested new visibility is `public`
- file replacement when the current dataset visibility is `public`
- delete when the current dataset visibility is `public`

### Non-privileged writes

The Clerk permission is not required for these owner-only cases:

- create with `visibility = private`
- create with `visibility = unlisted`
- patch when both current and requested visibility stay within
  `private | unlisted`
- file replacement for `private` or `unlisted` datasets
- delete for `private` or `unlisted` datasets

## Enforcement Boundary

Enforce this rule in the dataset REST routes, where the request already knows:

- the authenticated user
- the requested visibility on create/patch
- the current owner-visible dataset state for patch/replace/delete

Core dataset use cases remain visibility-agnostic and ownership-safe. The
routes are responsible for deciding whether the current write crosses the public
visibility boundary and therefore needs the Clerk-backed permission.

The repository layer still re-checks the current dataset visibility inside the
transactional write path using the `allowPublicWrite` signal from the route. If
the dataset becomes `public` after the route pre-read but before commit, the
write fails closed with `403` instead of mutating a now-public dataset.

## Why This Design

- It keeps the existing auth design and permission checker in use.
- It aligns the privileged boundary with the real risk: publishing or mutating
  public data.
- It keeps the change small and explicit instead of pushing permission branches
  through every core use case.

## Consequences

**Positive**

- All authenticated users can manage their own non-public datasets.
- Public dataset writes still use the existing Clerk-backed authorization path.
- The route logic stays simple: owner access first, public-visibility permission
  only when needed.

**Negative**

- The privileged decision now depends on both current and requested visibility,
  so patch/replace/delete routes must load the owner dataset before deciding.

## References

- `src/modules/advanced-map-datasets/shell/rest/routes.ts`
- `tests/integration/advanced-map-datasets-rest.test.ts`
