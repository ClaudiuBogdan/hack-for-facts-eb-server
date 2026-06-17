/**
 * Shared Kernel — Domain types & scalars (foundation §4, §14.1).
 *
 * Scalar representation contract (§14.1) — resolves the bigint/precision trap:
 *   org_id   bigint        -> string   (GraphQL BigInt)   never JS number
 *   cui      text          -> string   (GraphQL CUI)      cross-source link key
 *   siruta   text/integer  -> string   (GraphQL SIRUTA)   canonicalized to text
 *   money    numeric(18,2) -> string   (GraphQL Money)    nullable; never float
 *   date     date          -> string   (GraphQL Date)     'YYYY-MM-DD'
 *   ts       timestamptz   -> string   (GraphQL DateTime) ISO 8601
 *
 * The cross-source link & DataLoader key is **CUI**, not org_id.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scalar aliases (intent-documenting; all are `string` at runtime)
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized Romanian fiscal code (digits only, RO stripped). */
export type Cui = string;
/** A SIRUTA territorial code, canonicalized to text. */
export type Siruta = string;
/** A bigint id rendered as a decimal string (no precision loss). */
export type BigIntString = string;
/** A `numeric(18,2)` money amount as a string. Nullable where the column is. */
export type Money = string;
/** An ISO date 'YYYY-MM-DD'. */
export type IsoDate = string;
/** An ISO 8601 datetime with timezone. */
export type IsoDateTime = string;

// ─────────────────────────────────────────────────────────────────────────────
// CUI normalization (mirrors SQL core.normalize_cui())
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a Romanian CUI/CIF: uppercase, strip a leading `RO`, keep digits.
 * Returns null when nothing usable remains.
 */
export const normalizeCui = (raw: string): Cui | null => {
  const result = raw
    .toUpperCase()
    .trim()
    .replace(/^RO/u, '')
    .replace(/[^0-9]/gu, '');
  return result.length > 0 ? result : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Flow & document type registries (§4.3, §4.5) — kept in sync with prod
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `flows.money_flows.flow_type` values. The first group is live (verified against
 * prod); `budget_execution` is DECLARED by the budget module but not yet projected
 * into `flows.money_flows` (the budget contributor is capability-gated empty for
 * flows — plan 02 §4.1/§13.1).
 */
export const FLOW_TYPES = [
  'direct_acquisition',
  'procurement_contract',
  'pnrr_payment',
  'pnrr_commitment',
  'pnrr_subcontract',
  'budget_execution',
] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/** `search.documents.doc_type` values (live + planned, foundation §4.5/§15.1). */
export const DOC_TYPES = [
  'legal_act',
  'portal_section',
  'mo_act',
  'mo_section',
  'mo_section_metadata',
  'procurement_procedure',
  'procurement_contract',
  'procurement_direct_acquisition',
  'pnrr_entity',
  'pnrr_announcement',
  'pnrr_acquisition',
  'pnrr_contractor',
  'pnrr_measure',
  'parliament_bill_dossier',
  'parliament_bill_law_link',
  'parliament_control_item',
  'parliament_speech_segment',
  'judicial_case',
  'primarii_transparency_entity',
  // DECLARED by the budget module; not yet written to search.documents (gated).
  'budget_entity',
  'budget_report',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Kernel domain value objects (grounded in the live core/flows/search schema)
// ─────────────────────────────────────────────────────────────────────────────

/** `core.organizations` — the CUI-keyed identity hub (§4.1). */
export interface Organization {
  readonly orgId: BigIntString;
  readonly cui: Cui | null;
  readonly registrationNumber: string | null;
  readonly kind: string; // 'public_entity' | 'company' | 'ngo' | ...
  readonly name: string;
  readonly normalizedName: string | null;
  readonly countyName: string | null;
  readonly localityName: string | null;
  readonly sirutaCode: Siruta | null;
  readonly firstSeenSource: string;
  readonly attrs: Record<string, unknown>;
}

/** `core.organization_identifiers`. */
export interface OrgIdentifier {
  readonly scheme: string;
  readonly value: string;
  readonly source: string;
}

/** A name-search match (Meili-primary, pg fallback) — §15.7. */
export interface OrgNameMatch {
  readonly orgId: BigIntString;
  readonly cui: Cui | null;
  readonly name: string;
  readonly normalizedName: string | null;
  readonly countyName: string | null;
  readonly kind: string;
  readonly score?: number;
}

/** `core.territories` — the SIRUTA-keyed territory hub (§4.2). */
export interface Territory {
  readonly id: number;
  readonly territorialSirutaCode: Siruta | null;
  readonly sirutaCode: Siruta | null;
  readonly countySirutaCode: Siruta | null;
  readonly uatCode: string | null;
  readonly name: string;
  readonly countyCode: string | null;
  readonly countyName: string | null;
  readonly region: string | null;
  readonly population: number | null;
}

export interface CountyRef {
  readonly countyCode: string;
  readonly countyName: string;
}

/** `core.classification_codes`. */
export interface ClassificationCode {
  readonly system: string;
  readonly code: string;
  readonly label: string | null;
  readonly parentCode: string | null;
}

/** A single `flows.money_flows` row (cross-source money graph, §4.3). */
export interface MoneyFlow {
  readonly flowId: BigIntString;
  readonly flowType: string;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
  readonly payerCui: Cui | null;
  readonly payerName: string | null;
  readonly payerOrgId: BigIntString | null;
  readonly payeeCui: Cui | null;
  readonly payeeName: string | null;
  readonly payeeOrgId: BigIntString | null;
  readonly amountRon: Money | null;
  readonly amountEur: Money | null;
  readonly currency: string | null;
  readonly flowDate: IsoDate | null;
  readonly flowYear: number | null;
  readonly title: string | null;
  readonly classificationSystem: string | null;
  readonly classificationCode: string | null;
  readonly countyName: string | null;
}

export type FlowDirection = 'in' | 'out';

export interface FlowTypeBreakdown {
  readonly flowType: string;
  readonly count: number;
  readonly totalAmountRon: Money;
}

/** Aggregated flow summary by CUI + direction (§4.3). */
export interface FlowSummary {
  readonly direction: FlowDirection;
  readonly count: number;
  readonly totalAmountRon: Money;
  readonly minYear: number | null;
  readonly maxYear: number | null;
  readonly byFlowType: readonly FlowTypeBreakdown[];
}

/** A counterparty rollup (top payers/payees). */
export interface Counterparty {
  readonly cui: Cui;
  readonly name: string | null;
  readonly totalAmountRon: Money;
  readonly flowCount: number;
}

export interface FlowAggregateGroup {
  readonly key: string;
  readonly count: number;
  readonly totalAmountRon: Money;
}

export interface NetworkNode {
  readonly cui: Cui;
  readonly name: string;
  readonly totalIn: Money;
  readonly totalOut: Money;
}

export interface NetworkEdge {
  readonly payerCui: Cui;
  readonly payeeCui: Cui;
  readonly totalAmount: Money;
  readonly flowCount: number;
}

export interface CounterpartyNetwork {
  readonly rootCui: Cui;
  readonly depth: number;
  readonly nodes: readonly NetworkNode[];
  readonly edges: readonly NetworkEdge[];
}

/** A `search.documents` projection (§4.5). */
export interface Document {
  readonly docId: string;
  readonly docType: string;
  readonly title: string;
  readonly body: string | null;
  readonly cuis: readonly Cui[];
  readonly docDate: IsoDate | null;
  readonly amountRon: Money | null;
  readonly countyName: string | null;
  readonly url: string | null;
  readonly attrs: Record<string, unknown>;
}

/** A hybrid-search hit (Meili / OpenSearch / pg fallback). */
export interface SearchHit {
  readonly id: string;
  readonly docType: string;
  readonly title: string;
  readonly snippet: string | null;
  readonly score: number | null;
  readonly source: 'meili' | 'opensearch' | 'postgres';
  readonly attrs: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source aggregation shapes (§4.4 — canonical open shapes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-source presence summary for entity-360 (§4.4 / §15.2). Deliberately open:
 * common fields + a per-source `attrs` payload. Retires the old fixed boolean
 * record.
 */
export interface SourcePresence {
  readonly source: string;
  readonly present: boolean;
  readonly label?: string;
  readonly count?: number;
  readonly badges?: readonly string[];
  readonly asOf?: Record<string, string | null>;
  readonly attrs?: Record<string, unknown>;
}

/** A per-source profile slice for entity-360 fan-out (§4.4 / §15.2). */
export interface EntityProfileSlice {
  readonly source: string;
  readonly kind: string;
  readonly summary?: string;
  readonly data?: Record<string, unknown>;
}

/**
 * A name→value discovery/resolve hit (the §7.4 resolve pattern, shared across
 * modules). `kind` is the dimension resolved (e.g. 'entity' | 'county' |
 * 'cpv' | 'component'); `value` is the filter value to feed back (CUI, SIRUTA,
 * code, status); `label` is the human-readable name; `score` is an optional
 * match confidence; `hint` is optional extra context (county, year, type) the
 * UI/agent can disambiguate on. Modules reuse this un-prefixed rather than each
 * inventing a `*ResolveHit`.
 */
export interface ResolveHit {
  readonly kind: string;
  readonly value: string;
  readonly label: string;
  readonly score?: number;
  readonly hint?: string;
}

/** Health status of an auxiliary service. */
export interface ServiceStatus {
  readonly status: 'ok' | 'error' | 'disabled';
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface HealthReport {
  readonly overall: 'healthy' | 'degraded';
  readonly postgres: ServiceStatus;
  readonly meilisearch: ServiceStatus;
  readonly opensearch: ServiceStatus;
  readonly synthetic: ServiceStatus;
}
