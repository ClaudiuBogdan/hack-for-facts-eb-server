/**
 * Reference module — domain view-models (plan §2).
 *
 * The reference module is the READ surface over the kernel's `core.*` data. It
 * OWNS only two view-models — `ReferencePublicEntity` (core.public_entities) and
 * `ReferenceClassificationCode` (core.classification_codes) — plus two derived
 * GROUP-BY projections over `core.territories` (`ReferenceCounty`/`ReferenceRegion`).
 * The kernel `Organization`/`Territory`/`ResolveHit` types are REUSED verbatim
 * (§0/§14.8); this module never redefines them.
 *
 * `field_trace` lives ONLY on the detail view (`ReferencePublicEntity`). The MCP /
 * cross-source-card path uses `ReferencePublicEntityCard` — a STRUCTURALLY trimmed
 * type with NO fieldTrace field — so a stray object spread can never leak the debug
 * provenance to an agent (review B-S5 / Codex SHOULD-FIX). The mapper produces the
 * card; the detail extends it.
 */

import type { ResolveHit, Territory } from '@/modules/shared/index.js';

/** The resolve dimensions this module exposes (§7.3). `organization` reuses the kernel IdentityRepo. */
export const REFERENCE_RESOLVE_DIMS = [
  'public_entity',
  'territory',
  'classification',
  'organization',
] as const;
export type ReferenceResolveDim = (typeof REFERENCE_RESOLVE_DIMS)[number];

/** The aggregate dimensions for the public-entity registry stats (§4 / R4). */
export const REFERENCE_AGGREGATE_DIMS = ['entity_type', 'category', 'is_uat', 'county'] as const;
export type ReferenceAggregateDim = (typeof REFERENCE_AGGREGATE_DIMS)[number];

/** Provenance of the UAT mapping (reference-only attrs — no other module cares). */
export interface ReferenceUatMapping {
  readonly method: string | null;
  readonly confidence: string | null;
  readonly unresolvedReason: string | null;
}

/** The two parent-creditor CUIs (link, not merge). */
export interface ReferenceParentCreditors {
  readonly cui1: string | null;
  readonly cui2: string | null;
}

/**
 * The public-entity registry CARD — the MCP / cross-source-contributor shape. It
 * has NO `fieldTrace` field by construction, so no surface that returns a card can
 * ever leak the debug provenance. `territory` is the FULL kernel `Territory` (no
 * fork — §0 boundary), resolved through the kernel TerritoryRepo; null on lists /
 * unresolved links.
 */
export interface ReferencePublicEntityCard {
  readonly cui: string;
  readonly name: string;
  readonly address: string | null;
  readonly entityType: string | null;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly isUat: boolean;
  readonly territorialSirutaCode: string | null;
  readonly uatMapping: ReferenceUatMapping;
  readonly parents: ReferenceParentCreditors;
  /** main_creditors jsonb — passthrough array of opaque objects (no PII). */
  readonly mainCreditors: readonly unknown[];
  readonly defaultReportType: string | null;
  /** issues jsonb (data-quality pattern, §4.1). Empty for all rows in the current snapshot. */
  readonly issues: readonly unknown[];
  readonly updatedAt: string;
  /** Canonical kernel territory, resolved via TerritoryRepo. Null on lists / unresolved links. */
  readonly territory: Territory | null;
}

/**
 * The public-entity DETAIL view — the card PLUS the debug-only `field_trace`.
 * `fieldTrace` is non-null ONLY when explicitly requested (detail query with
 * includeTrace:true) and is NEVER emitted via MCP (MCP returns the card).
 */
export interface ReferencePublicEntity extends ReferencePublicEntityCard {
  readonly fieldTrace: Record<string, unknown> | null;
}

/** `core.classification_codes` → module-owned view-model (plan §2.3). CAEN-only. */
export const REFERENCE_CLASSIFICATION_SYSTEMS = ['caen_rev1', 'caen_rev2', 'caen_rev3'] as const;
export type ReferenceClassificationSystem = (typeof REFERENCE_CLASSIFICATION_SYSTEMS)[number];

export interface ReferenceClassificationCode {
  readonly system: string;
  readonly code: string;
  readonly label: string | null;
  readonly parentCode: string | null;
}

/** A county rollup over `core.territories` (GROUP BY projection, plan §2.2). */
export interface ReferenceCounty {
  readonly countyCode: string;
  readonly countyName: string;
  readonly region: string | null;
  readonly uatCount: number;
  readonly population: number | null;
}

/** A development-region rollup over `core.territories` (GROUP BY projection). */
export interface ReferenceRegion {
  readonly region: string;
  readonly countyCount: number;
  readonly uatCount: number;
}

/** One `{key,count}` registry-aggregate bucket (R4). `label` is a friendly name where resolvable. */
export interface ReferenceCountBucket {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
}

/**
 * The resolve surface reuses the KERNEL `ResolveHit` verbatim (§7.4) — `kind` is
 * the dimension, `value` the filter value (CUI/SIRUTA/code), `label` the name,
 * `hint` optional disambiguation (county/region/system). No `Reference*ResolveHit`
 * fork (review SHOULD-FIX, both models).
 */
export type ReferenceResolveHit = ResolveHit;

/** Re-export the kernel types so module consumers reference one type. */
export type { ResolveHit, Territory };
