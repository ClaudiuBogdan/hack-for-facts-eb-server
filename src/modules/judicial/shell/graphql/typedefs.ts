/**
 * Judicial module — GraphQL SDL slice (plan 08 §3.3). All types `Judicial*`-prefixed
 * (§14.8). **NAME-FREE BY CONSTRUCTION**, the centerpiece:
 *
 *  - `JudicialParty` / `JudicialPartyView` have NO `displayName` field. The only
 *    name field is `JudicialPartyView.name`, intentionally withheld until the
 *    judicial permission layer exists.
 *  - `JudicialHearing` has NO `solutionSummary` field and NO `solution` field.
 *
 * The schema-merge conflict gate (§14.8) + the leak audit guarantee no extension
 * re-adds them. Filter inputs are GENERATED from the §7 specs via the kernel
 * `toGraphQLInput(spec)` so the surfaces never drift. `targetAct` on a legal-ref
 * resolves to the kernel `LegalAct` via the shared `legalActLoader` (tolerates
 * dangling → null); the `LegalAct` type itself is owned by the legal module (05).
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { JUDICIAL_COURT_LEVELS, JUDICIAL_SOURCE_OPENED_AT_BASES } from '../../core/types.js';
import { judicialCasesSpec, judicialCourtsSpec } from '../filters/judicial.spec.js';

const filterInputs = `${toGraphQLInput(judicialCasesSpec)}\n\n${toGraphQLInput(judicialCourtsSpec)}`;

/** Rendered from the one court-level taxonomy so the SDL cannot drift from it. */
const courtLevelEnum = `enum JudicialCourtLevel {\n${JUDICIAL_COURT_LEVELS.map((l) => `  ${l}`).join('\n')}\n}`;

/** Rendered from the one date-basis list (A2) so the SDL cannot drift from it. */
const openedAtBasisEnum = `"What JudicialCase.sourceOpenedAt means for the source of the case: portal_header_data (the Portal Just case header data field), iccj_archive_case_date (the stored date projected from the ICCJ archive case_date_text field; its exact event meaning and chronological selection are not established - it does not establish the earliest session, first appearance, filing/registration or capture freshness), unknown (another source; the value is kept without a meaning)."\nenum JudicialSourceOpenedAtBasis {\n${JUDICIAL_SOURCE_OPENED_AT_BASES.map((b) => `  ${b}`).join('\n')}\n}`;

const objectsAndQuery = /* GraphQL */ `
  ${courtLevelEnum}
  ${openedAtBasisEnum}
  "How JudicialAsOf.asOf is derived. max_stored_source_modified_at: the maximum stored latestSourceModifiedAt among the cases of one source."
  enum JudicialAsOfBasis {
    max_stored_source_modified_at
  }
  enum JudicialPartyKind {
    company
    public_entity
    person
    unknown
  }
  enum JudicialMappingConfidence {
    high
    medium
    low
  }
  enum JudicialCaseSort {
    modifiedAt
    openedAt
  }
  enum JudicialSortDir {
    ASC
    DESC
  }
  enum JudicialAggregateGroupBy {
    court
    category
    year
    courtLevel
  }

  "A court in the justice reference hierarchy: the Portal Just courts plus the ICCJ (inalta_curte)."
  type JudicialCourt {
    institutionCode: String!
    ordinal: Int!
    courtLevel: JudicialCourtLevel!
    specialization: String
    locality: String
    "County abbreviation exactly as stored on the court (courts.county_code, e.g. B, TM); not a SIRUTA code."
    countyCode: String
    "Misnamed compatibility alias: the same county abbreviation as countyCode, NOT a SIRUTA identifier."
    countySirutaCode: String
      @deprecated(
        reason: "Misnamed: carries the county abbreviation (same value as countyCode), not a SIRUTA code. Use countyCode."
      )
    parentInstitutionCode: String
    mappingConfidence: JudicialMappingConfidence!
    children: [JudicialCourt!]!
  }

  "A case (current latest-known projection; not procedural history)."
  type JudicialCase {
    caseId: BigInt!
    sourceSlug: String!
    institutionCode: String!
    caseNumber: String!
    caseNumberOld: String
    department: String
    category: String
    categoryName: String
    stage: String
    stageName: String
    "Raw procedural object text — SAFE (the subject of the case, never party names)."
    object: String
    "Source-dependent case date (see sourceOpenedAtBasis: the Portal Just header data field, or the ICCJ archive case-date field) - not a verified filing, registration or first-ever date. Displayed in the server session timezone (YYYY-MM-DD). Exceptional stored values are explicit: an era suffix outside AD 1-9999 (0001-12-31 BC, 10000-01-01 AD) or infinity/-infinity. Display only; pagination uses the exact timestamp."
    sourceOpenedAt: Date
    "What sourceOpenedAt means for the source of this case (from its sourceSlug); present even when sourceOpenedAt is null."
    sourceOpenedAtBasis: JudicialSourceOpenedAtBasis!
    "Latest source modification, UTC with millisecond display (YYYY-MM-DDTHH:mm:ss.SSSZ). Exceptional stored values are explicit: exact UTC text with era outside AD 1-9999 (10000-01-01T00:00:00.000000+00 AD) or infinity/-infinity. Display only; pagination uses the full-precision timestamp."
    latestSourceModifiedAt: DateTime
  }

  "A hearing. solution_summary AND solution are STRUCTURALLY ABSENT in v1 (privacy — §2.1)."
  type JudicialHearing {
    caseId: BigInt!
    hearingIndex: Int!
    "UTC with millisecond display (YYYY-MM-DDTHH:mm:ss.SSSZ); exact UTC text with era outside AD 1-9999, or infinity/-infinity."
    hearingAt: DateTime
    panel: String
    "YYYY-MM-DD; outside AD 1-9999 the full year with an era (0001-12-31 BC, 5874897-12-31 AD), or infinity/-infinity."
    pronouncementDate: Date
    documentNumber: String
    "YYYY-MM-DD; outside AD 1-9999 the full year with an era, or infinity/-infinity."
    documentDate: Date
    # NO solutionSummary (forbidden permanently). NO solution (withheld in v1).
  }

  type JudicialAppeal {
    caseId: BigInt!
    appealIndex: Int!
    "YYYY-MM-DD; outside AD 1-9999 the full year with an era, or infinity/-infinity."
    appealDeclaredAt: Date
    appealType: String
  }

  "A party rendered for case detail. name is withheld; nameKeyId may identify a publishable company/public party."
  type JudicialPartyView {
    partyIndex: Int!
    partyKind: JudicialPartyKind!
    roleNormalized: String
    "Public company/entity key; null for person, unknown, or otherwise non-publishable parties."
    nameKeyId: BigInt
    "Intentionally null until the judicial permission layer exists."
    name: String
    legalForm: String
  }

  "A legal-act citation extracted from a case. citation is the exact stored extracted token, not the surrounding source text; identity and resolution fields are returned as stored, including nulls."
  type JudicialLegalRef {
    caseLegalReferenceId: BigInt!
    caseId: BigInt!
    "Where the token was extracted: object (case grain) or a hearing field."
    sourceField: String!
    "The source hearing of a hearing-field citation; null for object citations."
    hearingIndex: Int
    actType: String
    actNumber: String
    actYear: Int
    issuerSlug: String
    articleFragment: String
    targetActId: BigInt
    resolutionStatus: String
    confidenceScore: String
    "The exact stored extracted citation token, unmodified."
    citation: String!
    "Resolved domestic act through the kernel legal-act loader; null when no target is stored, the loader is unavailable, or the target is dangling."
    targetAct: LegalAct
  }

  "A candidate case-lineage edge (candidate, not fact). Empty in v1 (gate #10)."
  type JudicialLineageEdge {
    lineageCandidateId: BigInt!
    fromCaseId: BigInt!
    toCaseId: BigInt!
    lineageType: String!
    method: String
    confidenceScore: String
    validationStatus: String!
  }

  "Source-scoped as-of metadata of a case detail (§10). It reports a stored source-modified maximum for the source of the case only - not dataset freshness, capture completeness, head observation or load time."
  type JudicialAsOf {
    "The maximum stored latestSourceModifiedAt among the cases of sourceSlug only (never that of another source), rendered like that field (including explicit exceptional text); null when that source stores no modification time (e.g. ICCJ)."
    asOf: DateTime
    "Always true: asOf is an estimate, not a freshness guarantee."
    estimated: Boolean!
    "The source whose stored maximum asOf reports: the sourceSlug of the case."
    sourceSlug: String!
    basis: JudicialAsOfBasis!
    "Not established: always null."
    captureFreshnessAt: DateTime
    "Not established: always null."
    loadFreshnessAt: DateTime
  }

  "The case-detail composite. parties are name-gated; person/unknown contribute only to personPartyCount."
  type JudicialCaseDetail {
    case: JudicialCase!
    hearings: [JudicialHearing!]!
    appeals: [JudicialAppeal!]!
    parties: [JudicialPartyView!]!
    "Count of person/unknown parties rendered name-free (anonymized aggregate)."
    personPartyCount: Int!
    legalReferences: [JudicialLegalRef!]!
    lineage: [JudicialLineageEdge!]!
    "Stored source-modified maximum of the source of this case (not dataset freshness)."
    asOf: JudicialAsOf!
  }

  type JudicialCaseEdge {
    node: JudicialCase!
    cursor: String!
  }
  type JudicialCaseConnection {
    edges: [JudicialCaseEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }

  "One caseload group. For groupBy year the key is the session calendar year as text, (none) for a null date, or infinity / -infinity for an infinite stored date; every row counts in the denominator."
  type JudicialAggregateGroup {
    key: String!
    label: String
    caseCount: Int!
  }
  "Court caseload aggregate (JD-2). coverage discloses the share of the bounded set the groups cover."
  type JudicialCaseAggregate {
    groups: [JudicialAggregateGroup!]!
    denominator: Int!
    coverage: Float!
  }

  type JudicialCourtLevelCount {
    courtLevel: JudicialCourtLevel!
    count: Int!
  }
  "A year bucket: the session calendar year of the source-dependent sourceOpenedAt (mixed sources combine different clocks)."
  type JudicialYearCount {
    year: Int!
    count: Int!
  }
  "Company-litigation summary (JD-1). published-only ⇒ empty in v1 (caseCount 0, coverage 0). years lists finite session calendar years only; cases with a null or infinite date still count in caseCount and courtLevels, and a caveat discloses their omission from years."
  type JudicialCompanyLitigation {
    cui: String!
    companyName: String
    caseCount: Int!
    courtLevels: [JudicialCourtLevelCount!]!
    years: [JudicialYearCount!]!
    coverage: Float!
    caveats: [String!]!
  }

  type JudicialCaseLink {
    caseId: BigInt!
    institutionCode: String!
    caseNumber: String!
    category: String
    "The source-dependent date of the linked case as stored (Portal Just header data or the ICCJ archive case-date field) - not a universal opening or filing date."
    sourceOpenedAt: Date
  }
  type JudicialCaseLinkEdge {
    node: JudicialCaseLink!
    cursor: String!
  }
  type JudicialCaseLinkConnection {
    edges: [JudicialCaseLinkEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }

  type JudicialCaseCitation {
    caseId: BigInt!
    institutionCode: String!
    caseNumber: String!
    actType: String
    actNumber: String
    actYear: Int
  }
  type JudicialCaseCitationEdge {
    node: JudicialCaseCitation!
    cursor: String!
  }
  type JudicialCaseCitationConnection {
    edges: [JudicialCaseCitationEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }

  "A name→value discovery hit (kernel ResolveHit shape, module-local SDL projection). companyName resolves company/public dictionary ONLY (a person name returns zero rows)."
  type JudicialResolveHit {
    kind: String!
    value: String!
    label: String!
    score: Float
    hint: String
  }

  extend type Query {
    "All courts in the reference hierarchy. Cheap reference list."
    judicialCourts(filter: JudicialCourtsFilter): [JudicialCourt!]!
    "A court by institution code, with its direct children."
    judicialCourt(institutionCode: String!): JudicialCourt
    "A case by numeric caseId OR natural key (institutionCode + caseNumber). Composes name-gated detail. caseId is decimal digits up to 9223372036854775807 (otherwise INVALID_INPUT); a valid id that matches no case returns null."
    judicialCase(caseId: BigInt, institutionCode: String, caseNumber: String): JudicialCaseDetail
    "Case directory. Cursor-only (6.16M cases); REQUIRES a court or period bound."
    judicialCases(
      filter: JudicialCasesFilter
      sort: JudicialCaseSort = modifiedAt
      dir: JudicialSortDir = DESC
      first: Int = 20
      after: String
    ): JudicialCaseConnection!
    "Court caseload analytics (JD-2). Deterministic SQL; requires a court/level/period bound. groupBy year uses the session calendar year of the source-dependent sourceOpenedAt; counts over several sources combine different source clocks."
    judicialCaseload(
      groupBy: JudicialAggregateGroupBy!
      filter: JudicialCasesFilter
    ): JudicialCaseAggregate!
    "Company litigation (JD-1). published-only ⇒ empty in v1. Optional courtLevel/year/category narrowing (§7.3); years are session calendar years of the source-dependent sourceOpenedAt. Null arguments are absent, an empty list does not narrow, yearFrom/yearTo are nonzero years (1 BC is -1)."
    judicialCompanyLitigation(
      cui: String!
      courtLevel: [JudicialCourtLevel!]
      yearFrom: Int
      yearTo: Int
      category: [String!]
    ): JudicialCompanyLitigation!
    "Company litigation cases (JD-1 detail; gated; empty in v1)."
    judicialCompanyLitigationCases(
      cui: String!
      courtLevel: [JudicialCourtLevel!]
      yearFrom: Int
      yearTo: Int
      category: [String!]
      first: Int = 20
      after: String
    ): JudicialCaseLinkConnection!
    "Stored citation rows linking cases to the requested act, ordered by reference ID (one edge per reference); solution_summary references are excluded. targetActId is decimal digits up to 9223372036854775807 (otherwise INVALID_INPUT)."
    judicialCasesCitingAct(
      targetActId: BigInt!
      first: Int = 20
      after: String
    ): JudicialCaseCitationConnection!
    "Resolve a free-text query to a filter value (court→code, company name→nameKeyId, ...). dim is one of court, courtLevel, companyName, category; limit is an integer 1 to 50 (null means 10). Invalid input is INVALID_INPUT and is never echoed."
    judicialResolve(dim: String!, q: String!, limit: Int = 10): [JudicialResolveHit!]!
  }
`;

export const judicialTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
