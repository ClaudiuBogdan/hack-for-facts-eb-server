/**
 * Judicial module — domain view models (plan 08 §2.2). **PRIVACY-CRITICAL.**
 *
 * The row types here are the contract the three surfaces (GraphQL, MCP — no REST)
 * project. They are **structurally name-free**: there is no `displayName`,
 * `name`, `solution`, or `solutionSummary` field on `JudicialParty` /
 * `JudicialHearing`. A developer cannot return those columns because the type
 * system has no slot for them (plan §0 mechanism #1).
 *
 * Publishable names exist ONLY as the `PublishableName` value object, produced
 * solely by `PartyDictionaryRepo.getPublishableName(s)` (the ONE gated reader of
 * `party_name_keys.display_name`). They are joined to parties in the USECASE
 * layer, never by a party SELECT (plan §2.2, §3.2).
 *
 * Scalars (§14.1): `caseId`/`nameKeyId`/`candidateId` are bigint → string; dates
 * are `YYYY-MM-DD`; timestamps ISO strings.
 */

// ── enums ──────────────────────────────────────────────────────────────────────

/** `justice.courts.court_level` (DB CHECK). */
export type JudicialCourtLevel =
  | 'judecatorie'
  | 'tribunal'
  | 'tribunal_militar'
  | 'curte_de_apel'
  | 'curte_militara_apel';

export const JUDICIAL_COURT_LEVELS: readonly JudicialCourtLevel[] = [
  'judecatorie',
  'tribunal',
  'tribunal_militar',
  'curte_de_apel',
  'curte_militara_apel',
];

/** `justice.case_parties.party_kind` (DB CHECK). */
export type JudicialPartyKind = 'company' | 'public_entity' | 'person' | 'unknown';

/** `justice.courts.mapping_confidence` (DB CHECK). */
export type JudicialMappingConfidence = 'high' | 'medium' | 'low';

// ── Court ──────────────────────────────────────────────────────────────────────

export interface JudicialCourt {
  readonly institutionCode: string; // courts.institution_code (PK)
  readonly ordinal: number;
  readonly courtLevel: JudicialCourtLevel;
  readonly specialization: string | null;
  readonly locality: string | null;
  readonly countySirutaCode: string | null; // courts.county_code → core.territories (soft)
  readonly parentInstitutionCode: string | null;
  readonly mappingConfidence: JudicialMappingConfidence;
  // courts.evidence (jsonb), mapping_notes: NOT projected.
}

/** A court with its direct children (the court-tree usecase). */
export interface JudicialCourtTree {
  readonly court: JudicialCourt;
  readonly children: readonly JudicialCourt[];
}

// ── Case (current projection) ──────────────────────────────────────────────────

export interface JudicialCase {
  readonly caseId: string; // bigint → string
  readonly sourceSlug: string; // 'portal_just'
  readonly institutionCode: string;
  readonly caseNumber: string;
  readonly caseNumberOld: string | null;
  readonly department: string | null;
  readonly category: string | null; // raw passthrough (no taxonomy in v1)
  readonly categoryName: string | null;
  readonly stage: string | null;
  readonly stageName: string | null;
  readonly object: string | null; // raw object text — safe (procedural subject, not parties)
  readonly sourceOpenedAt: string | null; // date (YYYY-MM-DD)
  readonly latestSourceModifiedAt: string | null; // ISO timestamp
}

// ── Hearing — solution_summary AND solution STRUCTURALLY ABSENT in v1 ──────────

export interface JudicialHearing {
  readonly caseId: string;
  readonly hearingIndex: number;
  readonly hearingAt: string | null; // ISO
  readonly panel: string | null;
  // NO `solutionSummary` field (forbidden permanently). NO `solution` field in v1
  // (withheld until a person-shape audit passes — §2.1). The type carries neither.
  readonly pronouncementDate: string | null; // date
  readonly documentNumber: string | null;
  readonly documentDate: string | null; // date
}

// ── Appeal ──────────────────────────────────────────────────────────────────────

export interface JudicialAppeal {
  readonly caseId: string;
  readonly appealIndex: number;
  readonly appealDeclaredAt: string | null; // date
  readonly appealType: string | null;
}

// ── Party (current projection) — NO NAME FIELD ────────────────────────────────

export interface JudicialParty {
  readonly caseId: string;
  readonly partyIndex: number;
  readonly partyKind: JudicialPartyKind;
  readonly roleNormalized: string | null; // controlled vocab; role_raw is NOT in prod
  readonly nameKeyId: string | null; // bigint → string; NULL for ~67% (person/unknown/low-conf)
  /**
   * Whether THIS party row is itself publishable: `party_kind ∈ {company,
   * public_entity}` AND `classifier_rule ∈ PUBLISHABLE_RULES` AND a recognized
   * `classifier_version` — computed in the repo from the row's own columns. The
   * name merge requires BOTH this per-row flag AND the dictionary gate (which
   * proves the name-key is a company/public name), so a person party that merely
   * shares a name-key with a company elsewhere NEVER inherits that name (§3.1).
   */
  readonly publishable: boolean;
  // NO displayName, NO name, NO role_raw. classifier_rule/version: internal only.
}

/**
 * The ONLY name-bearing value object — produced solely by
 * `PartyDictionaryRepo.getPublishableName`, never by a party SELECT. Because the
 * dictionary table holds only company/public names (DB CHECK + publishable-rule
 * gate), `displayName` can never be a natural person's name.
 */
export interface PublishableName {
  readonly nameKeyId: string;
  readonly displayName: string; // company/public ONLY (dictionary CHECK)
  readonly partyKind: 'company' | 'public_entity';
  readonly legalForm: string | null;
}

/**
 * A rendered party for the case-detail view. The privacy-critical merge (§3.2)
 * produces this in the USECASE layer: `name` is non-null ONLY for parties whose
 * `nameKeyId` resolved to a publishable company/public name; for person/unknown/
 * low-confidence parties `name` is `null` (the client shows "2 persoane fizice").
 */
export interface JudicialPartyView {
  readonly partyIndex: number;
  readonly partyKind: JudicialPartyKind;
  readonly roleNormalized: string | null;
  readonly nameKeyId: string | null;
  /** Publishable company/public name; ALWAYS null for person/unknown kinds. */
  readonly name: string | null;
  readonly legalForm: string | null;
}

/** The case-detail composite (case + children + name-gated parties). */
export interface JudicialCaseDetail {
  readonly case: JudicialCase;
  readonly hearings: readonly JudicialHearing[];
  readonly appeals: readonly JudicialAppeal[];
  readonly parties: readonly JudicialPartyView[];
  /** Count of person/unknown parties rendered name-free (anonymized aggregate). */
  readonly personPartyCount: number;
  readonly legalReferences: readonly JudicialLegalRef[];
  readonly lineage: readonly JudicialLineageEdge[];
  /** Domain freshness watermark (§10). */
  readonly asOf: JudicialAsOf;
}

// ── Legal references (safe; empty until gate #11) ─────────────────────────────

export interface JudicialLegalRef {
  readonly caseLegalReferenceId: string;
  readonly caseId: string;
  readonly actType: string | null;
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly articleFragment: string | null;
  readonly targetActId: string | null; // → legal.acts via the kernel legalActLoader
  readonly resolutionStatus: string | null;
  readonly confidenceScore: string | null;
  /**
   * The normalized citation token (rebuilt from act_type/number/year) — NEVER the
   * raw source span (S2). Rows whose `source_field='solution_summary'` are excluded
   * from the served projection entirely.
   */
  readonly citation: string;
}

export interface JudicialCaseCitation {
  readonly caseId: string;
  readonly institutionCode: string;
  readonly caseNumber: string;
  readonly actType: string | null;
  readonly actNumber: string | null;
  readonly actYear: number | null;
}

// ── Lineage candidates (candidate-only; empty until gate #10) ──────────────────

export interface JudicialLineageEdge {
  readonly lineageCandidateId: string;
  readonly fromCaseId: string;
  readonly toCaseId: string;
  readonly lineageType: string;
  readonly method: string | null;
  readonly confidenceScore: string | null;
  readonly validationStatus: string;
}

// ── Company litigation (GATED; published-only; empty in v1) ────────────────────

export interface JudicialCompanyLitigation {
  readonly cui: string;
  readonly companyName: string | null; // publishable, from the gate; null when none published
  readonly caseCount: number;
  readonly courtLevels: readonly { readonly courtLevel: JudicialCourtLevel; readonly count: number }[];
  readonly years: readonly { readonly year: number; readonly count: number }[];
  /** company-name → CUI match rate disclosed (catalog Coverage/Entity-Resolution Gate). */
  readonly coverage: number;
  readonly caveats: readonly string[];
}

export interface JudicialCaseLink {
  readonly caseId: string;
  readonly institutionCode: string;
  readonly caseNumber: string;
  readonly category: string | null;
  readonly sourceOpenedAt: string | null;
}

// ── Court analytics (JD-2) ─────────────────────────────────────────────────────

export type JudicialAggregateGroupBy = 'court' | 'category' | 'year' | 'courtLevel';

export interface JudicialAggregateGroup {
  readonly key: string;
  readonly label: string | null;
  readonly caseCount: number;
}

export interface JudicialCaseAggregate {
  readonly groups: readonly JudicialAggregateGroup[];
  readonly denominator: number;
  /** Share of the bounded result set the groups cover (1.0 unless an unmapped bucket exists). */
  readonly coverage: number;
}

// ── Resolve / discovery (the §7.4 dimensions) ─────────────────────────────────

export type JudicialResolveDim = 'court' | 'courtLevel' | 'companyName' | 'category';

// ── As-of metadata (§10) ───────────────────────────────────────────────────────

export interface JudicialAsOf {
  readonly asOf: string | null; // ISO timestamp; max(cases.last_seen_at) interim
  readonly estimated: boolean;
}

// ── Sort keys ──────────────────────────────────────────────────────────────────

/** `justice.cases` list sort keys. `modifiedAt` is the default (recency feed). */
export type JudicialCaseSort = 'modifiedAt' | 'openedAt';
