/**
 * Judicial module — domain view models (plan 08 §2.2). **PRIVACY-CRITICAL.**
 *
 * The row types here are the contract the three surfaces (GraphQL, MCP, REST)
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
 *  - `iccj_archive_case_date`: the stored date projected from the ICCJ archive
 *    case's `case_date_text` field (`source_slug = 'iccj'`). Its exact event
 *    meaning and chronological selection are not established; it does not
 *    establish the earliest session, first appearance, filing/registration or
 *    capture freshness;
 *  - `unknown`: any other source; the value is preserved without a meaning.
 * The basis describes the source lane even when the date itself is null.
 */
export const JUDICIAL_SOURCE_OPENED_AT_BASES = [
  'portal_header_data',
  'iccj_archive_case_date',
  'unknown',
] as const;

export type JudicialSourceOpenedAtBasis = (typeof JUDICIAL_SOURCE_OPENED_AT_BASES)[number];

/** The basis from the case's stored `source_slug` (never an id, court or number heuristic). */
export const sourceOpenedAtBasisFor = (sourceSlug: string): JudicialSourceOpenedAtBasis => {
  if (sourceSlug === 'portal_just') return 'portal_header_data';
  if (sourceSlug === 'iccj') return 'iccj_archive_case_date';
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
  /** Null for an unresolved candidate (`to_case_id` is nullable in the DDL). */
  readonly toCaseId: string | null;
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

/** The four caseload aggregate dimensions (A3: validated before any repo access). */
export const JUDICIAL_AGGREGATE_GROUP_BYS = ['court', 'category', 'year', 'courtLevel'] as const;

export type JudicialAggregateGroupBy = (typeof JUDICIAL_AGGREGATE_GROUP_BYS)[number];

export const isJudicialAggregateGroupBy = (value: unknown): value is JudicialAggregateGroupBy =>
  typeof value === 'string' && (JUDICIAL_AGGREGATE_GROUP_BYS as readonly string[]).includes(value);

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

/**
 * The ONE copy of the discovery dimensions (A3): the TypeScript union, the MCP
 * Zod enum and the usecase validation all derive from it. GraphQL keeps
 * `dim: String!` for compatibility; the usecase validates it before dispatch.
 */
export const JUDICIAL_RESOLVE_DIMS = ['court', 'courtLevel', 'companyName', 'category'] as const;

export type JudicialResolveDim = (typeof JUDICIAL_RESOLVE_DIMS)[number];

export const isJudicialResolveDim = (value: unknown): value is JudicialResolveDim =>
  typeof value === 'string' && (JUDICIAL_RESOLVE_DIMS as readonly string[]).includes(value);

/** Discovery limit: omitted or null means the default; otherwise an integer 1..50. */
export const JUDICIAL_RESOLVE_LIMIT_DEFAULT = 10;
export const JUDICIAL_RESOLVE_LIMIT_MAX = 50;

// ── Input contracts shared by core and shell (A3) ──────────────────────────────

/**
 * A year operand: an ORIGINAL integer number in GraphQL Int's signed 32-bit
 * range, never zero (there is no year 0; 1 BC is -1). Strings, booleans,
 * fractions and non-finite numbers are not years. One rule for GraphQL, MCP and
 * direct callers.
 */
export const JUDICIAL_YEAR_OPERAND_MIN = -2_147_483_648;
export const JUDICIAL_YEAR_OPERAND_MAX = 2_147_483_647;

export const isJudicialYearOperand = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= JUDICIAL_YEAR_OPERAND_MIN &&
  value <= JUDICIAL_YEAR_OPERAND_MAX &&
  value !== 0;

const INT8_MAX = 2n ** 63n - 1n;
/** int8 max has 19 significant digits; longer spellings cannot be in range. */
const INT8_MAX_DIGITS = 19;

/**
 * A DIRECT external ID argument (case lookup, legal references by case, reverse
 * references by act): a decimal digit string, including zero and leading-zero
 * spellings, whose value is at most 9223372036854775807. Checked with BigInt on
 * the text, never Number. Negative, signed, whitespace, fractional or overflowing
 * spellings are invalid (a caller mistake, not a database error).
 */
export const isJudicialDirectId = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) return false;
  const significant = value.replace(/^0+(?=[0-9])/u, '');
  return significant.length <= INT8_MAX_DIGITS && BigInt(significant) <= INT8_MAX;
};

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

// ── Stored decisions (API-04) ──────────────────────────────────────────────────
//
// SCOPED TASK OVERRIDE (human instruction, 2026-10-04): the three decision
// tables (`justice.issuing_bodies`, `justice.decisions`,
// `justice.decision_subject_links`) are served AS STORED — both stored decision
// privacy classes and the link evidence included — while dedicated privacy
// work is deferred. Statuses are recorded labels: nothing here verifies a
// subject identity or promotes a link. The override does NOT change the case,
// party, hearing, company, case-lineage, citation, search or contributor policy.

/** `justice.decisions.privacy_class` (DB CHECK `decisions_privacy_class_check`). */
export const JUDICIAL_DECISION_PRIVACY_CLASSES = ['public', 'restricted'] as const;

export type JudicialDecisionPrivacyClass = (typeof JUDICIAL_DECISION_PRIVACY_CLASSES)[number];

/** `justice.issuing_bodies.kind` (DB CHECK `issuing_bodies_kind_check`). */
export const JUDICIAL_ISSUING_BODY_KINDS = [
  'court',
  'administrative_tribunal',
  'international_court',
] as const;

export type JudicialIssuingBodyKind = (typeof JUDICIAL_ISSUING_BODY_KINDS)[number];

/** `justice.decision_subject_links.subject_kind` (DB CHECK `decision_subject_links_kind_check`). */
export const JUDICIAL_DECISION_SUBJECT_KINDS = [
  'company',
  'public_entity',
  'contract',
  'ecris_case',
  'notice',
] as const;

export type JudicialDecisionSubjectKind = (typeof JUDICIAL_DECISION_SUBJECT_KINDS)[number];

/**
 * `justice.decision_subject_links.validation_status` (DB CHECK
 * `decision_subject_links_status_check`): recorded status LABELS, never an
 * API verification or a publication.
 */
export const JUDICIAL_DECISION_LINK_STATUSES = [
  'candidate',
  'needs_review',
  'accepted',
  'rejected',
] as const;

export type JudicialDecisionLinkStatus = (typeof JUDICIAL_DECISION_LINK_STATUSES)[number];

/** One stored issuing body (the extensible FK reference table; keys are table data). */
export interface JudicialIssuingBody {
  readonly issuingBody: string;
  readonly label: string;
  readonly kind: JudicialIssuingBodyKind;
  readonly notes: string | null;
  /** Row-operation timestamp, exact UTC text with era (see `JudicialDecision.createdAt`). */
  readonly createdAt: string;
}

/**
 * One stored decision row, every value as stored. `decisionId` is the exact
 * int8 text. `decisionYear` is the independent nullable smallint (it can be
 * 0, negative, or differ from `decisionDate`'s year). `decisionDate` is the
 * native date display (`YYYY-MM-DD` for AD 1–9999, else explicit era text or
 * ±infinity). `attrs` is the stored JSON value (an object, array, scalar or
 * JSON null). `createdAt`/`updatedAt` are row-operation timestamps in exact UTC
 * text (`YYYY-MM-DDTHH:MM:SS.ffffff+00 AD`, or ±infinity) — not event time or
 * capture freshness.
 */
export interface JudicialDecision {
  readonly decisionId: string;
  readonly issuingBody: string;
  readonly sourceSystem: string;
  readonly sourceRef: string;
  readonly decisionNo: string | null;
  readonly decisionYear: number | null;
  readonly decisionDate: string | null;
  readonly decisionKind: string | null;
  readonly outcomeNormalized: string | null;
  readonly ecli: string | null;
  readonly applicationNo: string | null;
  readonly attrs: unknown;
  readonly privacyClass: JudicialDecisionPrivacyClass;
  readonly sourceUrl: string | null;
  readonly sourceObjectKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One stored decision → subject link, at LINK grain (identity
 * `(decision_id, subject_kind, subject_ref)`). `subjectRef` is exact stored
 * text with no cross-domain join or normalization; `confidenceScore` is the
 * exact numeric(4,3) text; `validationStatus` is a recorded label.
 */
export interface JudicialDecisionSubjectLink {
  readonly linkId: string;
  readonly decisionId: string;
  readonly subjectKind: JudicialDecisionSubjectKind;
  readonly subjectRef: string;
  readonly role: string | null;
  readonly method: string | null;
  readonly confidenceScore: string | null;
  readonly validationStatus: JudicialDecisionLinkStatus;
  /** The stored JSON value, served as stored under the scoped override above. */
  readonly evidence: unknown;
  readonly resolverVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A NEW native int8 ID argument (decision and link IDs): the canonical signed
 * decimal spelling (`0`, `-5`, `9223372036854775807`; no `+`, no leading
 * zeros, no `-0`), inside the full PostgreSQL bigint range, checked with
 * BigInt on the text — never Number. The ONE predicate for new decision/link
 * direct IDs, filter operands and cursor keys. Existing case/act ID inputs keep
 * `isJudicialDirectId`.
 */
const SIGNED_INT8_TEXT_RE = /^(?:0|-?[1-9][0-9]{0,18})$/u;
const INT8_MIN = -(2n ** 63n);

export const isJudicialSignedId = (value: unknown): value is string => {
  if (typeof value !== 'string' || !SIGNED_INT8_TEXT_RE.test(value)) return false;
  const n = BigInt(value);
  return n >= INT8_MIN && n <= INT8_MAX;
};

/**
 * A decision-year operand: an ORIGINAL integer number in GraphQL Int's signed
 * 32-bit range, INCLUDING zero (the stored `decision_year` is an unconstrained
 * smallint; the derived case-year rule does not apply). Operands outside the
 * smallint range are valid and simply bound an empty or open native interval.
 */
export const isJudicialDecisionYearOperand = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= JUDICIAL_YEAR_OPERAND_MIN &&
  value <= JUDICIAL_YEAR_OPERAND_MAX;

/** New decision/link pages: an original integer 1..50; omitted or null means 20. */
export const JUDICIAL_DECISION_PAGE_DEFAULT = 20;
export const JUDICIAL_DECISION_PAGE_MAX = 50;

export const isJudicialDecisionPageSize = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= JUDICIAL_DECISION_PAGE_MAX;

/**
 * The decision discovery dimensions (separate from the four case dimensions,
 * which stay exactly four): stored issuing bodies, distinct stored source
 * systems, the five subject kinds and the four recorded status labels.
 */
export const JUDICIAL_DECISION_RESOLVE_DIMS = [
  'issuingBody',
  'sourceSystem',
  'subjectKind',
  'validationStatus',
] as const;

export type JudicialDecisionResolveDim = (typeof JUDICIAL_DECISION_RESOLVE_DIMS)[number];

export const isJudicialDecisionResolveDim = (value: unknown): value is JudicialDecisionResolveDim =>
  typeof value === 'string' &&
  (JUDICIAL_DECISION_RESOLVE_DIMS as readonly string[]).includes(value);

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
