/**
 * Legal module — GraphQL SDL slice (plan §6). All types `Legal*`-prefixed (§14.8).
 * **This module owns the `LegalAct` base type** (§9): it is declared ONCE here;
 * 06 only `extend type LegalAct { gazette* }` with `Mo*`-typed fields (stitched
 * INSIDE the module before the slice is contributed), never redeclares it.
 *
 * `SortDir` is module-local (not a kernel base type). `LegalActFilter` is GENERATED
 * from the §7.1 spec via the kernel `toGraphQLInput(spec)` so the surfaces never
 * drift. `Entity` is NOT extended in v1 (acts have no per-CUI slice — §2.2/§6.2).
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import { legalActsSpec } from '../filters/legal-acts.spec.js';

const filterInputs = toGraphQLInput(legalActsSpec);

const objectsAndQuery = /* GraphQL */ `
  enum LegalActStatus { IN_VIGOARE MODIFICAT ABROGAT ABROGAT_PARTIAL SUSPENDAT IESIT_DIN_VIGOARE NECUNOSCUT }
  enum LegalRelation  { MODIFICA ABROGA COMPLETEAZA SUSPENDA APROBA RECTIFICA FACE_REFERIRE RESPINGE }
  enum LegalSortKey   { IN_DEGREE ACT_YEAR ENTRY_INTO_FORCE DISPLAY_CITATION }
  enum LegalLinkDirection { IN OUT }
  enum LegalRetrievalChannel { auto sections docs }

  "Sort direction (Legal*-prefixed to avoid a cross-module collision; kernel base SDL has no SortDir)."
  enum LegalSortDir { ASC DESC }

  "The shared legal-act base type (§9). 06 EXTENDS this with Mo*-typed gazette fields; it never redeclares it."
  type LegalAct {
    actId: BigInt!
    actNaturalKey: String!
    actType: String!
    actNumber: String
    actYear: Int
    issuerSlug: String
    canonicalDocumentId: String
    displayCitation: String!
    status: LegalActStatus!
    statusEvidence: JSON!
    entryIntoForce: Date
    inDegree: Int!
    # lazy fields (DataLoader / repo, not on the base row):
    canonical: LegalDocument
    summary: LegalActSummary
    aliases: [String!]!
    citationKeys: [LegalCitationKey!]!
    versionCount: Int!
    "Incoming modifica/completeaza edge count — the §5.2-C honesty badge."
    amendedAfterPublication: Int!
    documents: [LegalDocument!]!
    links(direction: LegalLinkDirection!, relation: [LegalRelation!], first: Int = 50): LegalReferenceConnection!
    timeline: [LegalTimelineEntry!]!
    tree(documentId: String, path: String, depth: Int = 1): [LegalNode!]!
  }

  "A document expression of an act. documentId is TEXT (never BigInt). moPart/moNumber/moDate are best-effort hints (the authoritative act↔MO join is mo_act_publications.act_id — owned by 06)."
  type LegalDocument {
    documentId: String!
    actId: BigInt!
    versionKind: String!
    versionDate: Date
    isCanonical: Boolean!
    den: String
    title: String
    issuerRaw: String
    publicationRaw: String
    entryIntoForce: Date
    firstPublicationDate: Date
    statusMarkers: [String!]!
    extractionStatus: String
    compatibilityTier: String
    moPart: Int
    moNumber: String
    moDate: Date
  }

  type LegalActSummary {
    documentId: String!
    description: String
    summary: String
    plainLanguageSummary: String
    documentCategory: String
    domains: [String!]!
    affectedAudiences: [String!]!
    keywords: [String!]!
    keyDates: JSON
    penaltiesMentioned: Boolean
    fiscalImpact: String
    confidence: Float
  }

  type LegalCitationKey { actType: String!  actNumber: String!  actYear: Int!  issuerSlug: String! }

  type LegalReferenceEdge {
    sourceDocumentId: String!
    refIndex: Int!
    relation: LegalRelation!
    targetRaw: String!
    targetClass: String!
    "Resolved domestic act (DataLoader by act_id; tolerates dangling → null)."
    targetAct: LegalAct
    targetExternalAct: LegalExternalAct
    targetFragment: String
    resolution: String!
    confidence: Float
    "For incoming edges: the citing act (DataLoader by act_id)."
    sourceAct: LegalAct
  }
  type LegalReferenceConnection { edges: [LegalReferenceEdge!]!  pageInfo: PageInfo!  totalCount: Int }

  "A merged act timeline entry (status events + amendment edges, LG-2)."
  type LegalTimelineEntry {
    kind: String!
    effectiveDate: Date
    label: String!
    eventSource: String
    relatedActId: BigInt
    evidence: JSON
  }

  "A raw status event. eventSource is 'portal' | 'monitorul-oficial' (06 contributes rows; this type reads both)."
  type LegalStatusEvent {
    eventId: BigInt!
    actId: BigInt!
    eventKind: String!
    effectiveDate: Date
    sourceActId: BigInt
    evidence: JSON!
    eventSource: String!
  }

  "An intra-act structure node. Carries a char range as a forward-compat locator — node TEXT is not served (§3.4)."
  type LegalNode {
    nodeId: BigInt!
    documentId: String!
    parentNodeId: BigInt
    nodeKind: String!
    label: String
    numberKey: String
    path: String!
    orderIndex: Int!
    charStart: Int
    charEnd: Int
  }

  type LegalExternalAct { externalActId: BigInt!  identityKey: String!  displayCitation: String!  kind: String! }

  "A provision-level retrieval hit. snippet is grounded from document_summaries; charStart/charEnd are a forward-compat locator (not served text — §3.4)."
  type LegalSectionHit {
    act: LegalAct!
    documentId: String!
    sectionKey: String!
    articleNumber: String
    nodeLabel: String
    nodePath: String
    charStart: Int
    charEnd: Int
    snippet: String
    portalDeepLink: String
    score: Float!
  }

  "A doc-channel topical hit."
  type LegalDocHit { act: LegalAct!  summary: LegalActSummary  score: Float! }

  "The hybrid search result. caveats carries the §5.2-C honesty + semantic-gate notes."
  type LegalSearchResult {
    acts: [LegalDocHit!]!
    sections: [LegalSectionHit!]!
    caveats: [String!]!
  }

  type LegalActConnection { edges: [LegalActEdge!]!  pageInfo: PageInfo!  totalCount: Int }
  type LegalActEdge { node: LegalAct!  cursor: String! }

  "A name→value discovery hit (kernel ResolveHit shape, module-local SDL projection)."
  type LegalResolveHit { kind: String!  value: String!  label: String!  score: Float  hint: String }

  extend type Query {
    "An act by numeric act_id or free-text citation ('legea 227/2015' | 'codul fiscal')."
    legalAct(actId: BigInt, citation: String): LegalAct
    "Acts directory. Cursor-only (223k acts); default sort in_degree desc."
    legalActs(filter: LegalActsFilter, sort: LegalSortKey = IN_DEGREE, dir: LegalSortDir = DESC, first: Int = 20, after: String): LegalActConnection!
    "Retrieval (v1): identifier router (citation→act) → pgvector HNSW when the legal semantic gate is on, else a bounded Postgres lexical fallback. Engine RRF fusion (Meili + OpenSearch BM25) is planned, not yet wired."
    legalSearch(q: String!, filter: LegalActsFilter, channel: LegalRetrievalChannel = auto, includeHistorical: Boolean = false, limit: Int = 20): LegalSearchResult!
    legalExternalAct(externalActId: BigInt!): LegalExternalAct
    "Resolve a free-text query to a filter value (citation→actId, name→issuerSlug, label→domain/category)."
    legalResolve(dim: String!, q: String!, limit: Int = 10): [LegalResolveHit!]!
  }
`;

export const legalTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
