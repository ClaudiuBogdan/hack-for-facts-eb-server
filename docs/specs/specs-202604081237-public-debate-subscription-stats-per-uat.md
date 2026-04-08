# Public Debate Subscription Stats Per UAT

**Status**: Draft
**Date**: 2026-04-08
**Author**: Codex

## Problem

The public debate campaign currently lets users subscribe to campaign-wide and entity-specific updates, but the product does not expose aggregated subscription counts anywhere in the UI. That creates three gaps:

- the main campaign hub cannot show social proof for overall participation;
- the UAT selector search and map cannot show where interest is concentrated;
- campaign teams and users cannot compare UAT participation without internal database access.

The missing capability is not just presentation. The current data model stores campaign subscriptions in the user database while UAT metadata lives in the budget database, so there is no existing public, cacheable API that returns per-UAT counts in a client-ready shape.

## Context

Server findings:

- HTTP stack: Fastify, with a global `@fastify/rate-limit` plugin registered in [`src/app/build-app.ts`](src/app/build-app.ts).
- Auth model: global auth middleware populates `request.auth`, and selected public routes are explicitly exempted in `shouldBypassGlobalAuthValidation` in [`src/app/build-app.ts`](src/app/build-app.ts).
- Query layer: Kysely + Postgres via [`src/infra/database/client.ts`](src/infra/database/client.ts).
- User subscription schema: campaign subscriptions are stored in `notifications` in [`src/infra/database/user/schema.sql`](src/infra/database/user/schema.sql), keyed by:
  - `user_id`
  - `notification_type`
  - `entity_cui`
- Existing campaign count views already exist in the working tree:
  - `v_public_debate_campaign_user_total`
  - `v_public_debate_uat_user_counts`
    in [`src/infra/database/user/schema.sql`](src/infra/database/user/schema.sql) and [`src/infra/database/user/migrations/202604081100_add_public_debate_campaign_count_views.sql`](src/infra/database/user/migrations/202604081100_add_public_debate_campaign_count_views.sql).
- UAT identity lives in the budget database:
  - `entities.cui`, `entities.uat_id`, `entities.is_uat`
  - `uats.id`, `uats.name`, `uats.uat_code`
    in [`src/infra/database/budget/schema.sql`](src/infra/database/budget/schema.sql).

Client findings:

- Framework: React 19 + Vite + TanStack Router + TanStack React Query in [`package.json`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/package.json).
- Main campaign landing route: [`/provocare`](src/routes/provocare.tsx) rendered by [`src/features/campaigns/buget/components/landing/buget-landing-page.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/landing/buget-landing-page.tsx).
- Campaign UAT selector/search page: [`/primarie`](src/routes/primarie/index.lazy.tsx) rendered by [`src/features/campaigns/buget/components/hub/buget-entity-selector-gate.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-selector-gate.tsx).
- Dedicated selector map route: [`/primarie/harta`](src/routes/primarie/harta/index.lazy.tsx) rendered by [`src/features/campaigns/buget/components/hub/buget-entity-map-selector-page.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-map-selector-page.tsx) and [`src/features/campaigns/buget/components/hub/buget-entity-map-selector-map.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-map-selector-map.tsx).
- Main campaign/challenge hub: [`/primarie/$cui/buget`](src/routes/primarie/$cui/buget/index.lazy.tsx) rendered by [`src/features/challenges/components/hub/ChallengesHubPage.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/challenges/components/hub/ChallengesHubPage.tsx).
- Search UI: generic `EntitySearchInput` + `SearchResultItem` in [`src/components/entities/EntitySearch/index.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/entities/EntitySearch/index.tsx) and [`src/components/entities/EntitySearch/SearchResultItems.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/entities/EntitySearch/SearchResultItems.tsx).
- Map library: Leaflet / `react-leaflet`.
- Current map styling utilities and legend already exist in [`src/components/maps/utils.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/maps/utils.ts) and [`src/components/maps/MapLegend.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/maps/MapLegend.tsx).
- Query defaults: React Query globally uses `staleTime: 60_000` in [`src/lib/queryClient.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/lib/queryClient.ts).

Constraint that drives the design:

- The user database and budget database are separate Kysely clients. A direct SQL join between subscriptions and UAT metadata is not available in the current architecture. The implementation therefore has to aggregate in the user DB first, then resolve UAT metadata by key from the budget DB.

## Decision

Implement a public, cacheable subscription-stats feature around the existing public-debate campaign key (`funky`) with a strict separation of concerns:

### 1. Database query strategy

- Keep aggregation in the user DB, at SQL level, using the existing public-debate count views as the aggregation source instead of counting rows in application code.
- Read:
  - total subscriptions from `v_public_debate_campaign_user_total`
  - per-entity/UAT counts from `v_public_debate_uat_user_counts`
- Resolve `uat_id` and `uat_name` in a second budget DB query using the aggregated `entity_cui` keys:
  - `entities.cui = per-entity count key`
  - `entities.uat_id -> uats.id`
  - `uats.name` as display name
- Merge the two result sets in application code without recomputing counts.
- Preserve descending sort by count in the final `per_uat` array.

Performance/indexing plan:

- Keep the existing general notification indexes.
- Add public-debate-specific partial indexes in the user DB keyed to the actual schema, since there is no `campaign_id` or `uat_id` column in this codebase:
  - active global campaign users by `user_id`
  - active entity update subscriptions by `(entity_cui, user_id)`
  - global unsubscribe lookups by `user_id`
- Keep using `entities.cui` and `entities.uat_id` / `uats.id`, which are already indexed in the budget schema.

### 2. API endpoint design

- Add `GET /api/v1/campaigns/:campaignId/subscription-stats`.
- Keep it public and read-only.
- Validate `campaignId` with TypeBox and then resolve only supported campaign keys. Initial supported key: `funky`.
- Return only aggregated, non-personal data:
  - `total`
  - `per_uat: [{ uat_id, uat_name, count }]`
- Apply:
  - route-level rate limiting at 60 requests/minute per IP
  - `Cache-Control: public, max-age=60, stale-while-revalidate=300`
  - a server-side cache TTL of 60 seconds using the existing cache infrastructure
- Register the route as an auth-bypassed public endpoint in `build-app`.
- Reuse the project’s standard error envelope:
  - `{ ok: false, error, message }`

### 3. Client data-fetching strategy

- Add a dedicated client API function plus `useSubscriptionStats(campaignId)` backed by React Query.
- Use query key `['campaign-subscription-stats', campaignId]`.
- Use:
  - `staleTime: 60_000`
  - `refetchInterval: 60_000`
  - `refetchOnWindowFocus: false`
- Normalize the hook return shape to:
  - `total`
  - `perUat`
  - `isLoading`
  - `isError`
- Parse the REST payload with a local zod schema before it reaches UI components.

### 4. Component architecture

- Add a campaign-specific stats API/hook under the existing campaign feature area in the client repo.
- Add a reusable `SubscriptionCounter` component for count display, loading skeletons, and accessible labelling.
- Extend the generic entity search result renderer with an optional trailing metadata slot so campaign pages can show counts without hard-coupling generic search to campaign logic.
- Extend the campaign selector map component with optional stats props instead of creating a second campaign map implementation.
- Add a dedicated ranked stats section to the challenge hub page when data is available.

### 5. Map visualization strategy

- Reuse the existing Leaflet GeoJSON rendering path and choropleth-style fill updates from the map utilities.
- Build a campaign-specific color scale for subscription counts using count bins rather than monetary percentiles.
- Show:
  - a light-to-dark fill ramp for UAT polygons
  - tooltip content with UAT name and exact subscriber count
  - a legend describing count ranges
- Degrade gracefully:
  - if stats fail, keep the existing selector map behavior and neutral styling
  - if stats load, progressively enhance the existing polygons
- Use `react-intersection-observer` to defer stats-driven map styling until the map scrolls into view on pages where the map is below the fold.

### 6. Client-side joining strategy

- Keep the REST payload minimal and keyed by `uat_id`.
- For client joins:
  - extend entity search results to include `entity.uat.id`
  - add a cached UAT directory query for pages that need to map `entity_cui`/GeoJSON `cui` to `uat_id`
- This avoids expanding the public REST payload with extra join-only identifiers while still allowing:
  - search-result count badges
  - full-country map coloring

## Alternatives Considered

### Alternative 1: Join user DB subscriptions directly to budget DB UAT tables in one SQL query

Rejected because the current architecture uses separate database clients and separate connection URLs for user data and budget data. A direct join is not available without introducing cross-database infrastructure that does not exist in this project.

### Alternative 2: Expose counts through the existing authenticated notifications endpoints

Rejected because the feature must be public, cacheable, and anonymous. Reusing authenticated notification routes would complicate caching and mix private user preference concerns with public aggregate stats.

### Alternative 3: Return counts keyed by entity CUI only

Rejected as the primary API contract because the feature is explicitly about UAT-level counts and the UI needs stable UAT identifiers. Entity CUI may remain an internal join aid if implementation needs it, but it should not be the main public abstraction.

### Alternative 4: Bake subscription counts into client assets or static GeoJSON

Rejected because counts change over time and need minute-level freshness. Static assets would go stale and require a separate content/deploy pipeline.

### Alternative 5: Fetch raw subscriptions and count on the server in memory

Rejected because it scales poorly, ignores existing SQL aggregation work, and violates the requirement to aggregate at the database level.

## Consequences

**Positive**

- Uses the current architecture instead of fighting it: SQL aggregation in the user DB, metadata resolution in the budget DB.
- Keeps the public API free of PII and safe for CDN/browser caching.
- Reuses existing map, legend, query, and search infrastructure on the client.
- Gives the campaign hub, selector search, and selector map a single shared source of truth for subscription counts.
- Adds a narrowly scoped public API that can support future campaign dashboards.

**Negative**

- The feature needs two backend data lookups because UAT metadata is not co-located with subscriptions.
- The client needs an extra UAT directory mapping path for full map coloring if the public API remains keyed only by `uat_id`.
- The current working tree already contains uncommitted public-debate count view changes in the server repo, so implementation must preserve and build on those edits rather than replace them.

## References

- Server app wiring: [`src/app/build-app.ts`](src/app/build-app.ts)
- User DB schema: [`src/infra/database/user/schema.sql`](src/infra/database/user/schema.sql)
- Existing count view migration: [`src/infra/database/user/migrations/202604081100_add_public_debate_campaign_count_views.sql`](src/infra/database/user/migrations/202604081100_add_public_debate_campaign_count_views.sql)
- Budget DB schema: [`src/infra/database/budget/schema.sql`](src/infra/database/budget/schema.sql)
- Notifications repo: [`src/modules/notifications/shell/repo/notifications-repo.ts`](src/modules/notifications/shell/repo/notifications-repo.ts)
- Campaign selector gate: [/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-selector-gate.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-selector-gate.tsx)
- Campaign selector map: [/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-map-selector-map.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/hub/buget-entity-map-selector-map.tsx)
- Challenge hub page: [/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/challenges/components/hub/ChallengesHubPage.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/challenges/components/hub/ChallengesHubPage.tsx)
- Client query defaults: [/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/lib/queryClient.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/lib/queryClient.ts)
- Existing map utilities: [/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/maps/utils.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/components/maps/utils.ts)
