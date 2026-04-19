# Campaign Entity Config on UserInteractions

**Status**: Proposed
**Date**: 2026-04-18
**Author**: Codex

## Problem

The application needs a canonical store for campaign-entity configuration that:

- is editable through the admin panel
- is readable by multiple server modules
- supports heterogeneous config values such as business dates and URLs
- stays authoritative even when no user interaction, notification, or
  correspondence record exists yet for that entity

The current codebase does not have a dedicated authoritative store for this
kind of shared admin-managed entity config.

Existing stores do not fit cleanly:

- `campaign-admin-entities` is a projection over interactions, subscribers, and
  outbox rows, not a writable entity record source
- `datasets` is file-backed, not runtime admin-managed state
- `advanced-map-datasets` is user-owned dataset storage with row-oriented
  semantics
- notification and correspondence tables are lifecycle-specific operational
  stores, not generic config registries

The current constraint is that no new database table should be introduced.

## Context

- `userinteractions` is an existing JSONB-backed store keyed by
  `(user_id, record_key)` with prefix indexes that support exact lookup and
  scoped listing.
- The learning-progress module already reserves `internal:` records for
  server-owned state. Public sync rejects internal keys and interaction ids, so
  clients cannot write them through the public progress API.
- Internal records are hidden from normal progress reads by default and are not
  deleted by `resetProgress`.
- The weekly digest cursor already uses this internal-record pattern as a
  server-owned JSON payload stored inside `userinteractions`.
- Existing campaign-admin interaction and entity stats flows derive their data
  from configured interaction ids, review state, subscriptions, and outbox
  activity. Synthetic config rows must not be shaped in a way that makes them
  look like normal entity interactions.
- Existing optimistic concurrency patterns already use `expectedUpdatedAt` for
  admin writes and conflict on stale state.
- There is already a canonical entity identity boundary through
  `EntityRepository.getById(cui)`. Admin-managed config should not create
  durable rows for unknown or mistyped CUIs.
- Existing campaign-admin modules are fail-closed and explicitly configured for
  the literal `funky` campaign key. This work should follow that same pattern
  instead of introducing a generic multi-campaign registry in v1.
- Campaign interaction policy remains code-owned in
  `campaign-admin-config.ts`. This specification only covers runtime-mutable
  campaign-entity configuration managed by admins.

## Decision

Implement campaign-entity configuration as a dedicated server-side module backed
by internal `userinteractions` rows.

The chosen module boundary is:

- module name: `campaign-entity-config`
- persistence backing store: `userinteractions`
- public access pattern: dedicated server-side use cases and admin routes only
- storage semantics: one internal record per `(campaignKey, entityCui)`
- v1 campaign scope: `funky` only

### Goals

- Reuse an existing durable store without adding a new table.
- Keep config state server-owned and inaccessible to public sync.
- Keep the read/write interface narrow and explicit.
- Make future migration to a real table straightforward.
- Keep admin edits deterministic and conflict-safe.

### Non-goals

- Replacing static campaign interaction policy in code.
- Reusing public learning-progress sync or admin interaction endpoints for
  config writes.
- Modeling config changes as interaction audit events.
- Building rich ad hoc querying over config fields in v1.
- Adding row deletion semantics to `LearningProgressRepository`.

### Architecture Summary

1. Admin routes call a dedicated `campaign-entity-config` service.
2. The service computes a synthetic `user_id` bucket per campaign and an
   internal `record_key` per entity.
3. Reads use exact `getRecord` or campaign-scoped `getRecords` with
   `includeInternal: true`, with read-side envelope and payload validation.
4. Writes run inside `withTransaction`, acquire a transaction-scoped advisory
   lock on the logical config identity, validate `entityCui` through the entity
   module, load the row with `getRecordForUpdate`, compare
   `expectedUpdatedAt`, generate a monotonic internal `record.updatedAt`, and
   upsert the full internal record.
5. Downstream modules consume config only through the dedicated
   `campaign-entity-config` read API, never through raw learning-progress repo
   calls.
6. Operational workflows that need historical reproducibility snapshot the
   effective config they used into their own metadata at execution time.

### Storage Shape

Partition rows by campaign using a synthetic user bucket:

- `user_id = internal:campaign-config:<campaignKey>`

Store one row per entity:

- `record_key = internal:entity-config::<entityCui>`

This shape is preferred over a single campaign-wide blob because:

- it matches the existing `(user_id, record_key)` primary key and prefix index
- it avoids one hot row for all entity updates in a campaign
- it keeps future migration to a real table straightforward
- it allows campaign-scoped listing without cross-campaign string parsing

In v1, the only supported campaign bucket is:

- `user_id = internal:campaign-config:funky`

### Internal Record Envelope

Each stored row uses a fixed server-owned learning-progress envelope:

- `interactionId = internal:campaign-entity-config`
- `lessonId = "internal"`
- `kind = "custom"`
- `scope = { type: "global" }`
- `phase = "resolved"`
- `completionRule = { type: "resolved" }`
- `result = null`
- `auditEvents = []`

`scope.type = "global"` is intentional. Config rows should not look like normal
entity-scoped interactions, or they risk accidental inclusion in entity
interaction pipelines and rollups.

### Payload Schema

Store the actual config in `value.kind = "json"` with a strict, versioned
payload schema.

Base envelope:

```json
{
  "version": 1,
  "campaignKey": "funky",
  "entityCui": "11111111",
  "values": {
    "budgetPublicationDate": "2026-02-01",
    "officialBudgetUrl": "https://example.com/budget.pdf"
  },
  "meta": {
    "updatedByUserId": "admin-123"
  }
}
```

Rules:

- `additionalProperties: false` at every object boundary
- `campaignKey` and `entityCui` in the payload must match the synthetic keying
- `version` is required and explicit
- `values` is campaign-specific and typed, not a generic key/value bag
- `budgetPublicationDate` is stored as `YYYY-MM-DD` because it is a business
  date, not an instant
- URL fields are validated as normalized string URLs
- numeric fields added later must use string decimal semantics when precision
  matters
- nullable fields represent “unset”

The initial `funky` values contract is:

- `budgetPublicationDate: string | null`
- `officialBudgetUrl: string | null`

### Versioning Policy

- v1 reads accept only `version = 1`
- v1 writes always persist `version = 1`
- unknown or unsupported versions are treated as invalid persisted data and are
  not served to callers
- future schema upgrades must be implemented as explicit module-owned backfills
  or read-time upgrade code, not as implicit best-effort parsing

### Server Interfaces

Expose only dedicated server-side interfaces:

- `getCampaignEntityConfig(input: { campaignKey: "funky"; entityCui: string })`
- `upsertCampaignEntityConfig(input: { campaignKey: "funky"; entityCui: string; values: ...; expectedUpdatedAt: string | null; actorUserId: string })`
- `listCampaignEntityConfigs(input: { campaignKey: "funky"; cursor?: string; limit: number })`

These interfaces own:

- synthetic key construction
- entity existence validation
- TypeBox validation
- optimistic concurrency
- internal advisory locking
- normalization of nullable values
- monotonic internal timestamp generation
- conversion from learning-progress rows into config DTOs
- read-side validation of persisted envelope and payload

The synthetic key builders stay private to this module. Feature code must not
call raw `LearningProgressRepository.getRecord`, `getRecords`, or
`upsertInteractiveRecord` for config directly.

### Write Semantics

Every create or update write must:

1. authenticate the caller through the existing fail-closed campaign-admin auth
   hook
2. resolve campaign access with the same campaign-admin permission model used
   by other admin route families
3. validate `entityCui` through `EntityRepository.getById(entityCui)` and
   return `404` when the entity does not exist
4. acquire a transaction-scoped advisory lock on the logical config identity
5. re-read the stored row inside the transaction
6. compare API `expectedUpdatedAt` against the current row `updated_at`
7. generate the embedded `record.updatedAt` as
   `max(now, previousRecord.updatedAt + 1ms)`
8. upsert the full internal row

Concurrency rules:

- `expectedUpdatedAt = null` means “create only if missing”
- if a row already exists under the advisory lock and `expectedUpdatedAt` is
  `null`, return `409`
- if a row exists and `expectedUpdatedAt` does not equal the current row
  `updated_at`, return `409`
- if no row exists and `expectedUpdatedAt` is non-null, return `409`

This avoids the silent insert-race overwrite that would otherwise be possible
through `upsertInteractiveRecord`.

### Admin API

Add a dedicated admin config collection route plus a nested entity config item
route.

The item route belongs under the existing entity admin surface so config does
not create a second competing entity-specific contract:

- `GET /api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config`
- `PUT /api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config`

The collection route exists because the current `/entities` projection does not
cover configured-but-inactive entities:

- `GET /api/v1/admin/campaigns/:campaignKey/entity-config`

All routes use the repo-standard envelopes:

- success: `{ ok: true, data: ... }`
- failure: `{ ok: false, error, message, retryable }`

#### `GET /entities/:entityCui/config`

Behavior:

- `404` when the campaign is not enabled or the entity does not exist
- `200` when the entity exists, even if no config row exists yet

Response body:

```json
{
  "ok": true,
  "data": {
    "campaignKey": "funky",
    "entityCui": "11111111",
    "isConfigured": false,
    "values": {
      "budgetPublicationDate": null,
      "officialBudgetUrl": null
    },
    "updatedAt": null,
    "updatedByUserId": null
  }
}
```

When a row exists:

- `isConfigured = true`
- `updatedAt` is the row `updated_at` value
- `updatedByUserId` comes from payload `meta.updatedByUserId`

#### `PUT /entities/:entityCui/config`

Request body:

```json
{
  "expectedUpdatedAt": null,
  "values": {
    "budgetPublicationDate": "2026-02-01",
    "officialBudgetUrl": "https://example.com/budget.pdf"
  }
}
```

Rules:

- `values` is a full replacement object, not a partial patch
- all supported keys must be present in the request, even when `null`
- at least one supported key must be non-null
- all-null writes return `400`; clearing the final configured value is deferred
  until explicit delete semantics exist
- success returns the same canonical body shape as `GET`
- conflict returns `409` with the standard error envelope; the client must
  refetch before retrying

#### `GET /entity-config`

Purpose:

- list configured rows, including entities that have no interaction/subscriber
  activity and therefore do not appear in the current `/entities` projection

Semantics:

- returns configured rows only
- ordered by `updatedAt desc, entityCui asc`
- supports cursor pagination with repo-standard `items` and `page` response
  shape
- validates each persisted row before returning it

This collection route is a discovery surface for saved config, not a
replacement for entity search.

### Security and Integrity Boundaries

Security posture:

- public sync cannot write the reserved internal keys or interaction id
- normal public progress reads do not expose internal rows
- progress reset does not delete internal rows
- admin writes must continue to use the existing fail-closed campaign-admin
  permission model

Integrity posture:

- only the `campaign-entity-config` module may mutate these rows
- payload identity must be checked against `campaignKey` and `entityCui`
- `entityCui` must resolve through the entity module before create or update
- writes must validate and normalize before persistence
- writes must use optimistic concurrency with `expectedUpdatedAt`
- writes must serialize by logical config identity through a transaction-scoped
  advisory lock
- reads must validate persisted envelope and payload before returning data
- config history is not derived from `auditEvents`

### Query and Reporting Boundaries

This design intentionally does not make config rows part of existing
campaign-admin interaction or entity aggregates.

Implications:

- configured-but-inactive entities still need a dedicated config list/read path
- existing entity and interaction reporting remains unchanged
- synthetic config rows must not be used as a shortcut to widen entity rollups

If the admin UI later needs rich filtering, sorting, or reporting over config
fields, that is a signal that the `no new table` constraint is beginning to
cost more than it saves.

### Migration Strategy

This design is a constrained backing-store choice, not an ideal long-term
domain model.

To preserve future migration flexibility:

- keep all key construction in one module
- keep payloads strict and versioned
- avoid leaking learning-progress row shapes outside the module
- keep config consumption behind a dedicated read API
- snapshot effective values into operational metadata when workflows execute
- keep the v1 route/config registration explicit to `funky`

If the project later allows a dedicated table, migration can copy rows from the
synthetic campaign buckets into a real relational store without changing
consumers.

## Alternatives Considered

- New dedicated table.
  Rejected for this iteration because the current constraint explicitly forbids
  adding a new table. This would otherwise be the cleaner long-term domain
  model.
- File-backed config modeled after `datasets`.
  Rejected because the requirement is runtime admin management, not
  config-as-code.
- `advanced-map-datasets`.
  Rejected because it is user-owned dataset storage with row-oriented and map
  semantics, not a generic shared config registry.
- `EntityProfiles`.
  Rejected because it is scraped budget-domain state stored in the budget
  database, not campaign-scoped admin-owned runtime configuration.
- Notification or outbox metadata.
  Rejected because those stores are lifecycle-specific and should not become
  the authority for mutable admin config.
- Institution correspondence thread metadata.
  Rejected because thread records exist only after correspondence activity and
  are the wrong ownership boundary.
- Single campaign-wide blob in `userinteractions`.
  Rejected because it creates one hot row, one larger failure domain, and a
  harder migration path.
- Generic key/value JSON payload.
  Rejected because it would weaken validation, invite schema drift, and make
  admin/server interfaces less explicit.
- `scope = { type: "entity", entityCui }`.
  Rejected because it makes config rows resemble normal entity interactions and
  increases the risk of accidental inclusion in entity interaction pipelines.

## Consequences

**Positive**

- Reuses an existing durable store without a schema migration for a new table.
- Inherits a strong public-write safety boundary from the internal-record
  mechanism.
- Keeps the admin and module interfaces narrow and explicit.
- Supports exact lookup and campaign-scoped listing with the current primary key
  and prefix indexes.
- Preserves a clean path to future migration because keying and payload shape
  are centralized.

**Negative**

- `userinteractions` remains a semantic compromise because it is primarily a
  per-user learning-state store.
- There is no first-class delete API or config-specific history model.
- Generic raw analytics over `userinteractions` could become misleading if
  future queries do not account for internal synthetic rows.
- Rich filtering and reporting over config fields will remain awkward compared
  with a real table.
- Admin config pages still need dedicated collection and item routes and cannot
  reuse current campaign-admin interaction endpoints.

## References

- [`src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql)
- [`src/infra/database/user/advisory-locks.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/advisory-locks.ts)
- [`src/infra/database/budget/migrations/20260326_add_entityprofiles.sql`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/budget/migrations/20260326_add_entityprofiles.sql)
- [`src/modules/entity/core/ports.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/entity/core/ports.ts)
- [`src/modules/campaign-admin/shell/rest/authorization.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin/shell/rest/authorization.ts)
- [`src/modules/learning-progress/core/internal-records.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/internal-records.ts)
- [`src/modules/learning-progress/core/usecases/sync-events.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/sync-events.ts)
- [`src/modules/learning-progress/core/usecases/weekly-digest-cursor.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/weekly-digest-cursor.ts)
- [`src/modules/learning-progress/core/usecases/update-interaction-review.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts)
- [`src/modules/learning-progress/core/ports.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/ports.ts)
- [`src/modules/learning-progress/core/types.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/types.ts)
- [`src/modules/learning-progress/shell/repo/learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [`src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts)
- [`docs/specs/specs-202604122011-campaign-admin-entities-api.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604122011-campaign-admin-entities-api.md)
- [`src/modules/campaign-admin-stats/shell/repo/campaign-admin-stats-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-stats/shell/repo/campaign-admin-stats-repo.ts)
- [`src/modules/advanced-map-datasets/core/types.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/advanced-map-datasets/core/types.ts)
- [`src/modules/datasets/shell/repo/fs-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/datasets/shell/repo/fs-repo.ts)
- [`src/modules/campaign-admin-notifications/shell/rest/routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/rest/routes.ts)
- [`src/modules/learning-progress/core/campaign-admin-config.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts)
