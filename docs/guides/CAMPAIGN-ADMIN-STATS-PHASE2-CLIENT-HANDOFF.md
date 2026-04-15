# Campaign Admin Stats Phase 2 Client Handoff

## Summary

The server-side `campaign-admin-stats` module now exposes ranked analytics
endpoints for the campaign admin client.

The existing overview route is unchanged:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`

New routes:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/interactions/by-type`
- `GET /api/v1/admin/campaigns/:campaignKey/stats/entities/top`

Current supported campaign:

- `funky`

These routes are authenticated campaign-admin routes and use the same auth and
permission model as the existing campaign admin stats overview.

## Intended Client Usage

Use the stats routes directly for analytics UI.

Do not derive these ranked views from:

- `/user-interactions`
- `/entities`
- `/notifications`

Those remain operational endpoints, not analytics endpoints.

## 1. Overview

Route:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`

Purpose:

- total users
- total interactions
- interaction review-state totals
- entity coverage totals
- notification delivery/open/click totals

Notes:

- response contract is unchanged from phase 1
- values are integer-only
- no raw payload content is exposed

## 2. Interactions By Type

Route:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/interactions/by-type`

Purpose:

- ranked interaction-level analytics for the campaign

Sort:

- always ordered by `total DESC`
- tie-break: `interactionId ASC`

Response shape:

```ts
type CampaignAdminStatsInteractionsByTypeItem = {
  interactionId: string;
  label: string | null;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  notReviewed: number;
};

type CampaignAdminStatsInteractionsByTypeResponse = {
  ok: true;
  data: {
    items: CampaignAdminStatsInteractionsByTypeItem[];
  };
};
```

Client notes:

- `label` is nullable, so always fall back to `interactionId`
- all count fields are non-negative integers
- this is aggregate-only analytics data

Suggested UI usage:

- “Top interaction elements” table
- bar chart by `total`
- stacked review-state view using `pending`, `approved`, `rejected`, `notReviewed`

## 3. Top Entities

Route:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/entities/top`

Query params:

- `sortBy`
  - required
  - allowed values:
    - `interactionCount`
    - `userCount`
    - `pendingReviewCount`
- `limit`
  - optional
  - default: `10`
  - min: `1`
  - max: `25`

Examples:

- `/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=interactionCount`
- `/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=userCount&limit=5`
- `/api/v1/admin/campaigns/funky/stats/entities/top?sortBy=pendingReviewCount&limit=25`

Response shape:

```ts
type CampaignAdminStatsTopEntityItem = {
  entityCui: string;
  entityName: string | null;
  interactionCount: number;
  userCount: number;
  pendingReviewCount: number;
};

type CampaignAdminStatsTopEntitiesResponse = {
  ok: true;
  data: {
    sortBy: 'interactionCount' | 'userCount' | 'pendingReviewCount';
    limit: number;
    items: CampaignAdminStatsTopEntityItem[];
  };
};
```

Sort behavior:

- ordered by the requested metric descending
- tie-break: `entityCui ASC`

Client notes:

- `entityName` is nullable, so fall back to `entityCui`
- all three count fields are returned on every row regardless of `sortBy`
- that means the same table component can be reused while only changing sort mode

Suggested UI usage:

- one table with tabs or segmented control:
  - Top by interactions
  - Top by users
  - Top by pending reviews

## Error Handling

Expected status codes:

- `401` unauthenticated
- `403` authenticated but missing campaign-admin permission
- `404` unsupported campaign
- `400` invalid query params for `entities/top`

Validation examples:

- invalid `sortBy` returns `400`
- `limit < 1` returns `400`
- `limit > 25` returns `400`

## Privacy / Data Handling Rules

These routes are analytics-only and sanitized.

They will not expose:

- user email addresses
- institution email addresses
- contact emails
- notification recipient addresses
- raw clicked URLs
- raw webhook payloads
- email subjects
- email HTML or text
- raw correspondence content
- raw interaction payload JSON

Client expectations:

- treat these endpoints as safe aggregate analytics
- do not attempt to enrich them with operational payload fields from other routes

## Implementation References

- [src/modules/campaign-admin-stats/shell/rest/routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-stats/shell/rest/routes.ts)
- [src/modules/campaign-admin-stats/shell/rest/schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-stats/shell/rest/schemas.ts)
- [src/modules/campaign-admin-stats/core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-stats/core/types.ts)
- [docs/specs/specs-202604151141-campaign-admin-marketing-stats-layer.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604151141-campaign-admin-marketing-stats-layer.md)
