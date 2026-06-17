/**
 * Monitorul-Oficial (`mo/` area, plan 06) — row → view-model mappers (pure) +
 * the DB↔GraphQL enum value-translation tables (§6.1).
 *
 * snake_case DB rows → camelCase domain types. Enum DB values are coerced to the
 * closed view-model vocab; an UNKNOWN value is mapped to a safe default and never
 * throws (the §2.4 serialization guard). bigint/text ids are already strings.
 *
 * The `*_TO_GQL` maps below are the SINGLE canonical alias mapping: they are
 * consumed BOTH here (used implicitly via the closed vocab) AND as the GraphQL
 * enum resolver maps in `graphql.ts` (graphql-tools `internal value → enum name`
 * convention), so output enums serialize the hyphenated DB value to its alias.
 */

import {
  MO_EDGE_RESOLUTIONS,
  MO_PART_CODES,
  MO_RELATIONS,
  MO_RESOLUTIONS,
  MO_STATUS_KINDS,
  type MoEdgeResolution,
  type MoIssue,
  type MoActPublication,
  type MoLifecycleEdge,
  type MoMatchedVia,
  type MoPartCode,
  type MoRelation,
  type MoResolution,
  type MoStatusEvent,
  type MoStatusKind,
} from './types.js';

import type {
  LegalMoActPublicationsTable,
  LegalMoIssuesTable,
  LegalMoLifecycleEdgesTable,
} from './db-schema.js';

const PART_SET = new Set<string>(MO_PART_CODES);
const RES_SET = new Set<string>(MO_RESOLUTIONS);
const EDGE_RES_SET = new Set<string>(MO_EDGE_RESOLUTIONS);
const RELATION_SET = new Set<string>(MO_RELATIONS);
const STATUS_KIND_SET = new Set<string>(MO_STATUS_KINDS);

const toPartCode = (s: string): MoPartCode => (PART_SET.has(s) ? (s as MoPartCode) : 'PI');
const toResolution = (s: string): MoResolution => (RES_SET.has(s) ? (s as MoResolution) : 'unmatched');
const toEdgeResolution = (s: string): MoEdgeResolution =>
  EDGE_RES_SET.has(s) ? (s as MoEdgeResolution) : 'unresolved';
const toRelation = (s: string): MoRelation => (RELATION_SET.has(s) ? (s as MoRelation) : 'rectifica');
const toMatchedVia = (s: string | null): MoMatchedVia | null =>
  s === 'act-year' || s === 'issue-year' ? s : null;

/** True iff the DB event_kind is one MO writes (out-of-set → dropped, §2.4). */
export const isMoStatusKind = (s: string): s is MoStatusKind => STATUS_KIND_SET.has(s);

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL enum resolver maps (graphql-tools: enum NAME → internal/DB value).
// Used so an internal `'mo-only'` serializes to the GraphQL alias `mo_only`.
// ─────────────────────────────────────────────────────────────────────────────

export const MO_EDGE_RESOLUTION_GQL: Record<string, MoEdgeResolution> = {
  unique: 'unique',
  mo_only: 'mo-only',
  ambiguous: 'ambiguous',
  unresolved: 'unresolved',
};

export const MO_STATUS_KIND_GQL: Record<string, MoStatusKind> = {
  promulgare: 'promulgare',
  aprobare_oug: 'aprobare-oug',
  aprobare_og: 'aprobare-og',
  rectificare: 'rectificare',
  republicare: 'republicare',
};

export const MO_MATCHED_VIA_GQL: Record<string, MoMatchedVia> = {
  act_year: 'act-year',
  issue_year: 'issue-year',
};

// ─────────────────────────────────────────────────────────────────────────────
// Row mappers (the repo selects only these columns; ts-typed via db-schema)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The subset of `mo_issues` columns the repo projects (internals excluded). The
 * timestamptz columns are selected `::text` so the row carries plain ISO strings
 * (the `Tstz` ColumnType on the table is the unprojected form).
 */
export type MoIssueRow = Pick<
  LegalMoIssuesTable,
  | 'mo_issue_id'
  | 'part_code'
  | 'mo_part'
  | 'issue_label'
  | 'issue_number'
  | 'issue_suffix'
  | 'issue_year'
  | 'issue_date'
  | 'pdf_url'
  | 'has_archive_index'
  | 'has_emonitor_link'
  | 'pdf_bytes'
> & { first_seen_at: string; last_seen_at: string };

export const mapIssue = (r: MoIssueRow): MoIssue => ({
  moIssueId: r.mo_issue_id,
  partCode: toPartCode(r.part_code),
  moPart: r.mo_part,
  issueLabel: r.issue_label,
  issueNumber: r.issue_number,
  issueSuffix: r.issue_suffix,
  issueYear: r.issue_year,
  issueDate: r.issue_date,
  pdfUrl: r.pdf_url,
  hasArchiveIndex: r.has_archive_index,
  hasEmonitorLink: r.has_emonitor_link,
  pdfBytes: r.pdf_bytes,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
});

/** The subset of `mo_act_publications` the repo projects (raw fields excluded). */
export type MoActPublicationRow = Pick<
  LegalMoActPublicationsTable,
  | 'mo_act_key'
  | 'mo_issue_id'
  | 'act_type'
  | 'act_number_norm'
  | 'act_year'
  | 'issue_year'
  | 'issuer_slug'
  | 'title'
  | 'act_date'
  | 'act_id'
  | 'resolution'
  | 'matched_via'
  | 'source_pdf_url'
> & { first_seen_at: string; last_seen_at: string };

export const mapPublication = (r: MoActPublicationRow): MoActPublication => ({
  moActKey: r.mo_act_key,
  moIssueId: r.mo_issue_id,
  actType: r.act_type,
  actNumberNorm: r.act_number_norm,
  actYear: r.act_year,
  issueYear: r.issue_year,
  issuerSlug: r.issuer_slug,
  title: r.title,
  actDate: r.act_date,
  actId: r.act_id,
  resolution: toResolution(r.resolution),
  matchedVia: toMatchedVia(r.matched_via),
  sourcePdfUrl: r.source_pdf_url,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
});

/** The subset of `mo_lifecycle_edges` the repo projects (evidence excluded). */
export type MoLifecycleEdgeRow = Pick<
  LegalMoLifecycleEdgesTable,
  | 'edge_id'
  | 'source_mo_act_key'
  | 'relation'
  | 'target_raw'
  | 'target_index'
  | 'target_act_type'
  | 'target_act_number'
  | 'target_act_year'
  | 'target_issuer_slug'
  | 'target_act_id'
  | 'target_mo_act_key'
  | 'resolution'
  | 'matched_via'
  | 'method'
  | 'confidence'
>;

export const mapEdge = (r: MoLifecycleEdgeRow): MoLifecycleEdge => ({
  edgeId: r.edge_id,
  sourceMoActKey: r.source_mo_act_key,
  relation: toRelation(r.relation),
  targetRaw: r.target_raw,
  targetIndex: r.target_index,
  targetActType: r.target_act_type,
  targetActNumber: r.target_act_number,
  targetActYear: r.target_act_year,
  targetIssuerSlug: r.target_issuer_slug,
  targetActId: r.target_act_id,
  targetMoActKey: r.target_mo_act_key,
  resolution: toEdgeResolution(r.resolution),
  matchedVia: toMatchedVia(r.matched_via),
  method: r.method,
  confidence: r.confidence,
});

/** A row from `legal.act_status_events` (MO slice). */
export interface MoStatusEventRow {
  event_id: string;
  act_id: string;
  event_kind: string;
  effective_date: string | null;
  source_act_id: string | null;
}

/**
 * Map an MO status-event row, or `null` if the kind is out-of-set (the §2.4
 * serialization guard — drop + caller logs, never throw). `eventSource` is fixed
 * to `'monitorul-oficial'` (the only rows the repo selects).
 */
export const mapStatusEvent = (r: MoStatusEventRow): MoStatusEvent | null => {
  if (!isMoStatusKind(r.event_kind)) return null;
  return {
    eventId: r.event_id,
    actId: r.act_id,
    eventKind: r.event_kind,
    effectiveDate: r.effective_date,
    sourceActId: r.source_act_id,
    eventSource: 'monitorul-oficial',
  };
};
