# Native INS source series contract

The `ins-native` module reads certified INS publications. It remains disabled
until the client, canonical territory bridge, publication and workload checks are
complete. This document describes implemented API behavior, not rollout status.

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
