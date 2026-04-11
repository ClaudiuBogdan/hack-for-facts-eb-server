# Campaign Admin Fail-Closed Authorization

**Status**: Accepted
**Date**: 2026-04-11
**Author**: Codex

## Problem

The campaign-admin review endpoints need a stronger security boundary than the
generic "authenticated user plus route-local permission check" pattern.

The main gaps are:

- route handlers can accidentally become admin-readable or admin-writable if a
  future route forgets to call the campaign-admin permission check
- the previous app wiring could still mount the campaign-admin route plugin even
  when no real campaign-admin authorizer was configured
- the previous permission adapter was bound to one hard-coded permission at
  construction time, which does not scale to multiple campaigns or policy-driven
  permissions
- fail-closed behavior existed in pieces, but not as a single structural
  boundary at route registration and plugin execution time

This matters because campaign-admin routes expose privileged review state and
can trigger approval side effects. The safe default must be that these routes do
not exist, or refuse requests, unless the authorization boundary is fully wired.

## Context

- the broader campaign-admin HTTP surface is specified in
  `docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md`
- the server already uses Clerk-backed permission checks for other privileged
  user-session features, such as advanced-map public write permissions
- the campaign-admin API is session-authenticated and records reviewer identity
  in canonical learning-progress audit metadata, so it should not reuse the
  shared API-key admin model
- the app already has examples of fail-closed registration for some privileged
  features by refusing startup when required infrastructure is missing
- campaign-admin access is policy-driven:
  - each `campaignKey` maps to a required permission
  - future campaigns may require different permissions

## Decision

Use a fail-closed campaign-admin authorization boundary with explicit route
enablement, plugin-level authorization, and campaign-aware permission checks.

The required design is:

- campaign-admin routes are enabled only when `ENABLED_ADMIN_CAMPAIGNS` contains
  one or more supported campaign keys
- example:
  - `ENABLED_ADMIN_CAMPAIGNS=funky`
- when that list is empty, the campaign-admin routes are not registered
- when that flag is true, startup must fail if a real Clerk-backed authorizer
  cannot be built, including when `CLERK_SECRET_KEY` is missing or blank
- when that flag is true, startup must also fail if:
  - `userDb` is unavailable
  - session authentication is not wired through a real `authProvider`
- authorization is enforced at the campaign-admin route-plugin boundary, not
  separately inside each handler
- the plugin-level preHandler must:
  - require an authenticated user session
  - resolve the campaign policy for `:campaignKey`
  - evaluate the required permission for that campaign
  - attach the authorized campaign context to the request for handlers to use
- the permission adapter must be campaign-aware by accepting
  `{ userId, permissionName }`
- the Clerk adapter should cache the full permission set per user, then answer
  permission checks against that cached set

Operational semantics:

- unknown or unsupported campaigns return `404`
- missing authentication returns `401`
- authenticated users without the campaign permission return `403`
- Clerk lookup failures, invalid Clerk payloads, and timeouts deny access

## Alternatives Considered

- Keep per-handler `ensureCampaignAdminAccess(...)` calls.
  Rejected because this is opt-in authorization and can be bypassed by accident
  when new handlers are added.
- Keep mounting the route plugin with a deny-all fallback authorizer.
  Rejected because it leaves the privileged surface mounted even when the
  authorization boundary is not actually configured.
- Reuse the shared admin API-key pattern.
  Rejected because campaign-admin actions need reviewer attribution tied to the
  authenticated user and are scoped by campaign permissions.
- Keep the authorizer bound to one permission at construction time.
  Rejected because campaign policy should live in the campaign config, not in
  `build-app.ts`.

## Consequences

**Positive**

- campaign-admin routes now fail closed both at startup and per request
- new campaign-admin handlers inherit authorization automatically from the
  plugin boundary
- campaign permission policy is centralized and can grow to additional campaigns
- the authorization adapter is reusable for other policy-driven Clerk
  permission checks

**Negative**

- route enablement now depends on an explicit config flag in addition to Clerk
  auth wiring
- tests and fixtures must carry the new config field
- unsupported or partially configured environments now fail earlier at startup,
  which is stricter but intentional

## References

- `docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md`
- `src/app/build-app.ts`
- `src/infra/config/env.ts`
- `src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`
- `src/modules/learning-progress/shell/security/clerk-campaign-admin-permission-checker.ts`
- `tests/unit/app.test.ts`
- `tests/integration/campaign-admin-user-interactions-rest.test.ts`
