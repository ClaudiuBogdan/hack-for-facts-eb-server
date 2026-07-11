# User Data Store v2 — Module & Contract Design

**Status:** Design — no implementation
**Companion documents:** `USER_DATA_STORE_V2_DESIGN.md` (the what and why — its decisions are final),
`TEST-SUPPORT-KIT-DESIGN.md` (the test infrastructure this module's tests use),
`NOTIFICATION-PLATFORM-MODULE-DESIGN.md` (the structural precedent this document follows)

This document translates the User Data Store v2 specification into concrete modules,
files, interfaces, and contracts. Every signature here is a commitment: implementation
should follow these contracts, and deviations should be recorded back into this
document. Style follows the codebase's verified conventions: `Result<T,E>` (neverthrow)
in core, TypeBox `*Schema` + `Static<typeof X>` for anything crossing an HTTP or JSONB
boundary, discriminated-union errors with `create*` factories, `KyselyXRepo implements
XPort` + `makeXRepo(db)` shell factories, and an `index.ts` barrel exporting only what
`build-app.ts` needs.

An external design review (2026-07-11, gpt-5.6-sol, high reasoning) ran against the
specification and the selected system design before this document was written. All
fourteen findings were incorporated; §10 records how, including the one partial
acceptance.

## 1. Module layout

One module: `src/modules/user-data/`. Feature modules (campaign admin surfaces, review
workflows) consume this module's usecases; they never touch its tables.

```
src/modules/user-data/
├── index.ts                          # Barrel: make* factories, ports, errors, route factories, registry
├── core/
│   ├── types.ts                      # RecordIdentity, ActorContext, CurrentRecord, RecordView,
│   │                                 # UserDataEvent, commands, PlannedMutation, MutationOutcome, Page<T>
│   ├── schemas.ts                    # TypeBox atoms crossing HTTP/JSONB boundaries
│   ├── errors.ts                     # UserDataError union + create* factories (every §15.1 error)
│   ├── ports.ts                      # UserDataMutationPort, UserDataReadPort, UserDataAdminReadPort,
│   │                                 # UserDataErasurePort, MutationRateLimiterPort; re-exports Clock/IdGenerator
│   ├── registry/
│   │   ├── types.ts                  # CategoryDefinition, AnnotationNamespaceDefinition, QueryFieldDefinition
│   │   ├── registry.ts               # CategoryRegistry + makeCategoryRegistry (hash checks, fail-fast)
│   │   └── categories/
│   │       ├── index.ts              # ALL_USER_DATA_CATEGORIES: readonly CategoryDefinition[]
│   │       ├── funky-interaction.ts  # v1 launch category (campaign-interaction family)
│   │       └── learning-progress.ts  # v1 launch category (learning-progress family)
│   ├── planners/
│   │   ├── plan-create-or-replace.ts # PURE
│   │   ├── plan-annotate.ts          # PURE
│   │   ├── plan-delete.ts            # PURE
│   │   ├── plan-restore.ts           # PURE
│   │   ├── plan-migrate.ts           # PURE (schema-migration / payload-repair path)
│   │   └── shared.ts                 # PURE: after-image assembly, revision+1, scope rules, size checks
│   ├── sync-cursor.ts                # PURE opaque cursor codec (encode / decode / validate)
│   └── usecases/                     # one file per usecase (§2.7 inventory)
├── shell/
│   ├── repo/
│   │   ├── kysely-user-data-mutation-repo.ts   # THE load-bearing commit transaction (§4.1)
│   │   ├── kysely-user-data-read-repo.ts
│   │   ├── kysely-user-data-admin-read-repo.ts
│   │   ├── kysely-user-data-erasure-repo.ts
│   │   └── redis-mutation-rate-limiter.ts
│   ├── rest/
│   │   ├── schemas.ts                # request/response TypeBox
│   │   ├── owner-routes.ts           # /api/user-data/*
│   │   ├── admin-routes.ts           # /api/admin/user-data/*
│   │   └── route-errors.ts           # UserDataError → HTTP mapping (§4.4)
│   └── jobs/
│       ├── receipt-cleanup-job.ts    # BullMQ repeatable
│       └── reconcile-job.ts          # BullMQ repeatable, report-only
```

Cross-cutting determinism ports are the existing shared ones — `src/common/ports/clock.ts`
(`Clock`) and `src/common/ports/id-generator.ts` (`IdGenerator`), with `systemClock` /
`uuidIds` adapters in infra. Core cannot import infra (ESLint boundary), so accidental
nondeterminism in core fails CI.

One promotion outside the module: the hardened canonical-JSON serializer moves from
`src/modules/notification-platform/core/shared/canonical-json.ts` to
`src/common/canonical-json/index.ts`; the notification-platform file becomes a
re-export. Both schema hashes and canonical request hashes use it. There is exactly one
canonicalization in the codebase.

## 2. Core contracts

### 2.1 Shared types (`core/types.ts`)

```ts
export interface RecordIdentity {
  ownerId: string; // Clerk-derived, never from a request body
  category: string;
  logicalKey: string;
}

export type ActorContext =
  | { type: 'owner' } // the authenticated owner of the record
  | { type: 'system'; source: string } // e.g. 'schema-migration', 'weekly-digest'
  | { type: 'admin'; actorId: string; reason: string }; // identity + required reason

export type RecordStatus = 'active' | 'deleted';

export interface RecordTarget {
  targetType: string;
  targetId: string;
}

/** Current-state row as core sees it (repo output). */
export interface CurrentRecord {
  recordId: string;
  identity: RecordIdentity;
  target: RecordTarget | null;
  schemaVersion: number;
  schemaHash: string;
  revision: number;
  status: RecordStatus;
  payload: Record<string, unknown> | null; // null ⇔ tombstone
  annotations: Record<string, Record<string, unknown>> | null; // namespace-keyed
  lastEventSeq: string; // BIGINT as decimal string — never through JS number
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  privacyRedactedAt: Date | null;
}

/** Wire view returned by every read and every accepted mutation (read-your-writes). */
export interface RecordView {
  recordId: string;
  category: string;
  logicalKey: string;
  target: RecordTarget | null;
  schemaVersion: number;
  revision: number;
  status: RecordStatus;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null; // read-only for clients
  createdAt: string; // ISO
  updatedAt: string;
  deletedAt: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
```

### 2.2 Commands and the planned mutation

All five mutations are planned by pure functions and executed by one port method. The
planner output carries **one canonical after-image**; the adapter mechanically derives
both the event row and the snapshot row from it, so §6.3 event/current parity cannot be
violated by construction.

```ts
export interface AfterImage {
  status: RecordStatus;
  payload: Record<string, unknown> | null; // null ⇔ deleted
  annotations: Record<string, Record<string, unknown>> | null;
  schemaVersion: number;
  schemaHash: string;
}

export type MutationOperation =
  | 'create'
  | 'replace'
  | 'annotate'
  | 'delete'
  | 'restore'
  | 'migrate';
export type MutationScope = 'payload' | 'annotation';

export interface ReceiptClaim {
  requesterId: string; // owner for owner writes; acting principal for annotation writes
  idempotencyKeyHash: string; // sha256 of the client key
  canonicalRequestHash: string; // canonical-JSON hash of the full command
}

export interface PlannedMutation {
  operation: MutationOperation;
  scope: MutationScope;
  annotationNamespace: string | null; // required iff scope === 'annotation'
  identity: RecordIdentity;
  recordId: string; // usecase-generated (IdGenerator) on create; existing otherwise
  eventId: string; // usecase-generated
  target: RecordTarget | null; // immutable after create
  expectedRevision: number; // 0 = create; CAS guard re-checked inside commit
  nextRevision: number; // always expectedRevision + 1
  afterImage: AfterImage;
  actor: ActorContext;
  clientOccurredAt: Date | null; // informational only
  receipt: ReceiptClaim;
  quota: { maxRecordsInCategory: number } | null; // present on create; enforced under the lock
}
```

Planner signatures (all PURE, in `core/planners/`):

```ts
planCreateOrReplace(entry: ResolvedCategory, current: CurrentRecord | null, cmd: ReplaceCommand, ctx: PlanContext): Result<PlannedMutation, UserDataError>
planAnnotate(entry: ResolvedCategory, current: CurrentRecord, cmd: AnnotateCommand, ctx: PlanContext): Result<PlannedMutation, UserDataError>
planDelete(entry: ResolvedCategory, current: CurrentRecord, cmd: DeleteCommand, ctx: PlanContext): Result<PlannedMutation, UserDataError>
planRestore(entry: ResolvedCategory, current: CurrentRecord, cmd: RestoreCommand, ctx: PlanContext): Result<PlannedMutation, UserDataError>
planMigrate(entry: ResolvedCategory, current: CurrentRecord, cmd: MigrateCommand, ctx: PlanContext): Result<PlannedMutation, UserDataError>
```

`PlanContext` carries `{ ids: IdGenerator, requesterId: string, actor: ActorContext }`.
Planners enforce every §9 rule with no I/O: schema resolution and validation, byte /
depth / string / collection limits, logical-key syntax, target immutability, scope
separation (a payload plan copies `current.annotations` untouched into the after-image;
an annotation plan copies `current.payload` untouched), tombstone rules (delete ⇒ null
payload AND annotations; restore does not resurrect annotations), actor/namespace
allow-lists, and revision arithmetic. Property: for every accepted plan,
`nextRevision === expectedRevision + 1` and the after-image is complete.

### 2.3 Errors (`core/errors.ts`)

One discriminated union covering spec §15.1, with `create*` factories. Error payloads
never contain user payload or annotation content.

```ts
export type UserDataError =
  | { type: 'UnknownCategory'; category: string }
  | { type: 'UnknownSchemaVersion'; category: string; schemaVersion: number }
  | { type: 'SchemaVersionWriteDisabled'; category: string; schemaVersion: number } // upgrade required
  | { type: 'InvalidPayload'; violations: readonly string[] } // JSON-pointer paths + rule ids, no values
  | { type: 'PayloadTooLarge'; limitBytes: number }
  | { type: 'InvalidLogicalKey'; rule: string }
  | { type: 'InvalidTarget'; rule: string }
  | { type: 'RevisionConflict'; current: RecordView } // current owned record per §9.2
  | { type: 'IdempotencyConflict' } // same key, different canonical request
  | { type: 'UnknownAnnotationNamespace'; category: string; namespace: string }
  | { type: 'ActorNotAllowed'; namespace: string; actorType: string }
  | { type: 'NotFound'; category: string; logicalKey?: string; recordId?: string }
  | { type: 'RecordDeleted'; current: RecordView } // mutation other than restore on a tombstone
  | { type: 'RecordNotDeleted' } // restore on an active record
  | { type: 'QuotaExceeded'; category: string; limit: number }
  | { type: 'RateLimited'; retryAfterSeconds: number }
  | { type: 'AdminAccessNotConfigured'; category: string } // category declares no admin permission
  | { type: 'Forbidden'; reason: string }
  | { type: 'InvalidCursor' }
  | { type: 'DatabaseError'; message: string; retryable: boolean };
```

### 2.4 Category registry (`core/registry/`)

The registry is the single place a category (= campaign/tenant boundary) declares
itself. Adding a category or schema version is a reviewed deployment.

```ts
export interface AnnotationNamespaceDefinition {
  namespace: string; // e.g. 'review'
  schema: TSchema; // immutable TypeBox schema (bounded depth/strings/collections)
  schemaHash: string; // canonical-JSON sha256, verified at boot
  maxBytes: number;
  allowedActorTypes: readonly ('system' | 'admin')[]; // NEVER 'owner'
  redactor: (annotation: Record<string, unknown>) => Record<string, unknown>; // deletion redaction
}

export interface QueryFieldDefinition {
  name: string; // public filter name on admin queries
  path: readonly string[]; // exact JSON path into payload or annotations
  scalar: 'string' | 'integer' | 'boolean';
  operators: readonly ('eq' | 'in')[]; // extend only with a matching index
  requiredIndex: string; // name of the expression index that must exist
}

export interface CategorySchemaVersion {
  version: number;
  schema: TSchema; // immutable; new shape = new version
  schemaHash: string; // verified at boot against canonical hash of `schema`
  readable: boolean;
  writeEnabled: boolean; // compatibility window control (§8.2)
  migrateToNext?: (payload: Record<string, unknown>) => Result<Record<string, unknown>, string>;
}

export interface CategoryDefinition {
  category: string; // 'funky.interaction' — campaign encoded in the name
  schemaVersions: readonly CategorySchemaVersion[];
  maxPayloadBytes: number; // ≤ 65536 global ceiling
  logicalKey: { pattern: RegExp; maxLength: number };
  target: { required: boolean; allowedTypes: readonly string[] } | null; // null = targets forbidden
  redactor: (payload: Record<string, unknown>) => Record<string, unknown>; // deletion redaction
  queryFields: readonly QueryFieldDefinition[];
  annotationNamespaces: readonly AnnotationNamespaceDefinition[];
  maxRecordsPerOwner: number; // per-owner quota (§13.1)
  writeRateLimitPerMinute: number; // per-owner mutation rate (§13.1)
  adminPermission: string | null; // null ⇒ NO admin read/annotation path exists (fail-closed)
}

export interface CategoryRegistry {
  get(category: string): CategoryDefinition | undefined;
  resolve(category: string, schemaVersion: number): Result<ResolvedCategory, UserDataError>;
  list(): readonly CategoryDefinition[];
}

export const makeCategoryRegistry = (
  categories: readonly CategoryDefinition[]
): Result<CategoryRegistry, string>;
// Boot-time validation, fail-fast: unique category ids; canonical hash of every schema
// equals its declared schemaHash (drift detection); version numbers dense and unique;
// namespace names unique per category and never writable by 'owner'; every queryField
// names its required index; byte limits within the global ceiling.
```

**v1 launch categories** (final ids confirmed by the cutover preflight inventory):

| Category            | Family                            | Key syntax                                                  | Target                      | Quota / rate       | Admin permission                                                                          |
| :------------------ | :-------------------------------- | :---------------------------------------------------------- | :-------------------------- | :----------------- | :---------------------------------------------------------------------------------------- |
| `funky.interaction` | campaign interactions/submissions | legacy keys preserved verbatim (`funky:interaction:…` etc.) | `entity` (CUI) where scoped | 500 / 60 per min   | `FUNKY_CAMPAIGN_ADMIN_PERMISSION` (`campaign:funky_admin`, `src/common/campaign-keys.ts`) |
| `learning.progress` | learning-progress sync            | legacy learning-progress record keys preserved verbatim     | none                        | 2000 / 120 per min | none — no admin path                                                                      |

Schema v1 for each mirrors the legacy client payload contract minus server-owned fields
(the legacy `review` field is NOT part of the owner payload; the review workflow arrives
later as a registered `review` annotation namespace, decided in its own prerequisite
document). Exact TypeBox definitions are authored in chunk 1 from
`src/modules/learning-progress/core/types.ts`, with bounded field sizes.

### 2.5 Sync cursor codec (`core/sync-cursor.ts`)

```ts
export interface SyncCursor {
  lastSeq: string; // BIGINT as validated decimal string
  cycleHighWater: string | null; // null ⇒ next request starts a new cycle
  category: string | null; // filter binding; mismatched reuse ⇒ InvalidCursor
}
export const encodeSyncCursor = (cursor: SyncCursor): string; // base64(JSON), opaque
export const decodeSyncCursor = (raw: string): Result<SyncCursor, UserDataError>; // InvalidCursor on malformed
```

Cursors are opaque but **not MAC-signed**: a tampered cursor can only affect the
caller's own owner-scoped pagination (every read is owner-bound at the port), so the
codec guarantees validation, not tamper resistance. Sequences never pass through a JS
`number`.

### 2.6 Ports (`core/ports.ts`)

Owner scope is mandatory in every read signature — no global fetch-then-authorize shape
can exist. All methods return `Promise<Result<…, UserDataError>>`.

```ts
export type MutationOutcome =
  | { kind: 'committed'; result: MutationResultData }
  | { kind: 'replayed'; result: MutationResultData } // exact original result (§7.3)
  | { kind: 'revisionConflict'; current: CurrentRecord }
  | { kind: 'idempotencyConflict' }
  | { kind: 'quotaExceeded'; limit: number };

export interface MutationResultData {
  record: CurrentRecord; // resulting state — mutation responses need no follow-up read
  eventId: string;
  eventSeq: string;
  recordedAt: Date;
}

export interface UserDataMutationPort {
  /** Plain read for the optimistic pipeline; commit re-checks CAS inside its transaction. */
  getForMutation(identity: RecordIdentity): Promise<Result<CurrentRecord | null, UserDataError>>;
  /** THE load-bearing transaction (§4.1). */
  commit(plan: PlannedMutation): Promise<Result<MutationOutcome, UserDataError>>;
  /** Read-only probe used to skip the rate limiter on exact retries (§2.7 pipeline). */
  probeReceipt(
    claim: ReceiptClaim
  ): Promise<Result<'absent' | 'match' | 'mismatch', UserDataError>>;
}

export interface UserDataReadPort {
  findByKey(
    ownerId: string,
    category: string,
    logicalKey: string
  ): Promise<Result<CurrentRecord | null, UserDataError>>;
  findById(ownerId: string, recordId: string): Promise<Result<CurrentRecord | null, UserDataError>>;
  listByCategory(
    ownerId: string,
    category: string,
    page: { limit: number; cursor: string | null }
  ): Promise<Result<Page<CurrentRecord>, UserDataError>>;
  findByTarget(
    ownerId: string,
    category: string,
    target: RecordTarget
  ): Promise<Result<CurrentRecord[], UserDataError>>;
  /** One SQL statement (single snapshot): page + owner high-water together (§4.2). */
  syncSince(
    ownerId: string,
    cursor: SyncCursor,
    limit: number
  ): Promise<Result<SyncPage, UserDataError>>;
  historyByRecord(
    ownerId: string,
    recordId: string,
    page: { limit: number; beforeRevision: number | null }
  ): Promise<Result<Page<UserDataEvent>, UserDataError>>;
}

export interface SyncPage {
  items: CurrentRecord[]; // snapshots and tombstones, ordered by lastEventSeq
  ownerHighWater: string; // MAX(last_event_seq) over this owner's committed rows, same snapshot
}

export interface UserDataAdminReadPort {
  // Category-bound only. No cross-category method exists (fail-closed by construction).
  adminListByCategory(
    category: string,
    filters: AdminRecordFilters,
    page: { limit: number; cursor: string | null }
  ): Promise<Result<Page<CurrentRecord>, UserDataError>>;
  adminHistoryByCategory(
    category: string,
    recordId: string,
    page: { limit: number; beforeRevision: number | null }
  ): Promise<Result<Page<UserDataEvent>, UserDataError>>;
}
// AdminRecordFilters: status, target, createdAt range, and registered query fields
// (validated against the category's QueryFieldDefinition list; unknown field/operator ⇒ InvalidPayload).

export interface UserDataErasurePort {
  /** Same per-owner advisory lock as mutations; one transaction; maintenance GUC set locally;
   *  registry redactors applied to current rows, events, and annotations; receipts deleted.
   *  Idempotent — re-running for an already-redacted owner is a no-op. */
  eraseOwner(input: {
    ownerId: string;
    anonymizedOwnerId: string;
    redactors: ResolvedRedactors; // built by the usecase from the registry
    now: Date;
  }): Promise<Result<{ records: number; events: number; receipts: number }, UserDataError>>;
}

export interface MutationRateLimiterPort {
  /** Fixed window per (ownerId, category). Fail-open on limiter backend failure (logged);
   *  quotas remain DB-enforced regardless. */
  consume(
    ownerId: string,
    category: string,
    limitPerMinute: number
  ): Promise<
    Result<{ allowed: true } | { allowed: false; retryAfterSeconds: number }, UserDataError>
  >;
}
```

### 2.7 Usecase inventory (`core/usecases/`)

Deps objects include `clock: Clock`, `ids: IdGenerator`, `logger` (payloads and
annotations are never logged). Every mutation usecase runs the same pipeline:

> resolve category/schema → `probeReceipt` (exact retry? skip limiter) → rate limiter →
> `getForMutation` → pure planner → `commit` → map outcome to `Result`

| Usecase                    | Actor        | Port deps                        | Notes                                                                                                                  |
| :------------------------- | :----------- | :------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `replace-record`           | owner        | mutation, rateLimiter, registry  | create (expectedRevision 0) or full replace; annotations copied untouched                                              |
| `annotate-record`          | system/admin | mutation, rateLimiter, registry  | namespace CAS write; NOT exported to owner routes; admin ⇒ actorId + reason required                                   |
| `delete-record`            | owner        | mutation, rateLimiter, registry  | tombstone; clears payload AND annotations                                                                              |
| `restore-record`           | owner        | mutation, rateLimiter, registry  | requires tombstone revision + complete payload; does not resurrect annotations                                         |
| `migrate-record`           | system       | mutation, registry               | §8.3 maintenance path (schema migration / payload repair); no REST surface                                             |
| `get-record`               | owner        | read                             | by key or by record id                                                                                                 |
| `list-records`             | owner        | read, registry                   | keyset pagination; optional target filter                                                                              |
| `sync-records`             | owner        | read                             | cursor codec + `syncSince`; returns snapshots + tombstones + next opaque cursor                                        |
| `get-record-history`       | owner        | read                             | paginated events, integrity/provenance markers included                                                                |
| `admin-list-records`       | admin        | adminRead, registry              | fail-closed: category must declare `adminPermission`; usecase re-checks the granted permission equals the declared one |
| `admin-get-record-history` | admin        | adminRead, registry              | same double gate                                                                                                       |
| `anonymize-user-data`      | system       | erasure, registry                | builds redactor set from registry; called from the clerk-webhooks anonymizer                                           |
| `cleanup-receipts`         | system (job) | mutation-repo maintenance method | deletes receipts past their 30-day expiry                                                                              |
| `reconcile-store`          | system (job) | read-repo maintenance method     | §14 checks; reports, never rewrites                                                                                    |

## 3. Database tables

Added to `src/infra/database/user/schema.sql`; Kysely types regenerated. Full DDL is
normative; column names are the contract for the repos.

```sql
CREATE TABLE user_data_records (
  record_id           UUID PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  category            TEXT NOT NULL,
  logical_key         TEXT NOT NULL,
  target_type         TEXT,
  target_id           TEXT,
  schema_version      INTEGER NOT NULL,
  schema_hash         TEXT NOT NULL,
  revision            BIGINT NOT NULL CHECK (revision > 0),
  status              TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  payload             JSONB,
  annotations         JSONB,
  last_event_seq      BIGINT NOT NULL,
  last_event_id       UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ,
  privacy_redacted_at TIMESTAMPTZ,
  CONSTRAINT user_data_records_identity UNIQUE (owner_id, category, logical_key),
  CONSTRAINT user_data_records_lifecycle CHECK (
    (status = 'active'  AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object' AND deleted_at IS NULL)
    OR
    (status = 'deleted' AND payload IS NULL AND annotations IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT user_data_records_target CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CONSTRAINT user_data_records_annotations CHECK (annotations IS NULL OR jsonb_typeof(annotations) = 'object'),
  CONSTRAINT user_data_records_payload_size CHECK (payload IS NULL OR pg_column_size(payload) <= 65536)
);

CREATE INDEX user_data_records_sync_idx   ON user_data_records (owner_id, last_event_seq);
CREATE INDEX user_data_records_list_idx   ON user_data_records (owner_id, category, record_id);
CREATE INDEX user_data_records_target_idx ON user_data_records (owner_id, category, target_type, target_id)
  WHERE target_type IS NOT NULL;
-- Registered query fields add expression indexes per category (named in QueryFieldDefinition).

CREATE SEQUENCE user_data_event_seq;

CREATE TABLE user_data_events (
  event_seq            BIGINT PRIMARY KEY, -- nextval('user_data_event_seq') inside commit
  event_id             UUID NOT NULL UNIQUE,
  record_id            UUID NOT NULL REFERENCES user_data_records (record_id),
  owner_id             TEXT NOT NULL,
  category             TEXT NOT NULL,
  logical_key          TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  revision             BIGINT NOT NULL,
  operation            TEXT NOT NULL CHECK (operation IN ('create','replace','annotate','delete','restore','migrate','legacy_import')),
  scope                TEXT NOT NULL CHECK (scope IN ('payload','annotation')),
  annotation_namespace TEXT,
  schema_version       INTEGER NOT NULL,
  schema_hash          TEXT NOT NULL,
  payload              JSONB, -- after-image: resulting owner payload (null after deletion)
  annotations          JSONB, -- after-image: resulting annotations (null when none / after deletion)
  actor_type           TEXT NOT NULL CHECK (actor_type IN ('owner','system','admin')),
  actor_id             TEXT,
  actor_reason         TEXT,
  provenance           TEXT NOT NULL CHECK (provenance IN ('live','legacy')),
  integrity            TEXT NOT NULL CHECK (integrity IN ('verified','unverified')),
  recorded_at          TIMESTAMPTZ NOT NULL,
  client_occurred_at   TIMESTAMPTZ,
  source_event_id      TEXT,
  source_occurred_at   TIMESTAMPTZ,
  privacy_redacted_at  TIMESTAMPTZ,
  CONSTRAINT user_data_events_record_revision UNIQUE (record_id, revision),
  CONSTRAINT user_data_events_annotate_ns CHECK ((scope = 'annotation') = (annotation_namespace IS NOT NULL)),
  CONSTRAINT user_data_events_admin_attrib CHECK (actor_type <> 'admin' OR (actor_id IS NOT NULL AND actor_reason IS NOT NULL))
);

CREATE INDEX user_data_events_owner_idx ON user_data_events (owner_id, event_seq);

CREATE TABLE user_data_idempotency_receipts (
  requester_id           TEXT NOT NULL,
  idempotency_key_hash   TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  event_id               UUID NOT NULL,
  event_seq              BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL, -- created_at + 30 days
  PRIMARY KEY (requester_id, idempotency_key_hash)
);
```

**Append-only trigger** (hardened per review finding #9 — column-set comparison, not
just a flag):

```sql
CREATE FUNCTION user_data_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_data_events is append-only';
  END IF;
  -- UPDATE: only privacy redaction, only under the maintenance flag, only the
  -- redaction column set. Schema migration APPENDS events; it has no update path.
  IF current_setting('app.user_data_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'user_data_events may only be updated by the maintenance path';
  END IF;
  IF NEW.privacy_redacted_at IS NULL THEN
    RAISE EXCEPTION 'user_data_events update must record privacy redaction';
  END IF;
  IF NEW.event_seq IS DISTINCT FROM OLD.event_seq
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.annotation_namespace IS DISTINCT FROM OLD.annotation_namespace
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.integrity IS DISTINCT FROM OLD.integrity
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'user_data_events update touches immutable columns';
  END IF;
  RETURN NEW; -- mutable under redaction: owner_id, payload, annotations, actor_id,
              -- client_occurred_at, source_event_id, source_occurred_at, privacy_redacted_at
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_data_events_append_only
  BEFORE UPDATE OR DELETE ON user_data_events
  FOR EACH ROW EXECUTE FUNCTION user_data_events_append_only();
```

## 4. Shell contracts

### 4.1 The load-bearing commit transaction (`kysely-user-data-mutation-repo.ts`)

Pinned order — this is the contract the fake must emulate and the real-PG contract
suite pins:

```
BEGIN;
  -- 1. Per-owner serialization (two-arg advisory lock, module namespace constant).
  --    Collisions across owners only over-serialize; that is safe.
  SELECT pg_advisory_xact_lock(USER_DATA_LOCK_NS, hashtext(plan.identity.ownerId));
       -- USER_DATA_LOCK_NS = 0x5544_0001 (documented int4 constant)

  -- 2. Receipt replay check (BEFORE CAS, so a retry of an accepted mutation replays
  --    even though the revision has advanced).
  SELECT * FROM user_data_idempotency_receipts
   WHERE requester_id = $req AND idempotency_key_hash = $kh;
  --    found + same canonical_request_hash  ⇒ load the accepted event + current row,
  --                                           return { kind: 'replayed' }
  --    found + different hash               ⇒ return { kind: 'idempotencyConflict' }

  -- 3. Current row: SELECT ... FOR UPDATE by identity (or none for create).
  --    CAS: row.revision must equal plan.expectedRevision (0 = row must not exist).
  --    Mismatch ⇒ { kind: 'revisionConflict', current }.

  -- 4. Creates only: authoritative quota re-check under the lock.
  --    COUNT(*) by (owner_id, category) >= plan.quota.maxRecordsInCategory
  --      ⇒ { kind: 'quotaExceeded' }.

  -- 5. seq := nextval('user_data_event_seq')

  -- 6. Snapshot FIRST (the event FK requires the current row):
  --    INSERT INTO user_data_records ... ON CONFLICT (owner_id, category, logical_key)
  --      DO NOTHING  -- create path; no row inserted ⇒ concurrent create won the race:
  --                  -- re-read committed row, return { kind: 'revisionConflict', current }
  --    or UPDATE user_data_records SET ... WHERE record_id = $id AND revision = $expected
  --      -- zero rows ⇒ revisionConflict (belt over the FOR UPDATE braces)

  -- 7. INSERT INTO user_data_events (event_seq := seq, full after-image, actor fields).

  -- 8. INSERT INTO user_data_idempotency_receipts (complete row).
  --    Unique-violation (23505) here = a concurrent same-requester key racing under a
  --    DIFFERENT owner lock: the insert waits on the in-flight duplicate; on violation
  --    re-select the committed receipt and return replayed / idempotencyConflict.
  --    Never leak the constraint error.
COMMIT;  -- failure anywhere rolls back all rows; sequence gaps are harmless
```

`getForMutation` and `probeReceipt` are plain reads. Receipt cleanup
(`deleteExpiredReceipts(now)`) is a maintenance method on the same repo.

### 4.2 Read repos

`syncSince` must compute the page and the owner high-water in **one SQL statement**
(one snapshot) — two statements under READ COMMITTED would reintroduce the skipped-row
race the advisory lock exists to prevent:

```sql
WITH page AS (
  SELECT * FROM user_data_records
   WHERE owner_id = $1 AND last_event_seq > $after
     AND ($cycleHw IS NULL OR last_event_seq <= $cycleHw)
   ORDER BY last_event_seq
   LIMIT $n
)
SELECT (SELECT COALESCE(MAX(last_event_seq), 0) FROM user_data_records WHERE owner_id = $1) AS owner_high_water,
       page.* FROM page;
```

The sync usecase starts a cycle by capturing `ownerHighWater` into the cursor and ends
the cycle when `lastSeq >= cycleHighWater`. Admin list queries always carry
`WHERE category = $1` and translate registered query-field filters into their
expression-indexed predicates; unknown fields or operators are rejected in core before
SQL is built.

### 4.3 REST routes

Owner routes (`owner-routes.ts`, Clerk auth, ownerId from session only, unversioned
paths per spec §15.1):

| Method | Path                                                   | Usecase            |
| :----- | :----------------------------------------------------- | :----------------- |
| PUT    | `/api/user-data/records/:category/:logicalKey`         | replace-record     |
| DELETE | `/api/user-data/records/:category/:logicalKey`         | delete-record      |
| POST   | `/api/user-data/records/:category/:logicalKey/restore` | restore-record     |
| GET    | `/api/user-data/records/:category/:logicalKey`         | get-record         |
| GET    | `/api/user-data/records/:category`                     | list-records       |
| GET    | `/api/user-data/records/:category/:logicalKey/history` | get-record-history |
| GET    | `/api/user-data/sync`                                  | sync-records       |

Mutation requests carry `schemaVersion`, `expectedRevision`, `idempotencyKey`,
`payload`, optional `target` (create only), optional `clientOccurredAt`. Every accepted
mutation responds with the resulting `RecordView` + `eventId` + server timestamps.
There is **no owner annotation route** and no generic admin write route.

Admin routes (`admin-routes.ts`, Clerk auth + `CampaignAdminPermissionAuthorizer`
(`src/modules/campaign-admin/core/ports.ts`) checked against the category's declared
`adminPermission`; the usecase re-checks the same declaration — double gate):

| Method | Path                                                       | Usecase                  |
| :----- | :--------------------------------------------------------- | :----------------------- |
| GET    | `/api/admin/user-data/:category/records`                   | admin-list-records       |
| GET    | `/api/admin/user-data/:category/records/:recordId/history` | admin-get-record-history |

A category with `adminPermission: null` returns the same 404 shape as an unknown
category — no admin surface exists for it.

### 4.4 Error mapping (`route-errors.ts`)

| Error                                                                                                       | HTTP | Notes                                                           |
| :---------------------------------------------------------------------------------------------------------- | :--- | :-------------------------------------------------------------- |
| UnknownCategory / UnknownSchemaVersion / InvalidPayload / InvalidLogicalKey / InvalidTarget / InvalidCursor | 400  | violations are paths + rule ids, never values                   |
| SchemaVersionWriteDisabled                                                                                  | 409  | body `code: 'UPGRADE_REQUIRED'`                                 |
| RevisionConflict                                                                                            | 409  | body carries `current` RecordView                               |
| IdempotencyConflict                                                                                         | 409  | body `code: 'IDEMPOTENCY_KEY_REUSED'`                           |
| RecordDeleted / RecordNotDeleted                                                                            | 409  |                                                                 |
| NotFound / AdminAccessNotConfigured                                                                         | 404  | admin-not-configured is indistinguishable from unknown category |
| Forbidden / ActorNotAllowed / UnknownAnnotationNamespace                                                    | 403  |                                                                 |
| PayloadTooLarge                                                                                             | 413  |                                                                 |
| QuotaExceeded                                                                                               | 429  | body `code: 'QUOTA_EXCEEDED'`, limit                            |
| RateLimited                                                                                                 | 429  | `Retry-After` header                                            |
| DatabaseError (and any 5xx)                                                                                 | 500  | generic body; real error logged server-side only                |

### 4.5 Jobs (`shell/jobs/`)

Two repeatable BullMQ jobs on the existing queue client (`src/infra/queue/client.ts`,
new names `UD_RECEIPT_CLEANUP: 'ud-receipt-cleanup'`, `UD_RECONCILE: 'ud-reconcile'`):
receipt cleanup daily; reconciliation hourly, running the §14 checks over recent
writes and **reporting only** (log + metric; it never rewrites the ledger).

### 4.6 Erasure integration

`makeUserDataStoreEraser` (module barrel) wraps the `anonymize-user-data` usecase. The
central clerk-webhooks anonymizer
(`src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts`) gains an
optional `userDataStoreEraser` dep invoked after its legacy-table transaction, in its
own transaction (both sides idempotent — the webhook retries on failure); its counts
join the anonymization summary. The eraser: same per-owner advisory lock as mutations,
maintenance GUC set locally (`SET LOCAL app.user_data_maintenance = 'on'`), owner id →
existing deterministic deletion pseudonym, registry category + namespace redactors
applied to current rows and events, PII metadata nulled, receipts deleted,
`privacy_redacted_at` stamped. Each category must have its row in
`docs/USER-DATA-ANONYMIZATION.md` before it is enabled.

## 5. Wiring and configuration

- `config.userDataStore` (TypeBox-validated in `src/infra/config/env.ts`):
  `USER_DATA_STORE_ENABLED` (default `false`), `UD_RECEIPT_CLEANUP_CRON` (default daily),
  `UD_RECONCILE_MINUTES` (default 60). Rate limiting reuses the existing Redis config.
- Gated block in `build-app.ts` mirroring the notification-platform gate: enabled ⇒
  requires userDb + Redis; partial config fails boot fast. Disabled ⇒ no routes, no
  jobs, no registry boot (module fully dark).
- Boot order inside the gate: `makeCategoryRegistry` (fail-fast hash verification) →
  repos → usecases → routes → jobs.
- Barrel exports: `makeUserDataOwnerRoutes`, `makeUserDataAdminRoutes`,
  `makeUserDataStoreEraser`, `makeCategoryRegistry`, `ALL_USER_DATA_CATEGORIES`, ports,
  error types. No deep imports from other modules.

## 6. Acceptance traceability matrix

Every spec §20 scenario maps to a named test before implementation. Three gates
(review finding #7): **module-release** rows are this plan's definition of done;
**cutover** rows belong to the future migration plan; **operational** rows belong to
the ops/release checklist. Tiers: `unit` (pure), `contract` (fake + real PG via
`describePortContract`), `contract-real` (real PG only — **never ship on fake-green
alone**), `integration` (`createApp` + inject), `e2e`.

| #   | §20 scenario                                                       | Gate           | Test (file — case)                                                                                                                                                                                                                                                                                         | Tier                 |
| :-- | :----------------------------------------------------------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------- |
| 1   | create at expected revision zero                                   | module-release | `tests/unit/user-data/plan-create-or-replace.test.ts` — “creates at expected revision zero with generated record and event ids”                                                                                                                                                                            | unit                 |
| 2   | concurrent creation of the same logical key                        | module-release | `tests/e2e/user-data/cas-race.e2e.test.ts` — “row 2: two creates of one identity return the winner in the conflict”                                                                                                                                                                                        | contract-real        |
| 3   | concurrent replacement, exactly one expected revision succeeds     | module-release | `tests/e2e/user-data/cas-race.e2e.test.ts` — “rows 2/3: same-revision replacements serialize and exactly one wins”                                                                                                                                                                                         | contract-real        |
| 4   | accepted identical payload as a new command                        | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 4: identical payload as a new command creates a new revision and event”                                                                                                                                                                       | contract             |
| 5   | exact retry of the same idempotency key                            | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 5: exact replay returns the original result byte-identical”                                                                                                                                                                                   | contract             |
| 6   | idempotency key reuse with different content                       | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 6: idempotency key reuse with different content conflicts”                                                                                                                                                                                    | contract             |
| 7   | cross-owner reuse of one requester key (privileged)                | module-release | `tests/e2e/user-data/receipt-race.e2e.test.ts` — “row 7: same claim under different owner locks replays the winner” / “different claim … conflicts”                                                                                                                                                        | contract-real        |
| 8   | receipt expiry and stale CAS protection                            | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 8: an expired receipt does not replay and stale CAS conflicts”                                                                                                                                                                                | contract             |
| 9   | schema compatibility window and upgrade-required response          | module-release | `tests/unit/user-data/plan-create-or-replace.test.ts` — “rejects a write-disabled schema version”; `tests/integration/user-data/flows.test.ts` — “maps a registered write-disabled schema to UPGRADE_REQUIRED”                                                                                             | unit + integration   |
| 10  | explicit schema migration and failed migration rollback            | module-release | `tests/unit/user-data/usecases/mutation-usecases.test.ts` — “migrates without consuming the client limiter and requires system actor”; `tests/contracts/user-data/mutation-port.contract.ts` — “row 10: a failing commit leaves no event, snapshot, or receipt”                                            | unit + contract      |
| 11  | delete, tombstone sync, restore, forbidden key reuse               | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 11: delete tombstones and restore keeps recordId without annotations”; `tests/contracts/user-data/read-port.contract.ts` — “syncSince orders snapshots, includes tombstones, and reports ownerHighWater”                                      | contract             |
| 12  | current-state pagination while records change between pages        | module-release | `tests/e2e/user-data/sync-race.e2e.test.ts` — “row 12: a record changed twice between pages is returned once in its latest state”                                                                                                                                                                          | contract-real        |
| 13  | exact reconstruction at each verified revision                     | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “rows 13/14: each event is its revision after-image and latest equals current”                                                                                                                                                                     | contract             |
| 14  | latest event and current-state parity                              | module-release | `tests/contracts/user-data/reconciliation-port.contract.ts` — “row 14: clean store has no violations and a corrupt revision reports exactly one revision mismatch”; `tests/contracts/user-data/mutation-port.contract.ts` — “rows 13/14: each event is its revision after-image and latest equals current” | unit + contract-real |
| 15  | owner isolation and category-specific admin access                 | module-release | `tests/integration/user-data/flows.test.ts` — “covers owner CRUD, replay-before-limit, conflict, tombstone sync, restore, history and isolation” / “enforces category-specific admin isolation before authorizer probing”                                                                                  | integration          |
| 16  | cross-campaign admin isolation; no-permission category has no path | module-release | `tests/integration/user-data/flows.test.ts` — “enforces category-specific admin isolation before authorizer probing”                                                                                                                                                                                       | integration          |
| 17  | ordinary application attempts to update or delete events           | module-release | `tests/e2e/user-data/append-only.e2e.test.ts` — three “row 17” UPDATE/immutable-column/DELETE cases                                                                                                                                                                                                        | contract-real        |
| 18  | payload byte, depth, string, and collection limits                 | module-release | `tests/unit/user-data/planners/shared.test.ts` — “enforces payload byte cap / annotation namespace byte cap / string length / collection size / depth”                                                                                                                                                     | unit                 |
| 19  | category PII redaction including annotation namespace redactors    | module-release | `tests/unit/user-data/usecases/read-usecases.test.ts` — “anonymizeUserData builds payload and namespace redactors for every category”; `tests/contracts/user-data/erasure-port.contract.ts` — “redacts current rows and events, deletes receipts, and is idempotent”                                       | unit + contract-real |
| 20  | annotation write by allowed actor; forbidden actor rejected        | module-release | `tests/unit/user-data/plan-annotate.test.ts` — “accepts an allowed … actor and preserves payload verbatim” / “rejects a forbidden actor”                                                                                                                                                                   | unit                 |
| 21  | owner replacement preserves existing annotations untouched         | module-release | `tests/unit/user-data/plan-create-or-replace.test.ts` — “replaces at revision N and preserves annotations verbatim”                                                                                                                                                                                        | unit                 |
| 22  | annotation writes increment revision and appear in sync            | module-release | `tests/contracts/user-data/mutation-port.contract.ts` — “row 22: annotation increments revision and appears in sync”                                                                                                                                                                                       | contract             |
| 23  | admin annotation events carry identity and reason                  | module-release | `tests/unit/user-data/plan-annotate.test.ts` — “accepts an allowed admin actor and preserves payload verbatim” (asserts the complete actor) / “requires admin identity and reason at the ActorContext validation boundary”                                                                                 | unit                 |
| 24  | per-owner record quota and rate-limit enforcement, typed errors    | module-release | `tests/e2e/user-data/quota-race.e2e.test.ts` — “row 24: quota is authoritative under concurrent creates”; `tests/unit/user-data/usecases/mutation-usecases.test.ts` — “row 24 maps limiter denial to RateLimited”                                                                                          | contract-real + unit |
| 25  | concurrent same-owner writes never skip a sync row                 | module-release | `tests/e2e/user-data/sync-race.e2e.test.ts` — “row 25: an in-flight owner sequence cannot advance that owner sync cursor”                                                                                                                                                                                  | contract-real        |
| 26  | replay of an accepted mutation is not rate-limited                 | module-release | `tests/unit/user-data/usecases/mutation-usecases.test.ts` — “row 26 skips the limiter on exact replay”                                                                                                                                                                                                     | unit                 |
| 27  | idempotent Clerk deletion across records, events, receipts         | module-release | `tests/contracts/user-data/erasure-port.contract.ts` — “redacts current rows and events, deletes receipts, and is idempotent”; `tests/e2e/user-data-anonymizer.test.ts` — “anonymizes user-owned PII and remains idempotent” / “fails … when the User Data Store eraser fails”                             | contract-real + e2e  |
| 28  | legacy import with missing/malformed/duplicate/mismatched events   | cutover        | owned by the migration plan                                                                                                                                                                                                                                                                                | —                    |
| 29  | client conflict retention and obsolete local-storage removal       | cutover        | owned by the client migration plan                                                                                                                                                                                                                                                                         | —                    |
| 30  | old-client upgrade-required rejection                              | cutover        | owned by the migration plan                                                                                                                                                                                                                                                                                | —                    |
| 31  | sustained representative writes and indexed reads (§11.4)          | operational    | pre-cutover load test, ops checklist                                                                                                                                                                                                                                                                       | —                    |
| 32  | PITR restore inside RPO/RTO                                        | operational    | ops restore drill                                                                                                                                                                                                                                                                                          | —                    |

Row 26 is an addition over §20 (from review finding #6); rows 2, 3, 7, 12, 17, 24, 25,
27 are the real-PG-required set.

## 7. Test design

- **Pure unit** (`tests/unit/user-data/`): planners table-driven per operation × edge;
  cursor codec round-trip, malformed input, filter mismatch; registry boot validation
  (hash drift fails); key/target validators.
- **Contract suites** (`tests/contracts/user-data/*.contract.ts` via
  `describePortContract`): mutation port (the §4.1 semantics), read port (sync/history/
  reconstruction), erasure port. Fake backend from `tests/fixtures/user-data/fakes.ts`;
  real backend wraps the Kysely repos over `setupTestDatabase()` (Docker-gated). The
  real run is the authority on locking semantics.
- **Race tests** (review finding #12): deterministic transaction-phase barriers using
  two raw connections with explicit `BEGIN` / step / `COMMIT`, not bare `Promise.all` —
  plus fault injection after sequence allocation, snapshot write, event insert, and
  receipt insert proving complete rollback and harmless sequence gaps.
- **Integration** (`tests/integration/user-data/`): flows through `createApp({ deps })`
  - inject with fakes — owner CRUD/sync/history, cross-campaign admin isolation,
    annotation actor gating, error mapping, replay-while-rate-limited, feature gate off ⇒
    404 + nothing initialized.
- **Fakes**: composed from `tests/support/` (KeyedStore, FaultPlan, TestClock,
  SequentialIds). The fake mutation port must emulate the pinned commit order —
  receipt-before-CAS, per-owner serialization, quota-under-lock — so unit tests cannot
  pass on semantics the real adapter would reject.
- **Back-propagation rule**: any contract-case correction discovered on real PG in
  chunks 3a/3b is applied to the fake and the chunk-1/2 suites re-run green before that
  chunk commits.

## 8. Implementation chunks

Executor: codex (`gpt-5.6-sol`, high reasoning) per chunk with a written task file;
every chunk is fully reviewed by a human, passes `pnpm typecheck && pnpm lint && pnpm
test && pnpm build` (plus `pnpm test:e2e` where marked), and lands as one conventional
commit. No git operations by codex.

| Chunk | Scope                                                                                                                                      | Matrix rows                              |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| 1     | canonical-json promotion · core types/schemas/errors/ports · registry framework + 2 categories · planners · cursor codec · pure unit tests | 1, 9, 18, 20, 21, 23                     |
| 2     | usecases · fakes · unit tests · contract case files green on fake backend                                                                  | 4–6, 8, 10, 11, 13, 14, 22, 24(unit), 26 |
| 3a    | DDL + trigger + Kysely types · mutation repo (§4.1) · real-PG contract runner · phase-barrier race tests                                   | 2, 3, 7, 17, 24                          |
| 3b    | read/admin/erasure repos · real-PG contracts · sync-race e2e                                                                               | 12, 19, 25, 27                           |
| 4     | REST + error mapping + config + gated wiring + rate limiter + integration flows                                                            | 15, 16, and integration halves of 9, 26  |
| 5     | jobs · clerk-webhooks eraser integration · USER-DATA-ANONYMIZATION.md rows · final matrix audit                                            | 27(integration), 14(job), audit          |

## 9. Out of scope

Legacy import and maintenance-window cutover, client sync replacement, the three
displaced-data prerequisite documents (campaign entity config store, worker cursor
table, review-workflow annotation namespace + feature admin API), learning-progress
module retirement, owner-side registered-field queries, GraphQL, partitioning and
archive.

## 10. Design decisions made in this document

Decisions the spec left open, plus the external-review incorporation record:

1. **Event after-image as two columns** (`payload`, `annotations`) rather than the
   spec §7.2 single "canonical resulting record state" field — mirrors the record
   columns, keeps redaction paths identical on both tables, and lets reconciliation
   compare column-to-column. Recorded as a refinement, not a contradiction.
2. **No migration update path in the trigger** — spec §13.2 allowed updates recording
   "a privacy-redaction or migration marker"; schema migration appends `migrate`
   events and never updates old ones, so the trigger admits only the privacy-redaction
   column set. Stricter than the spec's wording, in its spirit.
3. **Receipt concurrency via unique-constraint wait** — the 23505 path in §4.1 rather
   than a second advisory lock: fewer lock-ordering rules, and PostgreSQL's own
   uniqueness wait provides the serialization (review finding #3 satisfied).
4. **Rate limiter fails open** (logged) when Redis is unavailable — mutation
   availability wins; quotas remain DB-enforced. Fail-closed would let a cache outage
   take down all user writes.
5. **Admin double gate** — routes check `CampaignAdminPermissionAuthorizer` against the
   category's declared permission AND the usecase re-checks the declaration, so a
   miswired route cannot open a category that declared no admin access.
6. **`AdminAccessNotConfigured` renders as 404**, indistinguishable from an unknown
   category — no probing surface for which categories exist or have admin paths.
7. **Sync page + owner high-water in one SQL statement** — READ COMMITTED gives each
   statement its own snapshot, so splitting them would reintroduce the cursor race
   (review finding #1).
8. **External review record (2026-07-11)**: findings #1–#3 (blockers: sync high-water
   source, snapshot-before-event FK ordering, cross-owner receipt race) fixed in the
   spec (§7.2/§9.1/§10.2) and pinned here; #4 single after-image; #5 complete
   `MutationOutcome` incl. `quotaExceeded`; #6 `probeReceipt` before the rate limiter
   (matrix row 26); #7 three-gate matrix; #8 erasure lock/transaction/GUC contract;
   #9 OLD/NEW column-set trigger; #10 owner/category scope mandatory in every port
   signature, owner-side field queries deferred; #12 phase-barrier race tests;
   #13 advisory-lock namespace constant; #14 decimal-string sequences + no MAC claim.
   **#11 partially accepted**: fake-first chunk order kept (unit tests need fakes
   early; proven workflow) but chunk 3 split into 3a/3b and the back-propagation rule
   (§7) makes the real-PG contract authoritative over the fake.
