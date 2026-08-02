/**
 * Legal module — row → view-model mappers (pure). snake_case DB rows → camelCase
 * domain types. Status is coerced to the closed `LegalActStatus` vocab (unknown →
 * 'necunoscut'); relations to the closed `LegalRelation` vocab. `null` arrays
 * default to `[]`. bigint/text ids are already strings (int8 parser / text column).
 */

import {
  type LegalAct,
  type LegalActStatus,
  type LegalCitationKey,
  type LegalDocument,
  type LegalActSummary,
  type LegalExternalAct,
  type LegalNode,
  type LegalReferenceEdge,
  type LegalRelation,
  type LegalStatusEvent,
  type LegalEventSource,
  type LegalVersionProvenance,
  LEGAL_ACT_STATUSES,
  LEGAL_RELATIONS,
} from '../../core/types.js';

const STATUS_SET = new Set<string>(LEGAL_ACT_STATUSES);
const RELATION_SET = new Set<string>(LEGAL_RELATIONS);

/** Coerce a DB status string to the closed vocab (unknown → 'necunoscut'). */
export const toStatus = (s: string | null): LegalActStatus =>
  s !== null && STATUS_SET.has(s) ? (s as LegalActStatus) : 'necunoscut';

/** Coerce a DB relation string to the closed vocab (unknown → 'face-referire'). */
export const toRelation = (s: string): LegalRelation =>
  RELATION_SET.has(s) ? (s as LegalRelation) : 'face-referire';

const toEventSource = (s: string): LegalEventSource =>
  s === 'monitorul-oficial' ? 'monitorul-oficial' : 'portal';

/** Coerce a jsonb column to a plain object (null/non-object → {}). */
const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const arr = (v: readonly string[] | null): readonly string[] => v ?? [];

export interface ActRow {
  act_id: string;
  act_natural_key: string;
  act_type: string;
  act_number: string | null;
  act_year: number | null;
  issuer_slug: string | null;
  canonical_document_id: string | null;
  display_citation: string;
  status: string;
  status_evidence: unknown;
  entry_into_force: string | null;
  in_degree: number;
}

export const mapAct = (r: ActRow): LegalAct => ({
  actId: r.act_id,
  actNaturalKey: r.act_natural_key,
  actType: r.act_type,
  actNumber: r.act_number,
  actYear: r.act_year,
  issuerSlug: r.issuer_slug,
  canonicalDocumentId: r.canonical_document_id,
  displayCitation: r.display_citation,
  status: toStatus(r.status),
  statusEvidence: asObject(r.status_evidence),
  entryIntoForce: r.entry_into_force,
  inDegree: r.in_degree,
});

export interface DocRow {
  document_id: string;
  act_id: string;
  version_kind: string;
  version_date: string | null;
  is_canonical: boolean | null;
  den: string | null;
  title: string | null;
  issuer_raw: string | null;
  publication_raw: string | null;
  entry_into_force: string | null;
  first_publication_date: string | null;
  status_markers: string[] | null;
  extraction_status: string | null;
  compatibility_tier: string | null;
  mo_part: number | null;
  mo_number: string | null;
  mo_date: string | null;
}

export const mapDocument = (r: DocRow): LegalDocument => ({
  documentId: r.document_id,
  actId: r.act_id,
  versionKind: r.version_kind,
  versionDate: r.version_date,
  isCanonical: r.is_canonical ?? false,
  den: r.den,
  title: r.title,
  issuerRaw: r.issuer_raw,
  publicationRaw: r.publication_raw,
  entryIntoForce: r.entry_into_force,
  firstPublicationDate: r.first_publication_date,
  statusMarkers: arr(r.status_markers),
  extractionStatus: r.extraction_status,
  compatibilityTier: r.compatibility_tier,
  moPart: r.mo_part,
  moNumber: r.mo_number,
  moDate: r.mo_date,
});

export interface ProvenanceRow {
  act_id: string;
  version_kind: string | null; // null only if an act had no canonical document
  version_date: string | null;
  source_url: string | null;
  amended: string | number; // count(*) → int8, driver-dependent
  consolidation_date: string | null;
  consolidation_status: string | null;
}

/**
 * A consolidation row counts as LOADED once it has been fetched. The timeline
 * lane writes anchors as `extraction_status='not_fetched'`; a null status is a
 * row we cannot vouch for either, so both read as not-loaded.
 */
export const mapProvenance = (r: ProvenanceRow): LegalVersionProvenance => ({
  versionKind: r.version_kind ?? '',
  versionDate: r.version_date,
  sourceUrl: r.source_url,
  amendedAfterPublication: Number(r.amended),
  latestConsolidationDate: r.consolidation_date,
  latestConsolidationLoaded:
    r.consolidation_date !== null &&
    r.consolidation_status !== null &&
    r.consolidation_status !== 'not_fetched',
});

export interface SummaryRow {
  document_id: string;
  description: string | null;
  summary: string | null;
  plain_language_summary: string | null;
  document_category: string | null;
  domains: string[] | null;
  affected_audiences: string[] | null;
  keywords: string[] | null;
  key_dates: unknown;
  penalties_mentioned: boolean | null;
  fiscal_impact: string | null;
  confidence: number | null;
  source_extraction_status: string | null;
}

export const mapSummary = (r: SummaryRow): LegalActSummary => ({
  documentId: r.document_id,
  description: r.description,
  summary: r.summary,
  plainLanguageSummary: r.plain_language_summary,
  documentCategory: r.document_category,
  domains: arr(r.domains),
  affectedAudiences: arr(r.affected_audiences),
  keywords: arr(r.keywords),
  keyDates: r.key_dates ?? null,
  penaltiesMentioned: r.penalties_mentioned,
  fiscalImpact: r.fiscal_impact,
  confidence: r.confidence,
  sourceExtractionStatus: r.source_extraction_status,
});

export interface CitationKeyRow {
  act_type: string;
  act_number: string;
  act_year: number;
  issuer_slug: string;
}

export const mapCitationKey = (r: CitationKeyRow): LegalCitationKey => ({
  actType: r.act_type,
  actNumber: r.act_number,
  actYear: r.act_year,
  issuerSlug: r.issuer_slug,
});

export interface RefRow {
  source_document_id: string;
  ref_index: number;
  relation: string;
  target_raw: string;
  target_class: string;
  target_act_id: string | null;
  target_external_act_id: string | null;
  target_fragment: string | null;
  resolution: string;
  confidence: number | null;
  resolver_version: string;
}

export const mapReferenceEdge = (r: RefRow): LegalReferenceEdge => ({
  sourceDocumentId: r.source_document_id,
  refIndex: r.ref_index,
  relation: toRelation(r.relation),
  targetRaw: r.target_raw,
  targetClass: r.target_class,
  targetActId: r.target_act_id,
  targetExternalActId: r.target_external_act_id,
  targetFragment: r.target_fragment,
  resolution: r.resolution,
  confidence: r.confidence,
  resolverVersion: r.resolver_version,
});

export interface StatusEventRow {
  event_id: string;
  act_id: string;
  event_kind: string;
  effective_date: string | null;
  source_act_id: string | null;
  evidence: unknown;
  event_source: string;
}

export const mapStatusEvent = (r: StatusEventRow): LegalStatusEvent => ({
  eventId: r.event_id,
  actId: r.act_id,
  eventKind: r.event_kind,
  effectiveDate: r.effective_date,
  sourceActId: r.source_act_id,
  evidence: asObject(r.evidence),
  eventSource: toEventSource(r.event_source),
});

export interface NodeRow {
  node_id: string;
  document_id: string;
  parent_node_id: string | null;
  node_kind: string;
  label: string | null;
  number_key: string | null;
  path: string;
  order_index: number;
  char_start: number | null;
  char_end: number | null;
}

export const mapNode = (r: NodeRow): LegalNode => ({
  nodeId: r.node_id,
  documentId: r.document_id,
  parentNodeId: r.parent_node_id,
  nodeKind: r.node_kind,
  label: r.label,
  numberKey: r.number_key,
  path: r.path,
  orderIndex: r.order_index,
  charStart: r.char_start,
  charEnd: r.char_end,
});

export interface ExternalActRow {
  external_act_id: string;
  identity_key: string;
  display_citation: string;
  kind: string;
}

export const mapExternalAct = (r: ExternalActRow): LegalExternalAct => ({
  externalActId: r.external_act_id,
  identityKey: r.identity_key,
  displayCitation: r.display_citation,
  kind: r.kind,
});
