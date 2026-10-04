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
 * are `YYYY-MM-DD`; timestamps ISO strings. The case/as-of timestamps are rendered
 * in SQL (never via a JS Date) and keep explicit text for exceptional stored
 * values — see `JudicialCase`.
 */

// ── enums ──────────────────────────────────────────────────────────────────────

/**
 * `justice.courts.court_level` (DB CHECK `courts_level_check`; scrapper prod
 * migrations 20260614T120000__justice_domain + 20260629T131000__justice_iccj_court,
 * which adds the ICCJ row at ordinal 0). The ONE server copy of this taxonomy: the
 * SDL enum, the filter specs, the MCP inputs and discovery all derive from it.
 * Append-only; keep it in step with the DB CHECK.
 */
export const JUDICIAL_COURT_LEVELS = [
  'judecatorie',
  'tribunal',
  'tribunal_militar',
  'curte_de_apel',
  'curte_militara_apel',
  'inalta_curte',
] as const;

export type JudicialCourtLevel = (typeof JUDICIAL_COURT_LEVELS)[number];

/** `justice.case_parties.party_kind` (DB CHECK). */
export type JudicialPartyKind = 'company' | 'public_entity' | 'person' | 'unknown';

/** `justice.courts.mapping_confidence` (DB CHECK). */
export type JudicialMappingConfidence = 'high' | 'medium' | 'low';

/**
 * What `JudicialCase.sourceOpenedAt` means, by the case's actual `source_slug`
 * (A2). The value is a source clock, not a universal filing or first-ever date:
 *  - `portal_header_data`: the Portal Just case header's `data` field, copied by
 *    the raw parser and writer (`source_slug = 'portal_just'`);
 *  - `iccj_earliest_captured_session`: the earliest captured ICCJ session for
 *    that case number in the ICCJ archive lane (`source_slug = 'iccj'`) — not a
 *    proven registration or first appearance;
 *  - `unknown`: any other source; the value is preserved without a meaning.
 * The basis describes the source lane even when the date itself is null.
 */
export const JUDICIAL_SOURCE_OPENED_AT_BASES = [
  'portal_header_data',
  'iccj_earliest_captured_session',
  'unknown',
] as const;

export type JudicialSourceOpenedAtBasis = (typeof JUDICIAL_SOURCE_OPENED_AT_BASES)[number];

/** The basis from the case's stored `source_slug` (never an id, court or number heuristic). */
export const sourceOpenedAtBasisFor = (sourceSlug: string): JudicialSourceOpenedAtBasis => {
  if (sourceSlug === 'portal_just') return 'portal_header_data';
  if (sourceSlug === 'iccj') return 'iccj_earliest_captured_session';
  return 'unknown';
};

// ── Court ──────────────────────────────────────────────────────────────────────

export interface JudicialCourt {
  readonly institutionCode: string; // courts.institution_code (PK)
  readonly ordinal: number;
  readonly courtLevel: JudicialCourtLevel;
  readonly specialization: string | null;
  readonly locality: string | null;
  /** The county ABBREVIATION exactly as stored (`courts.county_code`, e.g. `B`, `TM`); not a SIRUTA code. */
  readonly countyCode: string | null;
  /**
   * @deprecated Misnamed compatibility alias: the SAME county abbreviation as
   * `countyCode` (`courts.county_code`), NOT a SIRUTA identifier. No SIRUTA
   * mapping is qualified; use `countyCode`.
   */
  readonly countySirutaCode: string | null;
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
  /**
   * The source-dependent case date (see `sourceOpenedAtBasis`), displayed in
   * the session timezone: `YYYY-MM-DD` for AD years 1–9999; otherwise explicit
   * PostgreSQL text (`0001-12-31 BC`, `10000-01-01 AD`, `infinity`,
   * `-infinity`). Never a pagination key.
   */
  readonly sourceOpenedAt: string | null;
  /** What `sourceOpenedAt` means for this case's source (from its `source_slug`). */
  readonly sourceOpenedAtBasis: JudicialSourceOpenedAtBasis;
  /**
   * UTC display timestamp: `YYYY-MM-DDTHH:mm:ss.SSSZ` (millisecond display) for AD
   * years 1–9999; otherwise the exact UTC text with era
   * (`10000-01-01T00:00:00.000000+00 AD`) or `infinity`/`-infinity`. Never a
   * pagination key: cursors carry the full-precision value.
   */
  readonly latestSourceModifiedAt: string | null;
}

// ── Hearing — solution_summary AND solution STRUCTURALLY ABSENT in v1 ──────────

export interface JudicialHearing {
  readonly caseId: string;
  readonly hearingIndex: number;
  /** UTC display, like `JudicialCase.latestSourceModifiedAt` (explicit text when exceptional). */
  readonly hearingAt: string | null;
  readonly panel: string | null;
  // NO `solutionSummary` field (forbidden permanently). NO `solution` field in v1
  // (withheld until a person-shape audit passes — §2.1). The type carries neither.
  /** Native-date display: `YYYY-MM-DD` for AD 1–9999, else explicit era text (`0001-12-31 BC`, `5874897-12-31 AD`) or ±infinity. */
  readonly pronouncementDate: string | null;
  readonly documentNumber: string | null;
  /** Native-date display, as `pronouncementDate`. */
  readonly documentDate: string | null;
}

// ── Appeal ──────────────────────────────────────────────────────────────────────

export interface JudicialAppeal {
  readonly caseId: string;
  readonly appealIndex: number;
  /** Native-date display, as `JudicialHearing.pronouncementDate`. */
  readonly appealDeclaredAt: string | null;
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
 * produces this in the USECASE layer: `name` stays null until the judicial
 * permission layer exists. For person/unknown/low-confidence parties,
 * `nameKeyId` is also null so stable internal identifiers cannot be used to
 * correlate a withheld identity across cases.
 */
export interface JudicialPartyView {
  readonly partyIndex: number;
  readonly partyKind: JudicialPartyKind;
  readonly roleNormalized: string | null;
  /** Public company/entity key only; null whenever the party identity is withheld. */
  readonly nameKeyId: string | null;
  /** Intentionally withheld until the judicial permission layer exists. */
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
  /** The case source's stored source-modified maximum (§10); not dataset freshness. */
  readonly asOf: JudicialAsOf;
}

// ── Legal references (safe; empty until gate #11) ─────────────────────────────

export interface JudicialLegalRef {
  readonly caseLegalReferenceId: string;
  readonly caseId: string;
  /** Where the token was extracted: `object` (case grain) or a hearing field. */
  readonly sourceField: string;
  /** The source hearing for a hearing-field citation; null for case-grain (`object`). */
  readonly hearingIndex: number | null;
  readonly actType: string | null;
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly articleFragment: string | null;
  readonly targetActId: string | null; // → legal.acts via the kernel legalActLoader
  readonly resolutionStatus: string | null;
  readonly confidenceScore: string | null;
  /**
   * The exact stored extracted citation token (`raw_text`), unmodified — not the
   * surrounding source sentence and not rebuilt from the act fields (which stay
   * null for an unresolved token). Rows whose `source_field='solution_summary'`
   * are excluded from the served projection entirely (S2).
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
  readonly courtLevels: readonly {
    readonly courtLevel: JudicialCourtLevel;
    readonly count: number;
  }[];
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

/**
 * The as-of metadata of a case detail (A2): scoped to the case's SOURCE, never
 * the global maximum across Justice sources, and never the individual case.
 */
export interface JudicialAsOf {
  /**
   * `max(cases.latest_source_modified_at)` over the cases of `sourceSlug` only,
   * rendered like `latestSourceModifiedAt` (explicit text for an exceptional
   * maximum). Null when that source stores no modification time (e.g. ICCJ).
   * A stored source-modified maximum — not capture completeness, head
   * observation or load time.
   */
  readonly asOf: string | null;
  /** Always true (compatibility): `asOf` is an estimate, not a freshness guarantee. */
  readonly estimated: boolean;
  /** The source whose stored maximum `asOf` reports (the case's `source_slug`). */
  readonly sourceSlug: string;
  readonly basis: 'max_stored_source_modified_at';
  /** Not established in A2: always null. */
  readonly captureFreshnessAt: string | null;
  /** Not established in A2: always null. */
  readonly loadFreshnessAt: string | null;
}

// ── Sort keys ──────────────────────────────────────────────────────────────────

/** `justice.cases` list sort keys. `modifiedAt` is the default (recency feed). */
export type JudicialCaseSort = 'modifiedAt' | 'openedAt';

// ── Cursor pages ───────────────────────────────────────────────────────────────

/**
 * One cursor-page item: the node plus the opaque cursor the REPO built from the
 * row's exact database sort tuple. The wrapper exists only on the two cursor
 * lists; nodes (and case detail / MCP payloads) never carry cursor metadata.
 */
export interface JudicialCursorItem<T> {
  readonly node: T;
  readonly cursor: string;
}
