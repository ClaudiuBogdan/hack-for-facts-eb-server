# Native INS source series contract

The `ins-native` module reads certified INS publications. The standalone redesign
app includes it by default; explicit module selections remain authoritative.
The embedded legacy surface keeps its interim INS roots. Deploy the standalone
activation only after catalog publication, server-role access and workload checks
pass. This document describes implemented API behavior, not rollout status.

## Geographic source identity

An INS source coordinate contains every declared geographic dimension in ascending
index order: `[[dimIndex, nomItemId], ...]`. These are source member IDs, not SIRUTA
codes. Dataset code is part of identity everywhere, including hydration and caches.
A county plus locality pair is one complete coordinate; independent lists of its
members would lose that relationship.

Modern territory selectors require an EXACT coordinate and exclude permanent
coverage qualifications and rules overlapping the observation's actual period.
Geographic containment does not imply a budget creditor relationship. Original
qualified observations remain available through complete explicit source pins;
observation lists preserve each source row rather than combining alternatives.

## Default and latest values

The server validates and pins every non-geographic classification dimension and
one declared unit. Geographic TOTAL defaults have no authority over geographic
selection. Missing default policy means NO_DATA; broken catalog references mean
ServiceUnavailable. Preferred classification IDs may supply one member per
non-geographic dimension. Competing members or geographic preferences are invalid;
IDs absent from a particular dataset are ignored, as are time and unit preferences.

After applying classifications, unit, geography, period and qualification rules:

- No observed eligible source coordinate means NO_DATA.
- One coordinate permits a fully pinned series, ordered newest first.
- Two or more coordinates mean AMBIGUOUS_GEOGRAPHY. Different latest dates or
  equal values do not justify choosing a source coordinate.

`insLatestDatasetValues` returns `observation: null`, `hasData: false`,
`latestPeriod: null` and `geographicWitnesses` for ambiguity. That field contains
exactly two distinct complete coordinates proving ambiguity, not an exhaustive
candidate list or a candidate count. It is empty for other outcomes. MCP
`get_ins_territory_snapshot` exposes the same strategy and witnesses. Use
`get_ins_series` / `insObservations` to inspect a bounded period or pin a complete
source coordinate. Latest-value requests have no period input.

Dataset codes are trimmed, uppercased and deduplicated in first-request order.
Unknown datasets are omitted. A known uncertified dataset fails the requested
batch rather than serving an older publication. Expected NO_DATA or ambiguity
for one dataset does not suppress healthy siblings.

Code, SIRUTA and level selectors intersect and must resolve to exactly one node.
Empty optional selectors are absent. National selection preserves the actual
national node; certified non-geographic datasets may serve national context with
no invented geographic coordinate.

## Dashboard and client requirements

`insUatDashboard` considers certified datasets covering the exact requested LAU.
Context filtering includes the context and its descendants via parent codes.
Coverage membership is not proof that a complete default series exists.

NO_DATA groups are omitted. Ambiguous groups stay visible with
`status: AMBIGUOUS_GEOGRAPHY`, empty observations, null latestPeriod, two
geographicWitnesses and `truncated: false`. SERIES groups expose the most recent
200 observations and explicit `truncated` status based on a 201st-row probe.
Clients must use that status rather than guessing a total response row budget.

Clients must distinguish ambiguity from missing data, suppress automatic values
and comparisons for ambiguous defaults, and preserve source coordinates in tables
and exports. They may not choose a first/last source row per period or sum source
alternatives. An explicit complete coordinate can resolve the selection.

## Execution and verification

Catalog preparation is batched by dataset. Candidate and winner SQL share the
entire eligibility predicate. Candidate LIMIT 2 applies after observed-fact
existence; winner reads recheck it. Statements batch 40 series, with explicit outer
ordering across UNION branches. Hydration keys members, measures and tuples by
dataset and rejects missing references. Reads and hydration share one publication
snapshot; operation deadlines and read-only enforcement remain in effect.

Regression tests use the real content-pinned producer DDL and independently
authored synthetic observations, including historical qualification, ambiguity, mixed-dataset identifier
collisions, missing references, GraphQL/MCP parity and chunk-boundary ordering.

## Entity statistical context

The entity contributor receives the full canonical territory from the kernel,
including its withholding policy. A public entity can have statistical context
for its canonical area regardless of fiscal executive status. This does not
assert jurisdiction, service population or institutional performance.

County nodes use county letters at NUTS3; UATs and sectors use their own SIRUTA
at LAU. Bucharest county, city and six sectors remain distinct. Country,
macroregion and development-region anchors use their NUTS codes. Unrecognized
or contradictory kernel identifiers produce no INS presence.

Within one INS snapshot, exact source identity and reverse core links must agree.
A missing bridge link is allowed when the source identity is unique. Contradictory
or duplicate links return ServiceUnavailable; the existing entity aggregator
suppresses a failed contributor while retaining other sources. Coverage counts certified datasets with modern coverage for the exact node,
not all datasets at its level.
Coverage does not prove a unique default series. Public presence attributes expose
source code, level, name and optional SIRUTA, never the core surrogate ID.

Before enabling INS, validate all 42 county codes against the published source
spine and measure national-context discovery on the fully loaded catalog. Every
kernel country, macroregion, development-region and county row must also yield
a non-null identity through this mapping; validate both sides before enablement.

Source member IDs round-trip through public member codes and opaque observation
references over the complete signed PostgreSQL integer domain, including zero.
The parser rejects overflow, fractions and exponent notation; emitted codes
remain canonical decimal strings. Dimension identity still follows the producer
contract: classification indexes 0–6, then time and unit as the final dimensions.

## Exact source selection input

`InsObservationFilterInput.sourcePins` carries exact dataset-scoped pairs:
`[{dimensionIndex: 2, memberCode: "3075"}, {dimensionIndex: 3, memberCode: "931"}]`.
Each pair names a declared classification or geographic dimension. There are at
most seven entries, with one member per unique dimension. Codes must be canonical
signed PostgreSQL int32 decimal strings, including `"0"`; whitespace, leading
zeros, exponent syntax, `"-0"`, and `TOTAL` aliases are rejected. Membership is
validated in the requested dimension, even when the same ID belongs to multiple
axes. This avoids the cross-product ambiguity of independent type/value lists.

The paired field is mutually exclusive with `classificationTypeCodes` and
`classificationValueCodes`, including empty legacy arrays. Omit both legacy
fields when sending pairs. Unit selections remain independent. Explicit canonical
territory filters intersect the source pins; source pins never broaden them.
Without a canonical territory or level, every geographic dimension must be pinned
to one member. Partial non-geographic selections can be inspected under a bounded
canonical scope, but do not identify a complete series for charts or aggregation.

This addition is on the native GraphQL surface. Each client must migrate its
requests as a complete pair-preserving change. MCP input parity and the remaining
client/data publication gates are required before full INS enablement.

## MCP source inspection and continuation

`get_ins_series` accepts exact `sourcePins` pairs with the same membership and
geographic admission checks as GraphQL. Legacy classification lists retain their
TOTAL default; supplying either list together with paired pins fails. Canonical
territory codes/levels intersect explicit source geography. Unit codes, all six
native cadences, inclusive period bounds and optional `hasValue` use the existing
fact query. Omit `hasValue` to retain null source cells. The three existing bound
syntaxes remain YYYY, YYYY-QN and YYYY-MM; RANGE/OTHER tokens are not invented.

Each page returns shared opaque observation IDs, original decimal strings, status,
members, units and geographic qualifications. `meta.descriptor` contains the
source dataset and complete dimension declarations, source URL, custody and
publication stamps. Multiple identities and qualified rows remain original
observations, not an automatically resolved series.

The first page defaults to limit 200 and offset zero. Continue with the same
filters, `meta.nextOffset` and `expectedPublication: meta.publication`. A token
contains revision ID, source custody hash and transform hash. All three are
compared in code inside the same snapshot as metadata and facts; none enters SQL.
Offset greater than zero requires a token. A mismatch returns a failed
ServiceUnavailable envelope with `meta.reason: PUBLICATION_CHANGED` and
`meta.currentPublication`; restart at zero rather than combining publications.
`totalCount` may be null; continuation comes from `hasNextPage`, and `nextOffset`
advances by actual returned rows. `hasMore` is retained for existing callers.

Unknown datasets preserve the old empty-result behavior with a null descriptor.
Not-loaded datasets return metadata and empty observations, without a fabricated
publication token. Uncertified loaded data remains unavailable. Unknown input
keys now fail explicitly. The input schema enforces at most seven exact pins,
canonical signed PostgreSQL int32 member IDs, limit 1–1000 and nonnegative int32
offset. That offset bound is a wire limit, not a workload or latency guarantee;
statement deadlines and the pre-enablement workload gate remain necessary.

## Accepted initial catalog publication

The initial catalog producer (scrapper `f5d096c2`) preserves native facts and
custody. It atomically publishes missing catalogs, audited territory metadata,
canonical bridge identifiers and zero-fact-delta revisions with a completed load
run. Final admission uses this module's actual `datasetPublicationFrom` query.
This is an initial catalog publication, not a historical fact reload.

The allowlist accepts its exact contract hash
`b07e45419dd84c341baa1721c42fade59ff2350a55d5861db16b15a76f54b97b` and the normal
transform's equivalent coverage and geographic-grouping optimizations
`435cb383b7c1ccecb964486ecc8b20eca1bb748e7dd29c5ec97a57715f4c7585`.
The earlier contract remains accepted. Unknown latest transforms still fail
closed; all custody, count and geography checks remain required. These hashes
alone neither enable the module nor certify that a publication has been applied.
