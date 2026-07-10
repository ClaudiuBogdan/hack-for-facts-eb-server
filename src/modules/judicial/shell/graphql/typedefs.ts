/**
 * Judicial module — GraphQL SDL slice (plan 08 §3.3). All types `Judicial*`-prefixed
 * (§14.8). **NAME-FREE BY CONSTRUCTION**, the centerpiece:
 *
 *  - `JudicialParty` / `JudicialPartyView` have NO `displayName` field. The only
 *    name field is `JudicialPartyView.name`, resolved through the gated
 *    `PartyDictionaryRepo` (→ null for person/unknown).
 *  - `JudicialHearing` has NO `solutionSummary` field and NO `solution` field.
 *
 * The schema-merge conflict gate (§14.8) + the leak audit guarantee no extension
 * re-adds them. Filter inputs are GENERATED from the §7 specs via the kernel
 * `toGraphQLInput(spec)` so the surfaces never drift. `targetAct` on a legal-ref
 * resolves to the kernel `LegalAct` via the shared `legalActLoader` (tolerates
 * dangling → null); the `LegalAct` type itself is owned by the legal module (05).
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { judicialCasesSpec, judicialCourtsSpec } from '../filters/judicial.spec.js';

const filterInputs = `${toGraphQLInput(judicialCasesSpec)}\n\n${toGraphQLInput(judicialCourtsSpec)}`;

const objectsAndQuery = /* GraphQL */ `
  enum JudicialCourtLevel {
    judecatorie
    tribunal
    tribunal_militar
    curte_de_apel
    curte_militara_apel
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

  "A court in the 246-row reference hierarchy. ICCJ is permanently absent (different source)."
  type JudicialCourt {
    institutionCode: String!
    ordinal: Int!
    courtLevel: JudicialCourtLevel!
    specialization: String
    locality: String
    countySirutaCode: String
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
    sourceOpenedAt: Date
    latestSourceModifiedAt: DateTime
  }

  "A hearing. solution_summary AND solution are STRUCTURALLY ABSENT in v1 (privacy — §2.1)."
  type JudicialHearing {
    caseId: BigInt!
    hearingIndex: Int!
    hearingAt: DateTime
    panel: String
    pronouncementDate: Date
    documentNumber: String
    documentDate: Date
    # NO solutionSummary (forbidden permanently). NO solution (withheld in v1).
  }

  type JudicialAppeal {
    caseId: BigInt!
    appealIndex: Int!
    appealDeclaredAt: Date
    appealType: String
  }

  "A party rendered for case detail. name and nameKeyId are non-null ONLY for publishable company/public parties; both are null for withheld identities."
  type JudicialPartyView {
    partyIndex: Int!
    partyKind: JudicialPartyKind!
    roleNormalized: String
    "Public company/entity key; null for person, unknown, or otherwise non-publishable parties."
    nameKeyId: BigInt
    "Publishable company/public name (gated). null for person/unknown — the system cannot emit a person's name."
    name: String
    legalForm: String
  }

  "A safe legal-act citation referenced by a case. citation is the normalized token (act_type/number/year), NEVER the source span."
  type JudicialLegalRef {
    caseLegalReferenceId: BigInt!
    caseId: BigInt!
    actType: String
    actNumber: String
    actYear: Int
    issuerSlug: String
    articleFragment: String
    targetActId: BigInt
    resolutionStatus: String
    confidenceScore: String
    citation: String!
    "Resolved domestic act (kernel legalActLoader by act_id; tolerates dangling → null). Empty in v1 (gate #11)."
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

  "Domain freshness watermark (§10)."
  type JudicialAsOf {
    asOf: DateTime
    estimated: Boolean!
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
  type JudicialYearCount {
    year: Int!
    count: Int!
  }
  "Company-litigation summary (JD-1). published-only ⇒ empty in v1 (caseCount 0, coverage 0)."
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
    "Courts in the 246-row hierarchy. Cheap reference list."
    judicialCourts(filter: JudicialCourtsFilter): [JudicialCourt!]!
    "A court by institution code, with its direct children."
    judicialCourt(institutionCode: String!): JudicialCourt
    "A case by numeric caseId OR natural key (institutionCode + caseNumber). Composes name-gated detail."
    judicialCase(caseId: BigInt, institutionCode: String, caseNumber: String): JudicialCaseDetail
    "Case directory. Cursor-only (6.16M cases); REQUIRES a court or period bound."
    judicialCases(
      filter: JudicialCasesFilter
      sort: JudicialCaseSort = modifiedAt
      dir: JudicialSortDir = DESC
      first: Int = 20
      after: String
    ): JudicialCaseConnection!
    "Court caseload analytics (JD-2). Deterministic SQL; requires a court/level/period bound."
    judicialCaseload(
      groupBy: JudicialAggregateGroupBy!
      filter: JudicialCasesFilter
    ): JudicialCaseAggregate!
    "Company litigation (JD-1). published-only ⇒ empty in v1. Optional courtLevel/year/category narrowing (§7.3)."
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
    "Cases citing a legal act (JD-3 reverse; empty until gate #11)."
    judicialCasesCitingAct(
      targetActId: BigInt!
      first: Int = 20
      after: String
    ): JudicialCaseCitationConnection!
    "Resolve a free-text query to a filter value (court→code, company name→nameKeyId, ...)."
    judicialResolve(dim: String!, q: String!, limit: Int = 10): [JudicialResolveHit!]!
  }
`;

export const judicialTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
