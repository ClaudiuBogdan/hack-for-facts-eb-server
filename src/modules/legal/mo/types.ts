/**
 * Monitorul-Oficial (`mo/` area, plan 06) — domain view-model types (§2). **06
 * OWNS this file**; it imports `LegalAct`/`LegalActStatus` from the 05-owned
 * `../core/types.js` and never redefines them.
 *
 * Scalar discipline (foundation §14.1): bigint → `string`; date → `'YYYY-MM-DD'`;
 * timestamptz → ISO string. MO has **no PII** (gazette text is public) and **no
 * money** (publications are not transfers).
 *
 * ENUM VALUE-TRANSLATION (§6.1): several DB CHECK values are hyphenated, which
 * GraphQL enum values cannot be. The canonical alias↔DB maps live here (consumed
 * by both the GraphQL enum resolver maps in `graphql.ts` and the mappers), so the
 * three surfaces agree on the DB value. The filter `enumValues` carry the DB
 * values directly (kernel `toGraphQLInput` emits enum filter fields as `String`,
 * so there is no GraphQL enum on the input side to clash — only output object
 * enum fields are aliased).
 */

import type { IsoDate } from '@/modules/shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Enum vocabularies (DB values — the SQL/filter truth)
// ─────────────────────────────────────────────────────────────────────────────

/** `mo_issues.part_code` (verified live: PI/PII/PIM/PIV/PIII/PVI/PV; PVII reserved). */
export type MoPartCode = 'PI' | 'PII' | 'PIM' | 'PIII' | 'PIV' | 'PV' | 'PVI' | 'PVII';
export const MO_PART_CODES: readonly MoPartCode[] = [
  'PI',
  'PII',
  'PIM',
  'PIII',
  'PIV',
  'PV',
  'PVI',
  'PVII',
];

/** `mo_act_publications.resolution` (no hyphens — needs no translation). */
export type MoResolution = 'unique' | 'ambiguous' | 'unmatched';
export const MO_RESOLUTIONS: readonly MoResolution[] = ['unique', 'ambiguous', 'unmatched'];

/** `mo_lifecycle_edges.resolution` (`mo-only` is hyphenated — §6.1). */
export type MoEdgeResolution = 'unique' | 'mo-only' | 'ambiguous' | 'unresolved';
export const MO_EDGE_RESOLUTIONS: readonly MoEdgeResolution[] = [
  'unique',
  'mo-only',
  'ambiguous',
  'unresolved',
];

/** `mo_lifecycle_edges.relation` (no hyphens). `respinge` is EDGE-ONLY. */
export type MoRelation = 'promulga' | 'aproba' | 'respinge' | 'rectifica' | 'republica';
export const MO_RELATIONS: readonly MoRelation[] = [
  'promulga',
  'aproba',
  'respinge',
  'rectifica',
  'republica',
];

/** MO-written `act_status_events.event_kind` (5 hyphenated values — §2.4). */
export type MoStatusKind =
  | 'promulgare'
  | 'aprobare-oug'
  | 'aprobare-og'
  | 'rectificare'
  | 'republicare';
export const MO_STATUS_KINDS: readonly MoStatusKind[] = [
  'promulgare',
  'aprobare-oug',
  'aprobare-og',
  'rectificare',
  'republicare',
];

/** `*.matched_via` (hyphenated — §6.1). */
export type MoMatchedVia = 'act-year' | 'issue-year';
export const MO_MATCHED_VIA: readonly MoMatchedVia[] = ['act-year', 'issue-year'];

// ─────────────────────────────────────────────────────────────────────────────
// View models
// ─────────────────────────────────────────────────────────────────────────────

/** `legal.mo_issues` → one gazette issue. s3/sha256 internals excluded (§2.5). */
export interface MoIssue {
  readonly moIssueId: string; // bigint → string
  readonly partCode: MoPartCode;
  readonly moPart: number | null; // generated; PIM → null
  readonly issueLabel: string;
  readonly issueNumber: number | null;
  readonly issueSuffix: string;
  readonly issueYear: number;
  readonly issueDate: IsoDate | null;
  readonly pdfUrl: string | null;
  readonly hasArchiveIndex: boolean;
  readonly hasEmonitorLink: boolean;
  readonly pdfBytes: string | null; // bigint → string
  readonly firstSeenAt: string; // ISO
  readonly lastSeenAt: string;
}

/** `legal.mo_act_publications` → one publication event. Raw fields evidence-only. */
export interface MoActPublication {
  readonly moActKey: string; // PK (content sha256; opaque)
  readonly moIssueId: string | null;
  readonly actType: string | null;
  readonly actNumberNorm: string | null;
  readonly actYear: number | null;
  readonly issueYear: number | null;
  readonly issuerSlug: string | null;
  readonly title: string | null;
  readonly actDate: IsoDate | null;
  readonly actId: string | null; // null when link-not-merge unresolved
  readonly resolution: MoResolution;
  readonly matchedVia: MoMatchedVia | null;
  readonly sourcePdfUrl: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** `legal.mo_lifecycle_edges` → one lifecycle relation. evidence detail-only. */
export interface MoLifecycleEdge {
  readonly edgeId: string;
  readonly sourceMoActKey: string;
  readonly relation: MoRelation;
  readonly targetRaw: string;
  readonly targetIndex: number;
  readonly targetActType: string | null;
  readonly targetActNumber: string | null;
  readonly targetActYear: number | null;
  readonly targetIssuerSlug: string; // NOT NULL DEFAULT ''
  readonly targetActId: string | null; // identity plane
  readonly targetMoActKey: string | null; // MO-local plane
  readonly resolution: MoEdgeResolution;
  readonly matchedVia: MoMatchedVia | null;
  readonly method: string;
  readonly confidence: number | null;
}

/**
 * MO slice of `legal.act_status_events` (event_source='monitorul-oficial'). MO is
 * the CONSUMER of these rows (§2.4). `respinge` is NOT here (edge-only). An
 * out-of-set `eventKind` is dropped by the mapper, never thrown (§2.4 guard).
 */
export interface MoStatusEvent {
  readonly eventId: string;
  readonly actId: string;
  readonly eventKind: MoStatusKind;
  readonly effectiveDate: IsoDate | null;
  readonly sourceActId: string | null;
  readonly eventSource: 'monitorul-oficial';
}

/** A grouped publication count (MO-1 aggregate). */
export interface MoIssuerYearCount {
  readonly issuerSlug: string | null;
  readonly actType: string | null;
  readonly year: number | null;
  readonly count: number;
}

/** A part-code count (entity summary breakdown). */
export interface MoPartCount {
  readonly partCode: string;
  readonly count: number;
}

/** The issuer-keyed entity summary (best-effort; no CUI — §2.5). */
export interface MoIssuerSummary {
  readonly issuerSlug: string | null;
  readonly publicationCount: number;
  readonly byPartCode: readonly MoPartCount[];
  readonly lastIssueDate: IsoDate | null;
  readonly topActTypes: readonly string[];
  readonly matchConfidence: number;
}

/** A name→value discovery hit (issuer/part/act-type). */
export interface MoResolveHit {
  readonly kind: string;
  readonly value: string;
  readonly label: string;
  readonly count?: number;
}

/** The resolution-rate breakdown surfaced in the coverage block (publications/edges). */
export interface MoResolutionRates {
  readonly unique: number;
  readonly ambiguous: number;
  readonly unmatched: number;
}

/**
 * The per-collection coverage block (catalog Core Rule, §5). `resolutionRates` is
 * present only on publication/edge collections; null for `mo_issues` browse.
 */
export interface MoCoverage {
  readonly yearMin: number | null;
  readonly yearMax: number | null;
  readonly gaps: readonly string[];
  readonly resolutionRates: MoResolutionRates | null;
}

/** The act-lifecycle answer (MO-3/LG-2 MO slice). */
export interface MoActLifecycle {
  readonly statusEvents: readonly MoStatusEvent[];
  readonly inEdges: readonly MoLifecycleEdge[];
  readonly coverage: MoCoverage;
}

/** The "where published" answer (MO-4). */
export interface MoPublicationEvents {
  readonly publications: readonly MoActPublication[];
  readonly coverage: MoCoverage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Known coverage gaps (computed-cheap counts fill the year range live; gaps fixed)
// ─────────────────────────────────────────────────────────────────────────────

export const MO_COVERAGE_GAPS: readonly string[] = [
  '2011-2020 archive metadata backfill pending',
  'Part II / pre-2012 OCR deferred',
];
