/**
 * Primarii-transparency module — GraphQL SDL (plan §6). All types `Primarii*`
 * PascalCase (§14.8). The module contributes `typeDefs` extending the root `Query`,
 * plus the `Entity` extension. Filter inputs are DERIVED from the filter specs
 * (`toGraphQLInput`) so REST/GraphQL/MCP never drift — never hand-coded.
 *
 * Kernel base types (`CUI`, `SIRUTA`, `BigInt`, `Money`, `Date`, `DateTime`,
 * `Territory`, `Entity`, `PageInfo`) are reused un-prefixed (§14.8 exemption) — this
 * slice must NOT re-declare them.
 *
 * `amountRon` is the `Money` scalar but documented as a SELF-REPORTED disclosure
 * claim, NOT verified spend (§4 grain gate). `PrimariiEntityStatus.territory`
 * resolves lazily through the kernel cui→territory resolver (DataLoader on CUI);
 * it returns null where the CUI→public_entities→territory path is incomplete.
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { primariiDocumentFilterSpec, primariiEntityFilterSpec } from '../../core/filters.js';

const filterInputs = [primariiEntityFilterSpec, primariiDocumentFilterSpec]
  .map((spec) => toGraphQLInput(spec))
  .join('\n\n');

export const primariiTypeDefs = /* GraphQL */ `
  # Value-carrying enums use the LOWERCASE DB string verbatim, so a column value
  # (e.g. 'high', 'organigrama') serializes directly with no resolver value-map
  # (the pnrr/legal-channel/budget-metric idiom). Sort keys are UPPERCASE because the
  # repo maps them to physical columns (not returned as data).
  enum PrimariiDataQuality {
    high
    medium
    low
    missing
    review_needed
  }
  enum PrimariiResultStatus {
    partial
    complete
    blocked
    missing_result
    not_found
    error
  }
  enum PrimariiCategory {
    organigrama
    numar_angajati
    salarii
  }
  enum PrimariiCategoryState {
    found
    not_found
    unknown
    blocked
  }
  enum PrimariiEntityType {
    admin_commune_hall
    admin_town_hall
    admin_municipality
    admin_sector_hall
    primarie
  }
  enum PrimariiEntitySortKey {
    DATA_QUALITY
    CONFIDENCE
    EVIDENCE_COVERAGE
    ISSUE_COUNT
    ENTITY_NAME
    UPDATED_AT
  }
  enum PrimariiStatGroupBy {
    county
    region
    data_quality_status
    result_status
    entity_type
  }
  enum PrimariiResolveDim {
    entity
    county
    status
    siruta
  }

  type PrimariiEntityStatus {
    cui: CUI!
    entityName: String!
    entityType: PrimariiEntityType
    county: String
    websiteUrl: String
    resultStatus: PrimariiResultStatus!
    dataQualityStatus: PrimariiDataQuality!
    confidence: Float
    evidenceCoverage: Float
    missingRequiredCategories: [String!]!
    issueCount: Int!
    updatedAt: DateTime!
    "Canonical territory resolved lazily via the kernel cui→territory resolver (DataLoader on CUI). Null where the CUI→public_entities→territory path is incomplete."
    territory: Territory
  }

  type PrimariiCategoryStatus {
    category: PrimariiCategory!
    status: PrimariiCategoryState!
    evidenceCount: Int!
    missingEvidenceCount: Int!
  }

  type PrimariiStaffingClaim {
    totalPositions: Int
    occupiedPositions: Int
    vacantPositions: Int
    asOfDate: String
    confidence: Float
  }

  type PrimariiOrganigramaClaim {
    status: PrimariiCategoryState!
    effectiveDate: String
    summary: String
    confidence: Float
  }

  type PrimariiSalaryClaim {
    salaryAmountClaimId: BigInt!
    cui: CUI!
    "The evidence document this claim was extracted from (links to PrimariiDocument.documentPk). Null when unlinked."
    documentPk: BigInt
    "SELF-REPORTED disclosure claim extracted from a PDF, NOT a verified payment. Never summed into spend totals."
    amountRon: Money!
    roleTitle: String
    periodStart: Date
    periodEnd: Date
    confidence: Float
  }

  type PrimariiDocument {
    documentPk: BigInt!
    cui: CUI!
    category: String
    documentType: String
    title: String
    sourceUrl: String
    contentSha256: String
    contentBytes: BigInt
    publishedDate: String
    effectiveDate: String
  }

  type PrimariiSnapshot {
    snapshotId: BigInt!
    cui: CUI!
    entityName: String!
    entityType: String
    county: String
    websiteUrl: String
    wikipediaUrl: String
    sourceResultVersionId: BigInt
    schemaVersion: String
    resultStatus: String!
    confidence: Float
    researchedAt: DateTime
    organigramaStatus: String
    numarAngajatiStatus: String
    salariiStatus: String
    missingRequiredCategories: [String!]!
    validationIssues: [String!]!
    loadedAt: DateTime!
  }

  type PrimariiLoadIssue {
    severity: String!
    issueCode: String!
    cui: CUI
    message: String!
    createdAt: DateTime!
  }

  type PrimariiCategoryCount {
    category: String!
    count: Int!
  }

  type PrimariiEntityProfile {
    status: PrimariiEntityStatus!
    categories: [PrimariiCategoryStatus!]!
    staffing: PrimariiStaffingClaim
    organigrama: PrimariiOrganigramaClaim
    documentCounts: [PrimariiCategoryCount!]!
  }

  type PrimariiStatusBucket {
    key: String!
    total: Int!
    withEvidence: Int
  }
  type PrimariiCategoryCoverage {
    category: PrimariiCategory!
    found: Int!
    notFound: Int!
    unknown: Int!
    blocked: Int!
    coverage: Float!
  }

  "A name→value discovery hit (kernel ResolveHit shape; kind = the resolved dimension)."
  type PrimariiResolveHit {
    kind: String!
    value: String!
    label: String!
    score: Float
    hint: String
  }

  type PrimariiEntityConnection {
    edges: [PrimariiEntityEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type PrimariiEntityEdge {
    node: PrimariiEntityStatus!
    cursor: String!
  }

  type PrimariiDocumentConnection {
    edges: [PrimariiDocumentEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type PrimariiDocumentEdge {
    node: PrimariiDocument!
    cursor: String!
  }

  type PrimariiSalaryClaimConnection {
    edges: [PrimariiSalaryClaimEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type PrimariiSalaryClaimEdge {
    node: PrimariiSalaryClaim!
    cursor: String!
  }

  type PrimariiSnapshotConnection {
    edges: [PrimariiSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type PrimariiSnapshotEdge {
    node: PrimariiSnapshot!
    cursor: String!
  }

  ${filterInputs}

  extend type Query {
    primariiEntities(
      filter: PrimariiEntityFilter
      first: Int = 20
      after: String
      sort: PrimariiEntitySortKey
    ): PrimariiEntityConnection!
    primariiEntity(cui: CUI!): PrimariiEntityProfile
    primariiEntitySnapshots(cui: CUI!, first: Int = 20, after: String): PrimariiSnapshotConnection!
    primariiEntitySalaryClaims(
      cui: CUI!
      first: Int = 20
      after: String
    ): PrimariiSalaryClaimConnection!
    primariiDocuments(
      filter: PrimariiDocumentFilter!
      first: Int = 20
      after: String
    ): PrimariiDocumentConnection!
    primariiStats(
      groupBy: PrimariiStatGroupBy!
      filter: PrimariiEntityFilter
    ): [PrimariiStatusBucket!]!
    primariiCategoryCoverage(filter: PrimariiEntityFilter): [PrimariiCategoryCoverage!]!
    "Loader QA events (ops surface). Bounded capped list (limit ≤ 200) — small table, no cursor."
    primariiLoadIssues(
      cui: CUI
      severity: String
      issueCode: String
      limit: Int = 50
    ): [PrimariiLoadIssue!]!
    primariiResolve(dim: PrimariiResolveDim!, q: String!, limit: Int = 10): [PrimariiResolveHit!]!
  }

  extend type Entity {
    "The governance/transparency dimension of this institution (§14.7 contributor slice)."
    primariiTransparency: PrimariiEntityProfile
  }
`;
