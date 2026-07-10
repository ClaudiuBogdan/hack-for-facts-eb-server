# User Data Store v2

**Status:** Reviewed — design decisions incorporated (2026-07-10 review round;
2026-07-11 external design-review fixes: commit ordering, receipt reservation,
sync high-water source)  
**Implementation status:** Not started  
**Last updated:** 2026-07-11  
**Audience:** Product, backend, frontend, security, and operations

## 1. Why this document exists

The application has a PostgreSQL table that behaves like a flexible user-data
store. It keeps a current JSON record and an audit array for each user-controlled
key. The model began as a generic learning-progress synchronization mechanism,
but it is now also used for campaign interactions, submissions, review-related
state, internal configuration, and worker state.

That reuse exposed assumptions that no longer hold. Audit arrays can grow without
bound, client clocks decide write ordering, schema versions are not persisted,
some mutations bypass the audit trail, and clients commonly download an entire
user snapshot to find a small subset of records.

This document records the decisions for a replacement before implementation
starts. It is intended to be read and challenged by humans. It explains:

- what is wrong with the current model;
- which existing ideas are worth preserving;
- the guarantees the replacement must provide;
- the recommended database and API architecture;
- alternatives and their tradeoffs;
- how the design evolves as volume grows;
- how production data and clients should be migrated;
- which requirements intentionally remain outside the generic store.

This is not an implementation report. Names and wire examples are concrete enough
to guide implementation, but code and migrations have not started.

## 2. Executive summary

The recommended design separates current state from historical events:

1. **user_data_records** stores one small, directly queryable current snapshot
   for each logical user record.
2. **user_data_events** stores one immutable event for each accepted mutation,
   including the complete validated resulting payload.
3. **user_data_idempotency_receipts** is a small auxiliary table that provides
   exact retry behavior for 30 days.

The first two are the primary data model. The receipts table exists only because
we explicitly require exact idempotent retries across later mutations.

Records carry two write scopes. The owner replaces the **payload** as a complete
document. Privileged actors — system and admin — write registered **annotation
namespaces** and can never touch the payload, so workflow state can attach to a
record without being clobbered by the owner's next full replacement. Every
accepted mutation, by any actor, appends one immutable event with actor
attribution and increments the record's single revision.

The design uses PostgreSQL and the existing application. It does not introduce a
document database, event broker, microservice, EAV index, runtime schema
administration system, or arbitrary JSON query engine.

The main flow is:

> Authenticated client → registered category and schema → validated CAS mutation
> → atomic current snapshot and event → current-state sync or record history

The client still determines the useful product payload shape, but only registered
category and schema versions are accepted. Registration happens in reviewed
server code using immutable TypeBox schemas.

Current reads come from **user_data_records**. Audit and reconstruction come from
**user_data_events**. Current-state synchronization returns changed snapshots and
tombstones, not raw audit events.

## 3. Current implementation and evidence

### 3.1 Original design assumptions

The original generic learning-progress design assumed:

- one record per user and client-controlled record key;
- client-owned semantics and client-side projection;
- client timestamps as the freshness authority;
- a small audit array stored beside the current record;
- a small enough user snapshot to download and filter client-side;
- server sequences as synchronization cursors;
- one table being sufficient for current state, audit, and feature queries.

These assumptions were reasonable for a narrow learning-progress sync model.
They are not a safe general-purpose contract for all future user-generated data.

### 3.2 Production shape at review time

The production review found:

- 8,654 current rows;
- 754 distinct users;
- 35,169 embedded audit events;
- 2,121 records with no audit events;
- 28 records whose audit value is an object rather than an array;
- one record with 12,076 embedded events;
- one audit document of approximately 1.1 MiB;
- approximately 29.56 MiB of TOAST storage in a table using approximately
  48.09 MiB in total;
- no persisted payload schema identifier or schema version;
- no table-level validation checks, foreign keys, triggers, RLS policies, or
  partitions;
- no HOT updates in the observed statistics because indexed values and the large
  JSON document are rewritten.

The table is still small in absolute terms. The problem is structural rather than
an immediate capacity incident.

### 3.3 Correctness problems

The current system cannot honestly guarantee a complete audit history:

- public synchronization retains selected submitted audit entries but drops
  evaluated entries;
- current state can change without an audit event;
- reset operations hard-delete records;
- campaign configuration and internal writes can deliberately send no audit;
- synchronization deltas are current snapshots, not historical events;
- tests have allowed identity inconsistencies between a containing record and an
  audit entry, even though the live sample did not contain such mismatches.

Concurrency is also unsafe as a generic contract:

- public writes have no expected revision;
- record freshness trusts the client-provided updated time;
- a future client clock can prevent valid later writes;
- equal timestamps can produce arrival-order or client-implementation-dependent
  outcomes;
- the two client synchronization providers do not implement identical merge and
  failure behavior.

### 3.4 Performance and maintainability problems

- Every mutation rewrites and re-sorts the complete embedded audit array.
- A hot logical record becomes one increasingly large and contended PostgreSQL
  row.
- Whole-user snapshot reads move unrelated records over the network.
- Feature-specific JSON indexes and queries accumulate in one generic table.
- Payload validation is scattered through feature code and sometimes happens
  only while reading.
- Current state, historical audit, synchronization, review workflow, internal
  configuration, and analytics are competing for one storage shape.

### 3.5 Existing ideas worth preserving

The redesign should preserve:

- Clerk-derived ownership rather than accepting an owner from the request body;
- deterministic client logical keys;
- server-generated monotonic synchronization cursors;
- transactions, row locks, and first-insert race handling;
- TypeBox validation;
- targeted indexes created for demonstrated access patterns;
- server-controlled public-data redaction;
- the existing admin expected-update conflict pattern;
- the verified Clerk user-deletion entry point and its idempotency tests;
- the internal namespace guard that prevents public clients from writing server
  records.

The redesign should not preserve:

- embedded audit arrays;
- client-clock last-write-wins;
- synthetic synchronization deltas presented as historical events;
- destructive product-level resets;
- scattered read-time payload validation;
- mixed client-owned and workflow-owned fields in one JSON payload.

## 4. Goals, scale, and boundaries

### 4.1 Design target

The selected three-year design envelope is:

- 100,000 users;
- 10 million current records;
- 250 million historical events;
- approximately 200 mutations per second at peak.

This is a design boundary, not a forecast. It provides substantial headroom over
current production without requiring distributed storage.

### 4.2 Supported data

The generic store is intended for durable, user-owned product state such as:

- feedback;
- votes and reactions;
- deliberate user interactions;
- learning or campaign progress;
- preferences and settings;
- user submissions;
- future registered categories with the same ownership and lifecycle model.

Ordinary PII can be permitted by a reviewed category schema. Examples include
free text and contact details when the feature genuinely requires them.
Category-specific redaction is mandatory whenever PII is allowed.

Votes and reactions stored here should be written through a thin feature API
that maps taps to deliberate replacements; fast cross-device toggles written
directly through generic CAS replacement will surface avoidable revision
conflicts (see the feature-API escape hatch in §9.2).

### 4.3 Data that does not belong here

The generic store must not become the persistence layer for:

- page views, impressions, clickstreams, or other high-volume telemetry;
- aggregate reaction or vote counts;
- notification delivery, reliable messages, webhooks, or an outbox;
- review assignments, evaluation workflows, moderation state, or worker cursors;
- campaign configuration or other server configuration;
- secrets, credentials, payment data, files, or binary documents;
- highly regulated or unusually sensitive personal data;
- full-text search, reporting, analytics, or arbitrary JSON exploration;
- organization-owned, shared, anonymous, or service-owned records in v1;
- cross-record domain transactions or foreign-resource integrity;
- feature-specific business rules and side effects.

Individual votes or reactions can be stored here. Their aggregate counts belong
in a read model or analytics system. A user submission can be stored here. Its
review workflow belongs in domain persistence.

## 5. Decision register

The table below records the decisions made during planning. These are the
defaults implementation should follow unless this document is revised.

| Topic                | Decision                                                           | Why                                                              | Accepted cost                                                  |
| :------------------- | :----------------------------------------------------------------- | :--------------------------------------------------------------- | :------------------------------------------------------------- |
| Scale                | 100k users, 10M current records, 250M events, 200 peak writes/s    | Large safety margin without distributed architecture             | PostgreSQL capacity and backup planning are still required     |
| Ownership            | Exactly one authenticated Clerk owner                              | Clear authorization and deletion semantics                       | No anonymous, shared, organization, or service ownership in v1 |
| Record identity      | Server UUID plus immutable client logical key                      | Stable references plus deterministic offline upserts             | Two identities must remain consistent                          |
| Target identity      | Optional typed target outside the payload                          | Efficient votes, reactions, and resource feedback                | A few standardized columns are added                           |
| Schemas              | Immutable, versioned TypeBox schemas in server code                | Reviewable and deterministic validation                          | Adding a category or version requires a deployment             |
| Old schema writes    | Explicit compatibility window                                      | Supports gradual client upgrades                                 | Old validators and redactors must remain maintained            |
| Schema migration     | Explicit audited server migration                                  | Reads stay side-effect free and failures are visible             | Migration jobs must be written and operated                    |
| Payload limit        | Global 64 KiB maximum                                              | Bounds API, validation, WAL, and event storage                   | Larger content needs dedicated storage                         |
| Mutation shape       | Full payload replacement                                           | Simple validation and exact event after-images                   | More bytes than patches                                        |
| Concurrency          | Expected revision compare-and-swap                                 | Prevents silent stale overwrites                                 | Clients must handle conflicts                                  |
| Idempotency          | Exact successful replay for 30 days                                | Safe network and offline retries                                 | Requires a small receipts table and cleanup                    |
| Audit scope          | Every distinct accepted mutation                                   | Complete post-cutover mutation ledger                            | Identical accepted replacements still produce events           |
| Event representation | Canonical resulting payload                                        | Simple reconstruction and repair                                 | Historical storage grows with payload size                     |
| Current state        | Separate latest-state table                                        | Fast reads without replay                                        | Current payload duplicates the latest event                    |
| Product deletion     | Permanent tombstone and explicit restore                           | Prevents stale resurrection and key ambiguity                    | Deleted identities remain in the current table                 |
| Key reuse            | Restore only                                                       | One logical history for one key                                  | A deleted key cannot create a new record identity              |
| Sync                 | Current snapshots and tombstones after an opaque cursor            | Efficient multi-device sync without exposing audit internals     | Sync and history are separate APIs                             |
| History access       | Owner plus authorized administrators                               | Product transparency and support access                          | Historical payload authorization must be maintained            |
| Generic queries      | Metadata plus registered indexed fields                            | Predictable performance                                          | New query shapes require server work and an index              |
| Authorization        | Owner-only by default                                              | Fail-closed data access                                          | Shared reads require future design                             |
| Server workflows     | Logic outside; workflow state may attach as registered annotations | Keeps field ownership clear without clobbering risks             | Two write scopes in schema, API, and redaction                 |
| Downstream delivery  | No generic guarantee                                               | Prevents the store becoming an event bus                         | Reliable side effects need a separate design                   |
| Data class           | Ordinary PII only, with reviewed redaction                         | Supports real feedback and submissions                           | Privacy handling is category-specific                          |
| User erasure         | Documented redaction exception                                     | Retains non-identifying ledger facts                             | Redacted payload history is no longer reconstructable          |
| Tamper evidence      | Database-enforced append-only                                      | Sufficient operational audit with low complexity                 | No cryptographic proof or external WORM claim                  |
| Recovery             | RPO at most 5 minutes, RTO at most 1 hour                          | User writes and audit data are important                         | Requires PITR and tested restore operations                    |
| Online history       | 36 months                                                          | Finite primary database growth                                   | Older payload history eventually depends on archive            |
| Total history        | Indefinite until user erasure                                      | Preserves reconstruction and audit value                         | Archive storage grows over time                                |
| Partitioning         | Do not partition initially                                         | Current volume does not justify it                               | A future online migration is required at the trigger           |
| Legacy history       | Import with unverified provenance plus a baseline                  | Preserves evidence without pretending it is complete             | Pre-cutover history has weaker guarantees                      |
| Cutover              | Short maintenance window                                           | Low traffic makes this simpler than dual-write                   | Rollback becomes roll-forward after writes reopen              |
| Old clients          | Reject old timestamp writes with upgrade-required error            | Protects the new concurrency invariant                           | Stale clients must refresh                                     |
| Legacy local queues  | Do not replay old payloads                                         | Avoids permanent migration code for effectively inactive traffic | Rare local-only pending writes can be abandoned                |
| Public API           | Generic CRUD/sync/history plus feature APIs                        | Reuse without forcing workflows into generic CRUD                | Two API layers must have a clear boundary                      |
| Non-owner writes     | Registered annotation namespaces only                              | Owner replacement cannot clobber workflow state                  | Two write scopes to enforce everywhere                         |
| Actor types          | owner, system, admin                                               | Filterable user data and accountable interventions               | Admin identity and reason capture required                     |
| Payload repair       | Maintenance migration path only                                    | Zero privileged full-replace API surface                         | Repairs are jobs, not endpoints                                |
| Per-owner quotas     | Registry-declared record quotas plus write rate limits             | Bounds single-account abuse                                      | Quotas must be sized per category                              |
| Write ordering       | Per-owner serialized commits via advisory lock                     | Race-free synchronization cursors                                | Slight per-owner write serialization                           |
| Displaced data       | Prerequisite design docs for config, cursors, review workflow      | Keeps the store user-owned                                       | Cutover blocked on those documents                             |
| Campaign boundary    | Encoded in the category, fail-closed admin permission per category | One authorization axis doubling as the statistics dimension      | New campaign requires a deployment; runtime tenants deferred   |

## 6. Required invariants

### 6.1 Identity and ownership

- The server derives owner ID from the authenticated Clerk session.
- A client can never select or change the owner.
- Each record has an immutable server-generated record ID.
- The tuple of owner, category, and logical key is unique and immutable.
- Logical keys have category-specific syntax and length validation.
- Logical keys must not contain uncontrolled personal information.
- Optional target type and target ID are immutable after creation.
- The generic database does not enforce that a target exists. The feature layer
  performs domain authorization and existence checks where required.

### 6.2 Versioning

- Record revision begins at one.
- Every distinct accepted mutation increases the revision by exactly one.
- Events for a record have unique, continuous revisions from the trusted
  migration baseline onward. Continuity checks run against the online event
  window; once events older than the 36-month window move to a future archive
  (§12.3), continuity across that boundary is verified against the archive.
- Category plus schema version identifies the payload contract.
- The stored schema hash detects accidental changes to an existing version.
- Client occurrence time never participates in concurrency or ordering.

### 6.3 Atomicity

For every successful mutation:

- one event exists;
- the current row contains the event's resulting state;
- the current revision equals the event revision;
- the current last-event sequence equals the event sequence;
- an idempotency receipt exists during its 30-day guarantee window.

The event, current state, and receipt commit in one transaction. A failure at any
point rolls back all three.

### 6.4 Audit

- Normal application code can insert and read events but cannot update or delete
  them.
- An idempotent retry returns the original accepted result and does not append a
  second event.
- A new accepted command with an identical payload still creates a new revision
  and event.
- Rejected validation, authorization, and revision-conflict attempts are
  operational or security logs, not accepted mutation events.
- Legacy imported events are visibly marked as unverified.
- Complete, trustworthy reconstruction starts at the migration baseline.
- User erasure is the only ordinary exception to payload immutability.

### 6.5 Lifecycle

- An active record has a validated payload.
- Product deletion increments the revision, appends a delete event, clears the
  current payload, and retains a tombstone.
- Restore requires the tombstone revision, a complete validated payload, and a
  new idempotency key.
- Restore is the next revision of the same record.
- The logical key is never reassigned to a new record.
- Clerk account deletion is different from product deletion and follows the
  privacy treatment described later.

### 6.6 Actors and annotations

- Every event records an actor type: owner, system, or admin.
- Admin events additionally record the acting administrator's identity and a
  required reason.
- The payload is writable only by the owner and by explicit system migrations.
- Annotation namespaces are writable only by the actor types registered for
  them, and never by the owner.
- A payload write never modifies annotations; an annotation write never
  modifies the payload.
- Every accepted write of either scope increments the same record revision.
- Filtering events by the owner actor type yields exactly the user-originated
  data.

## 7. Proposed data model

### 7.1 user_data_records

This table is the fast current-state projection.

Recommended fields:

| Field                              | Purpose                                                                  |
| :--------------------------------- | :----------------------------------------------------------------------- |
| record_id                          | Immutable server UUID and primary key                                    |
| owner_id                           | Authenticated Clerk owner or deletion pseudonym                          |
| category                           | Immutable registered category                                            |
| logical_key                        | Immutable category-defined key                                           |
| target_type, target_id             | Optional immutable product target                                        |
| schema_version, schema_hash        | Schema used by the current payload                                       |
| revision                           | Current optimistic-concurrency revision                                  |
| status                             | Active or deleted                                                        |
| payload                            | Current validated JSON object, null for a tombstone                      |
| annotations                        | Namespace-keyed object of registered annotation payloads, null when none |
| last_event_seq, last_event_id      | Mutation that produced current state                                     |
| created_at, updated_at, deleted_at | Server-controlled lifecycle timestamps                                   |
| privacy_redacted_at                | Account-erasure marker when applicable                                   |

Core constraints:

- primary key on record ID;
- unique owner, category, and logical key;
- revision greater than zero;
- active status requires a JSON object payload;
- deleted status requires null payload and annotations and a deletion time;
- annotations, when present, form an object whose keys are registered
  namespaces;
- encoded payload size no greater than 64 KiB, with per-category and
  per-namespace limits enforced by the registry;
- payload and annotation schemas must declare bounded depth, string, and
  collection sizes — the byte cap is the outer guard, not the only one;
- target type and target ID are either both present or both absent.

Core indexes:

- unique owner, category, logical key;
- owner and last event sequence for synchronization;
- owner, category, and record ID for category listing;
- partial owner, category, target type, target ID for targeted records.

### 7.2 user_data_events

This table is the append-only mutation ledger.

Recommended fields:

| Field                               | Purpose                                                                           |
| :---------------------------------- | :-------------------------------------------------------------------------------- |
| event_seq                           | Server sequence used for ordering and opaque cursors                              |
| event_id                            | Stable public UUID                                                                |
| record_id                           | Record whose state changed                                                        |
| owner_id                            | Denormalized owner for authorized history access                                  |
| category, logical_key               | Self-contained logical identity                                                   |
| target_type, target_id              | Self-contained target identity                                                    |
| revision                            | Record revision produced by this event                                            |
| operation                           | Create, replace, annotate, delete, restore, migrate, or legacy import             |
| scope, annotation_namespace         | Which write scope changed; the namespace for annotate events                      |
| schema_version, schema_hash         | Schema used for the after-image                                                   |
| payload                             | Canonical resulting record state (payload and annotations), null after deletion   |
| actor_type                          | Owner, system, or admin (legacy imports are system events with legacy provenance) |
| actor_id, actor_reason              | Privileged actor identity and required reason for admin events                    |
| provenance                          | Live or legacy                                                                    |
| integrity                           | Verified or unverified                                                            |
| recorded_at                         | Authoritative server timestamp                                                    |
| client_occurred_at                  | Optional informational client timestamp                                           |
| source_event_id, source_occurred_at | Optional legacy provenance                                                        |
| privacy_redacted_at                 | Privacy-erasure marker                                                            |

Core constraints and indexes:

- primary key on event sequence;
- unique event ID;
- unique record ID and revision;
- foreign key from event record ID to current record ID;
- record history index on record ID and revision;
- owner history index on owner ID and event sequence;
- optional owner, category, event sequence index when measured history queries
  justify it.

The event repeats logical identity fields intentionally. It remains understandable
and exportable without joining mutable current state.

Because the event references the current record, a mutation writes the current
snapshot before inserting its event (§9.1). The two rows still commit together;
only the statement order is constrained by the foreign key.

Every event stores the complete resulting record state — payload and
annotations — not just the scope it changed. This keeps the reconstruction
property in §10.3 exact: state at revision N is always the after-image of event
N, with no cross-scope replay.

### 7.3 user_data_idempotency_receipts

This is an auxiliary operational table, not a third source of user state.

Recommended fields:

- requester ID (the owner for owner writes; the acting system or admin
  principal for annotation writes);
- hash of the idempotency key;
- canonical request hash;
- accepted event ID and event sequence;
- creation and expiry timestamps.

The unique identity is requester plus idempotency-key hash. Scoping receipts to
the requester rather than the record owner keeps retry guarantees per actor:
an admin's annotation retry can never collide with, or replay, an owner's key.

The original response is reconstructed from the accepted event. The receipt does
not need to duplicate a 64 KiB payload. Receipts expire after 30 days.

If a key is retried with the same canonical request, return the original result.
If the same key is reused for different content, return an idempotency conflict.
After expiry, expected revision still prevents an old request from silently
overwriting a newer state, but exact response replay is no longer guaranteed.

## 8. Schema and category registry

### 8.1 Registration model

Schemas are immutable TypeBox definitions in server code. There is no database
schema editor or runtime client registration endpoint.

A category entry defines:

- category identifier;
- immutable schema versions and canonical hashes;
- whether each version is readable and write-enabled;
- optional deprecation and write-disable dates;
- global or category-specific byte limit;
- logical-key validation;
- target rules;
- category-specific redaction;
- explicit migration functions;
- named payload query fields and supported operators;
- required indexes;
- annotation namespaces, each with an immutable TypeBox schema, byte limit,
  allowed actor types, and a deletion redactor;
- a per-owner record quota for the category;
- an access policy: the admin permission required for privileged reads and
  annotation writes, or none, in which case no admin access path exists.

Categories are the campaign and tenant boundary. A campaign's categories are
named for it (for example `funky.interaction`, `funky.progress`), and several
categories may declare the same admin permission so one grant covers a whole
campaign. Standing up a new campaign means registering its categories, which is
a deployment — consistent with campaigns already shipping code (schemas, review
projections, admin surfaces).

Canonical schema hashes and canonical request hashes must use one shared
canonical-JSON serializer. The hardened, total implementation already shipped
inside the notification platform core should be promoted to a common utility
and reused; do not introduce a second canonicalization.

The client declares the category and schema version for a write. The server
resolves that exact registered version and validates the complete payload.

### 8.2 Compatibility

When a new schema version is introduced:

- the old version remains readable;
- writes remain enabled only for an explicit compatibility window;
- an outdated write receives a clear upgrade-required error after that window;
- schemas and redactors remain available for as long as stored events use them;
- the server never silently interprets an old payload as a newer version.

### 8.3 Migration

Schema migration is explicit:

1. Read a record at the expected revision.
2. Validate the stored payload against its recorded schema.
3. Transform it with a reviewed migration function.
4. Validate the result against the target schema.
5. Write a system-actor migrate event and current snapshot atomically.

Reads never mutate data. Migration jobs are idempotent and can safely resume.

## 9. Write architecture

### 9.1 Generic replace

A generic replace request contains:

- category and logical key;
- schema version;
- expected revision, where zero means create;
- idempotency key;
- complete payload;
- optional target on creation;
- optional informational client occurrence time.

The server:

1. derives the owner from Clerk authentication;
2. resolves the category and schema version;
3. validates key, target, payload shape, byte size, quota, and authorization;
4. acquires the per-owner write serialization lock (§10.2);
5. reserves or replays the idempotency receipt with a conflict-safe insert on
   requester and key hash — concurrent reuse of the same key, including by a
   privileged requester acting on a different owner outside this owner's lock,
   waits on the in-flight duplicate and resolves to a replay or an idempotency
   conflict, never a leaked constraint error;
6. locks the existing current row or uses conflict-safe creation;
7. compares the expected revision;
8. re-checks the per-owner category quota under the lock for creates — the
   step-3 check gives an early friendly error, but only the lock-serialized
   check is authoritative;
9. allocates the next revision and event sequence;
10. writes the current snapshot first and then inserts the canonical event —
    the event's foreign key requires the current row to exist — leaving
    annotations untouched on payload writes;
11. commits the event, snapshot, and receipt together.

### 9.2 Conflicts

A revision mismatch returns a typed revision-conflict response containing the
current revision and current owned record. The server does not automatically
merge JSON documents.

This is intentional. Generic automatic merge semantics cannot be correct for
settings, votes, free-text feedback, and progress at the same time.

Features can provide a product-specific resolution experience:

- reload and let the user retry;
- reapply a safe field-level edit in the client;
- discard a stale local update;
- use a feature API with domain-specific commutative behavior.

A conflict caused by a non-owner event — a system migration or an annotation —
is not a user-facing merge problem. The client reloads the record and reapplies
its change on the new revision (§17).

### 9.3 Delete and restore

Delete requires expected revision and idempotency key. It appends a delete event
and writes a current tombstone.

Restore requires the tombstone revision, a complete payload, schema version, and
new idempotency key. It appends a restore event and reactivates the same record.

Deletion clears annotations along with the payload; restore does not resurrect
them. Namespaces must be re-annotated by their owning workflows after restore.

### 9.4 Annotation writes

An annotation write contains the category, logical key, namespace, expected
revision, idempotency key, and the complete namespace payload. The actor
context — system identity, or admin identity plus a required reason — comes
from server authentication, never from the request body.

The pipeline is the same as §9.1: registry resolution, validation against the
namespace schema, allowed-actor check, per-owner serialization, compare-and-swap
on the record revision, one `annotate` event, and a snapshot update that touches
only that namespace.

Annotation writes are exposed through feature and admin APIs, not through the
public generic owner API, and the owner can never write annotations through any
API. There is no privileged full-payload replace: a corrupt payload is repaired
through the audited migration-style maintenance path (§8.3), keeping zero
privileged write surface on public endpoints.

## 10. Read and synchronization architecture

### 10.1 Supported generic reads

The generic owner API supports:

- point read by category and logical key;
- point read by record ID;
- paginated category listing;
- lookup by standardized target metadata;
- current-state changes after an opaque cursor;
- paginated history for one owned record.

Default page size is 100. Maximum page size is 500.

Administrative access is fail-closed and category-scoped. A category must
declare a required admin permission to have any admin read path at all, every
admin query is bound to exactly one category (there is no cross-category admin
query surface), and access is exposed through a server or feature-admin use
case. An administrator scoped to one campaign's permission therefore cannot
construct a request that returns another campaign's records — the boundary is a
first-class indexed column, never payload content.

### 10.2 Current-state synchronization

Synchronization reads **user_data_records**, ordered by last event sequence.
Responses contain current snapshots and tombstones, not the raw event ledger.

The opaque cursor includes:

- the last consumed event sequence;
- a high-water mark captured for the current pagination cycle, computed as the
  maximum last event sequence over the requesting owner's committed rows in
  the same read snapshot as the page — never from the global sequence;
- any category filter needed to validate cursor reuse.

This provides these properties:

- a new client can obtain current state without replaying history;
- concurrent changes are returned in the current or next cycle;
- a record changed several times between polls is returned once with its latest
  state;
- deletion reaches offline clients through tombstones;
- history API compatibility is not forced onto the synchronization client.

Snapshots returned by synchronization include annotations. They are read-only
for the client: informative for rendering, never writable through the owner
API.

Sequence values are allocated at insert time, but transactions can commit out
of order. Without protection, a client could observe sequence 101, advance its
cursor, and permanently miss a row whose sequence-100 transaction committed
later. Because synchronization only requires per-owner ordering, every mutation
takes a per-owner advisory transaction lock before allocating its sequence,
making each owner's sequences commit-ordered. The high-water mark must likewise
come from the owner's own committed rows: deriving it from the global sequence
would let another owner's later commit advance this owner's cursor past a write
that is still in flight. With both rules, the cursor is race-free without
overlap windows or client-side deduplication, and at the design-envelope write
rate this serialization is negligible.

### 10.3 Historical reads and reconstruction

Record history reads events by record ID and revision.

Because every verified event contains the complete after-image:

- state at revision N is the after-image of event N;
- latest state can be checked directly against the latest event;
- current state can be rebuilt by selecting the latest event for each record;
- no chain of JSON patches must be replayed;
- a corrupted intermediate event does not make all later full after-images
  unreadable.

History responses include the schema version and integrity/provenance markers.
Legacy events must be visibly distinguishable from verified post-cutover events.

### 10.4 Registered payload queries

The generic store does not accept arbitrary JSON paths from callers.

Registered query fields may target payload paths or annotation paths; both
follow the same declaration and indexing rules.

Each approved query field has:

- a public filter name;
- an exact JSON path;
- a scalar type;
- allowed operators;
- allowed sort behavior;
- a matching partial or expression index.

Unknown fields, operators, and sorts are rejected. There is no default universal
JSONB GIN index.

Feature-specific aggregates, cross-user reporting, and workflow queries use
feature APIs and purpose-built read models.

## 11. Performance characteristics

### 11.1 Reads

- Point reads use the unique owner, category, logical-key index.
- Category lists use an owner/category index and keyset pagination.
- Synchronization uses owner and last event sequence.
- Record history uses record ID and revision.
- Target reads use the partial target index.
- Registered JSON queries use their declared partial indexes.

No normal owner read should scan the complete table or download every category.

### 11.2 Writes

Each accepted mutation performs:

- one append-only event insert;
- one current-row insert or update;
- one small idempotency-receipt insert;
- index maintenance for the current identity and approved query fields.

The historical document is never loaded, sorted, or rewritten.

The main accepted write cost is that the validated payload is written once to the
event and once to current state. This is deliberate: it trades storage for simple
reconstruction and fast current reads.

### 11.3 Payload size matters more than row count alone

At an average 4 KiB event payload, 250 million events contain roughly 1 TiB of
payload before indexes, WAL, and backups. If every event used the 64 KiB ceiling,
payload alone would exceed 15 TiB.

The 64 KiB limit is therefore a safety ceiling, not a normal sizing target.
Categories should use smaller limits whenever practical.

### 11.4 Performance acceptance

Before production cutover, a production-like load test should demonstrate:

- 200 representative mutations per second without correctness errors;
- database transaction p95 below 100 ms at representative payload sizes;
- point reads and 100-row sync pages using indexes;
- bounded behavior at the 64 KiB limit;
- acceptable WAL and backup growth;
- no event/current divergence under injected failures.

These are initial engineering acceptance targets, not a permanent public API
latency contract. They should be revised from measured production hardware.

## 12. Scaling, partitioning, and retention

### 12.1 Initial state

Do not partition the new tables at launch. Current production volume does not
justify the operational complexity.

Keep **user_data_records** unpartitioned for the selected 10-million-record
envelope. Reconsider owner-based partitioning only if measured index, vacuum, or
write contention exceeds the target.

### 12.2 Event partition trigger

Plan an online event-table partitioning project when the first of these occurs:

- 50 million event rows;
- 100 GiB total event relation size including indexes;
- backup, restore, vacuum, or history-query objectives begin degrading;
- the first 36-month archival cycle is approaching.

The documented target is monthly range partitioning by server recorded time.
Opaque cursors and repository boundaries ensure this physical migration does not
change the public API.

Partitioning is an evolution step, not part of the first implementation.

### 12.3 Retention

- Keep event payloads directly queryable in PostgreSQL for 36 months.
- Retain payload-complete history indefinitely until user erasure.
- Do not implement archive infrastructure now.
- Do not delete online events until a future archive has been written and
  verified.
- The future archive must preserve reconstruction and support user erasure.

The exact archive format is deliberately deferred. Current volume does not
justify choosing or operating it yet.

### 12.4 Operational signals

Monitor:

- event count and total relation size;
- current and event average payload bytes;
- table and index bloat;
- WAL generated per day;
- autovacuum lag and dead tuples;
- point-read, sync, mutation, and history latency;
- backup duration and archive health;
- restore duration;
- idempotency receipt cleanup;
- per-owner quota utilization and rate-limit rejections;
- event/current reconciliation mismatches.

## 13. Security and privacy

### 13.1 Authorization

- Public access is owner-only.
- Categories are the tenant boundary: admin reads, statistics, and annotation
  writes are all gated by the category's declared admin permission,
  fail-closed. Annotation writes are double-gated — the category permission
  plus the namespace's allowed actor types.
- Owner ID always comes from Clerk authentication.
- A category must explicitly enable privileged read access.
- Generic public APIs never expose cross-user queries.
- Review and moderation access belongs to feature APIs, which may write
  registered annotation namespaces through the annotation path (§9.4).
- Admin annotation writes always record the administrator's identity and a
  required reason on the event.
- Per-owner record quotas and mutation rate limits bound what a single
  authenticated account can create; breaches return a typed quota error.
- Payloads, annotations, and validation failures must not be logged.

PostgreSQL RLS is not required for v1 because clients do not connect to the
database and all repository methods are owner-scoped. If direct multi-tenant
database access is introduced later, RLS must be reconsidered.

### 13.2 Append-only enforcement

The normal application database role can:

- select and insert events;
- select, insert, and update current records;
- manage unexpired idempotency receipts.

It cannot update or delete events.

Schema migrations, retention, and Clerk erasure use separately restricted
maintenance paths. The destructive anonymizer remains reachable only through the
verified Clerk user-deleted handler.

Because the application currently connects with a single database role in every
environment, role-based grant separation is not immediately available. The
first implementation therefore enforces append-only semantics with a trigger on
the events table, shipped in the same migration: DELETE is rejected
unconditionally, and UPDATE is permitted only when the transaction has set a
local maintenance flag (a session-local GUC) that only the erasure and
migration paths set, and only for statements that record a privacy-redaction or
migration marker. Role-based grants can harden this later without changing
behavior.

This is database-enforced operational auditability. The design does not claim
cryptographic tamper evidence or an external WORM copy.

### 13.3 Clerk user deletion

User erasure must cover current records, events, receipts, and any future
archive.

The handler:

- replaces the Clerk owner ID with the existing deterministic deletion
  pseudonym;
- applies the registered category redactor to current and event payloads;
- applies each registered namespace redactor to current and event annotations;
- nulls or replaces PII-bearing metadata;
- deletes idempotency receipts;
- records privacy-redaction timestamps;
- preserves event IDs, revisions, operations, schema identifiers, server
  timestamps, and approved non-identifying target metadata;
- writes the non-PII anonymization summary through the existing audit mechanism.

This is the documented exception to physical event immutability. After erasure,
redacted payload history cannot be reconstructed. Privacy takes precedence over
payload-complete audit.

Each category must be added to the field-treatment inventory in
**docs/USER-DATA-ANONYMIZATION.md** before it is enabled.

## 14. Failure recovery and consistency checks

The selected recovery objective is:

- RPO no greater than five minutes;
- RTO no greater than one hour.

Production therefore requires:

- continuous WAL archiving;
- point-in-time recovery;
- monitored backup success;
- at least quarterly restore drills;
- measured restore duration against the one-hour target.

The repository currently does not demonstrate that complete production backup
configuration, so it is a release prerequisite rather than an assumed guarantee.

Database restore is the primary disaster-recovery mechanism. Event
reconstruction is used for logical verification, repair, and investigation.

A reconciliation job or operational query should verify:

- one current row per logical identity;
- unique and continuous trusted revisions per record;
- current revision equals latest event revision;
- current payload, annotations, status, and schema equal the latest event
  after-image;
- current last-event sequence exists;
- no expired receipts remain beyond the cleanup allowance.

Reconciliation reports problems; it must not silently rewrite the ledger.

## 15. API shape

The public API has a generic core plus feature APIs.

### 15.1 Generic core

The generic core provides:

- create or replace by category and logical key;
- delete;
- restore;
- point read;
- category list;
- current-state synchronization;
- owned record history.

The public wire contract includes:

- record ID;
- category and logical key;
- target metadata;
- schema version;
- revision;
- status;
- payload;
- server timestamps;
- opaque sync or page cursor where relevant.

The API is REST, following the codebase's existing route conventions; no
GraphQL surface is planned for the generic store. Every accepted mutation
responds with the resulting record state — new revision, event ID, and server
timestamps — so a client never needs a follow-up read to continue its
compare-and-swap sequence.

Typed errors include:

- invalid category or schema;
- schema version no longer write-enabled;
- invalid payload;
- payload too large;
- invalid key or target;
- revision conflict;
- idempotency-key conflict;
- unauthorized category, namespace, or operation;
- per-owner quota exceeded;
- old client upgrade required.

Paths follow the platform's unversioned convention (for example
`/api/user-data/...`), evolving additively — consistent with the notification
platform's API-versioning decision.

### 15.2 Feature APIs

Feature APIs remain responsible for:

- domain authorization;
- validating that target resources exist;
- moderation and review, persisted as registered annotation namespaces;
- aggregates and statistics, computed as category-scoped queries over the
  store's first-class columns (category, target, status, timestamps) and
  registered fields, under the same category admin permission;
- cross-user administration;
- side effects;
- domain-specific conflict resolution;
- reliable notifications or external delivery.

They can use the generic store internally for user-owned state without exposing
storage-specific details to every product screen.

### 15.3 Downstream integration with the notification platform

The store guarantees no downstream delivery (§4.3). When a mutation must
reliably trigger user-facing notifications, the sanctioned path is the
notification platform's reconciliation-first ingestion: a feature module
implements an `EventSourcePort` that reads **user_data_events** past a
watermark. The append-only ledger and its global event sequence make it a
natural, replay-safe source — delivery guarantees, deduplication, and retries
live in the notification platform, and the store never becomes an event bus.

## 16. Production migration

### 16.1 Chosen migration style

Use a short maintenance window.

Current traffic and campaign activity are low enough that a direct, verified
cutover is simpler than months of dual-write and legacy compatibility code.

### 16.2 Preflight

Before scheduling the maintenance window:

1. Create an explicit inventory mapping every existing record family to a new
   registered category or to an excluded domain store.
2. Register schemas for every user-owned category being migrated.
3. Validate every current production payload.
4. Produce a quarantine report for invalid or unmapped rows.
5. Dry-run the migration against a recent production backup.
6. Measure duration and verify rollback before reopening writes.
7. Confirm recent user-interaction write traffic remains negligible.

Do not infer category mappings heuristically at runtime. The v1 launch
categories are expected to be the campaign-interaction and learning-progress
families; the preflight inventory is the authoritative list.

Internal configuration, worker cursors, campaign configuration, and workflow
state are not migrated into the new generic store. Each current occupant of the
legacy table needs its own prerequisite design document before the maintenance
window can be scheduled:

- campaign entity configuration (today read through the legacy repository by
  the campaign-entity-config module) — a dedicated configuration store;
- worker cursors (today `internal:` records consumed by the weekly-digest
  reconciler) — a small dedicated cursor table;
- the interaction review workflow (today written into the user's record JSON,
  with partial indexes on review status) — expected to become a registered
  annotation namespace plus a feature admin API, decided in its own document.

These documents are cutover blockers. The legacy table cannot be removed while
any occupant still lives in it.

### 16.3 Historical import

For each legacy record:

- import structurally valid embedded entries as legacy, unverified events;
- preserve source event IDs and occurrence times as provenance;
- reject or quarantine duplicate IDs and identity mismatches;
- add one validated legacy-import baseline whose after-image exactly equals the
  migrated current state;
- begin verified revision continuity at that baseline.

Records with no usable events still receive a baseline. Malformed legacy audit
objects are preserved for migration reporting but are not invented into normal
events.

The history API must state that legacy events are unverified and that complete
reconstruction is guaranteed only from the baseline onward.

### 16.4 Cutover sequence

1. Put old writes into maintenance mode.
2. Run the reviewed database migration.
3. Validate counts, unique identities, category mappings, payload checksums,
   revisions, current/event parity, and representative histories.
4. Deploy the new server.
5. Deploy the updated client.
6. Run create, replace, conflict, idempotency, delete, restore, sync, history,
   and Clerk-deletion smoke tests.
7. Reopen writes only after all checks pass.

Before writes reopen, application and database rollback remain possible. Once
new writes are accepted, recovery is roll-forward because there is no dual-write
path.

Keep the old table read-only for a short verification period with its existing
user-deletion coverage, then remove it after the new store and backups are
confirmed.

### 16.5 Old clients and local state

After cutover:

- old timestamp-based write routes return an upgrade-required error;
- the server does not translate or accept old payloads;
- the refreshed client uses the new revision-based API;
- the client does not replay legacy pending queues;
- after the first successful new synchronization, obsolete local-storage keys
  are removed.

This accepts the small risk of abandoning rare local-only pending changes. The
tradeoff is intentional because live interaction traffic is effectively inactive
and avoiding a permanent legacy adapter improves the correctness and
maintainability of the new system.

## 17. Client architecture implications

The client currently has two synchronization implementations with separate
cursors, local queues, polling intervals, merge rules, and failure handling.

Replace them with one user-data client that:

- uses one opaque current-state cursor;
- stores one pending command format;
- generates an idempotency key for every new mutation;
- tracks the expected server revision;
- sends complete replacement payloads;
- never uses client time to resolve conflicts;
- retains new revision conflicts for visible retry or feature resolution;
- reloads and reapplies automatically when a conflict was caused by a
  non-owner event such as a migration or annotation;
- treats annotations as read-only server state;
- never silently discards server validation failures;
- treats history as a separate paginated API;
- avoids logging payloads or raw corrupt storage.

Polling remains an implementation choice of the client. The storage API does not
promise real-time push.

## 18. Advantages and tradeoffs

### 18.1 Two primary tables

**Advantages**

- Current reads never replay history.
- Event inserts remain append-only.
- Hot records do not grow with their event count.
- Current state can be verified or rebuilt.
- Retention policy can treat snapshots and events differently.

**Tradeoffs**

- The latest payload is stored twice.
- Transaction correctness becomes essential.
- A reconciliation check is needed because a cross-table equality invariant
  cannot be expressed as a simple check constraint.

### 18.2 Full after-images instead of diffs

**Advantages**

- Any revision is independently readable.
- Reconstruction is simple.
- Schema migrations are explicit events.
- Corruption in one old event does not break later after-images.

**Tradeoffs**

- More storage and WAL.
- Large payloads become expensive quickly.
- The 64 KiB cap and category-specific smaller limits are mandatory.

### 18.3 Code registry instead of a database registry

**Advantages**

- Schemas, migrations, redactors, and query policies are reviewed together.
- No runtime administration UI, cache invalidation, or mutable schema authority.
- TypeBox remains the existing source of validation behavior.

**Tradeoffs**

- A deployment is required for every category or version.
- Old schema code must remain available for retained history.
- Product teams cannot create arbitrary storage shapes at runtime.

### 18.4 CAS instead of last-write-wins

**Advantages**

- Stale devices cannot silently overwrite current state.
- Server clocks and revisions are authoritative.
- Conflicts are visible and testable.

**Tradeoffs**

- Clients need conflict handling.
- Some product interactions may require a feature-specific commutative API.
- Offline queues cannot assume eventual blind overwrite.

### 18.5 Controlled queries instead of arbitrary JSON

**Advantages**

- Query cost remains predictable.
- Every supported filter has validation and an index.
- The table does not accumulate a large universal index.

**Tradeoffs**

- Adding a query can require a migration.
- Analytics and exploratory questions need a separate system.

### 18.6 Tombstones instead of hard product deletes

**Advantages**

- Offline clients receive deletions.
- Stale creates cannot resurrect deleted data.
- Logical identity and history remain unambiguous.

**Tradeoffs**

- Deleted current rows remain stored.
- Key reuse is intentionally unavailable.

### 18.7 Maintenance cutover instead of dual-write

**Advantages**

- Less temporary code.
- One authoritative write path from the first reopened write.
- No old/new divergence reconciler.

**Tradeoffs**

- Brief downtime.
- Rollback after writes reopen is roll-forward.
- Old clients must refresh.

### 18.8 Annotations instead of separate workflow tables

**Advantages**

- Workflow state attaches to the record it describes, with one revision
  sequence and one ledger.
- The owner's full replacement can never clobber another actor's data.
- Actor filtering cleanly separates user-originated data from interventions.
- Synchronization delivers workflow state to clients with no extra API.

**Tradeoffs**

- Two write scopes must be enforced everywhere: API, validation, redaction.
- Events store the full record state, so annotation churn duplicates payload
  bytes.
- Workflows with their own lifecycle, queues, or cross-record queries still
  deserve dedicated domain tables; annotations are for state about a record,
  not for workflow machinery.

## 19. Implementation outline

Implementation should proceed only after this document is reviewed.

The store is implemented as a new module (for example `src/modules/user-data/`)
following the codebase's functional-core/imperative-shell architecture, with
`Clock` and `IdGenerator` injected as ports; the legacy learning-progress
module is retired at cutover. Receipt cleanup and the reconciliation check run
as repeatable jobs on the existing BullMQ runtime.

Test design follows the shared test-support kit: pure logic (CAS decisions,
cursor encoding, quota checks, scope rules) as table-driven unit tests;
repository semantics — CAS claims, idempotency receipts, per-owner advisory-lock
ordering, sync-cursor race-freedom, append-only enforcement — as contract
suites executed against both the in-memory fake and real PostgreSQL via
Testcontainers, with the real-database run as the authority on locking
semantics; API behavior as integration flow tests through the app with fakes.
The sync-race and concurrent-claim scenarios must never ship on fake-green
alone.

Suggested order:

1. Add the category registry — schemas, annotation namespaces, quotas, and
   immutable schema-hash checks — with representative category tests.
2. Add the three tables, constraints, privileges, and indexes.
3. Implement one atomic repository mutation path and reconstruction checks.
4. Add generic CRUD, synchronization, history, and typed errors.
5. Integrate Clerk deletion and update the anonymization inventory.
6. Replace the two client synchronization paths.
7. Build and rehearse the production migration.
8. Run correctness, failure-injection, security, performance, backup, and restore
   acceptance checks.
9. Execute the maintenance-window cutover.
10. Monitor and remove the read-only legacy table after the verification period.

## 20. Acceptance scenarios

The design is ready for implementation when the planned tests cover:

- create at expected revision zero;
- concurrent creation of the same logical key;
- concurrent replacement where exactly one expected revision succeeds;
- accepted identical payload as a new command;
- exact retry of the same idempotency key;
- reuse of an idempotency key with different content;
- receipt expiry and stale CAS protection;
- schema compatibility window and upgrade-required response;
- explicit schema migration and failed migration rollback;
- delete, tombstone synchronization, restore, and forbidden key reuse;
- current-state pagination while records change between pages;
- exact reconstruction at each verified revision;
- latest event and current-state parity;
- owner isolation and category-specific admin access;
- cross-campaign admin isolation: an admin holding one campaign's permission is
  denied on every other campaign's categories, and a category without a
  declared admin permission has no admin access at all;
- ordinary application attempts to update or delete events;
- payload byte, depth, string, and collection limits;
- category-specific PII redaction, including annotation namespace redactors;
- annotation write by an allowed actor, and rejection of a forbidden actor;
- owner replacement preserving existing annotations untouched;
- annotation writes incrementing the revision and appearing in sync;
- admin annotation events carrying identity and reason;
- per-owner record quota and rate-limit enforcement with typed errors;
- concurrent same-owner writes to different records never skipping a sync row;
- idempotent Clerk deletion across current rows, events, and receipts;
- legacy import with missing, malformed, duplicate, and mismatched events;
- client conflict retention and removal of obsolete local storage;
- sustained representative writes and indexed reads;
- PITR restore inside the selected RPO and RTO.

## 21. Deliberately deferred decisions

These are not needed for the initial implementation:

- archive file format and physical archive service;
- exact partition-migration procedure;
- organization or shared ownership;
- runtime-created campaigns or tenants — the recorded trigger for introducing
  a first-class realm column and revisiting the code-registered category
  boundary;
- anonymous writes;
- cryptographic event chains or external immutable copies;
- reliable mutation delivery to other services;
- real-time client push;
- a batch mutation endpoint for offline queues (v1 replays queued commands one
  at a time);
- universal search or analytics;
- support for payloads larger than 64 KiB;
- tombstone compaction for long-deleted records;
- a distinct `agent` actor type for autonomous agents (they ride under the
  system actor with a source marker until then).

They should be revisited only when a concrete product or operational requirement
appears.

## 22. Review checklist

Reviewers should challenge:

- whether any intended category violates the one-owner model;
- whether any payload needs more than 64 KiB;
- whether a proposed logical key or target can contain PII;
- whether a feature actually needs arbitrary querying or only a read model;
- whether a workflow is being hidden inside client-owned JSON;
- whether every schema has bounded fields and a deletion redactor;
- whether client conflict behavior is understandable to users;
- whether legacy baseline guarantees are communicated honestly;
- whether production backup and restore can meet the selected objectives;
- whether current traffic is still low enough for a maintenance cutover.

## 23. References

- docs/specs/specs-202603201356-learning-progress-generic-sync.md
- docs/USER-DATA-ANONYMIZATION.md
- src/infra/database/user/schema.sql
- src/modules/learning-progress/core/usecases/sync-events.ts
- src/modules/learning-progress/core/usecases/get-progress.ts
- client learning-progress and campaign-interaction synchronization providers
