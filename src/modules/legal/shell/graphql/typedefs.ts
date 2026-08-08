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
  enum LegalActStatus {
    IN_VIGOARE
    MODIFICAT
    ABROGAT
    ABROGAT_PARTIAL
    SUSPENDAT
    IESIT_DIN_VIGOARE
    NECUNOSCUT
  }
  enum LegalRelation {
    MODIFICA
    ABROGA
    COMPLETEAZA
    SUSPENDA
    APROBA
    RECTIFICA
    FACE_REFERIRE
    RESPINGE
  }
  enum LegalSortKey {
    IN_DEGREE
    ACT_YEAR
    ENTRY_INTO_FORCE
    DISPLAY_CITATION
  }
  enum LegalLinkDirection {
    IN
    OUT
  }
  enum LegalRetrievalChannel {
    auto
    sections
    docs
  }

  "Sort direction (Legal*-prefixed to avoid a cross-module collision; kernel base SDL has no SortDir)."
  enum LegalSortDir {
    ASC
    DESC
  }

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
    "Which version the served text/summary actually is (§5.2-C). Batched per request."
    versionProvenance: LegalVersionProvenance!
    "The same fact rendered in Romanian, ready to show next to any text answer."
    textProvenance: String!
    documents: [LegalDocument!]!
    links(
      direction: LegalLinkDirection!
      relation: [LegalRelation!]
      first: Int = 50
    ): LegalReferenceConnection!
    "Incoming ANCHORS — links the portal itself asserts in citing documents' text (document_link_edges). A DIFFERENT graph from links: anchors are source assertions at mark grain, links are LLM-inferred normative relations; they disagree by construction and both disagreements are informative. Real totalCount; keyset-paged."
    incomingAnchors(first: Int = 50, after: String): LegalIncomingAnchorConnection!
    timeline: [LegalTimelineEntry!]!
  }

  "One incoming anchor occurrence. charStart/charEnd locate it in the CITING document's rendered text; linkText is the anchor's own words on the source page."
  type LegalIncomingAnchor {
    "Keyset paging key only — minted per compile, never a stable identity. The natural key is (sourceDocumentId, ordinal)."
    edgeId: BigInt!
    sourceDocumentId: String!
    "The citing act (batched loader; null for a document without an act row)."
    sourceAct: LegalAct
    sourceNodePath: String
    ordinal: Int!
    linkText: String
    "e.g. 'art. 5' when the anchor points at a provision, not the whole act."
    targetFragment: String
    "The resolved node path in OUR corpus when the fragment is held (held_fragment_resolved)."
    targetNodePath: String
    targetResolution: String
    charStart: Int!
    charEnd: Int!
  }
  type LegalIncomingAnchorEdge {
    node: LegalIncomingAnchor!
    cursor: String!
  }
  type LegalIncomingAnchorConnection {
    edges: [LegalIncomingAnchorEdge!]!
    pageInfo: PageInfo!
    "The REAL count of public incoming anchors — never the page size."
    totalCount: Int!
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
    "Render availability (null = never compiled). The artifact BODY travels only over the cacheable REST route GET /api/v1/legal/documents/{documentId}/render."
    render: LegalRenderInfo
  }

  "TLDF render availability for one document expression (legal.document_generations + row-0 chunk_count). status: served | content_unavailable | superseded_pending; only served+public documents answer on the REST render route."
  type LegalRenderInfo {
    documentId: String!
    renderStatus: String!
    privacyClass: String!
    textSha256: String!
    compilerVersion: String!
    compiledAt: String!
    "Physical chunk count; null when a generation exists but render rows are missing (inconsistent — the REST route answers 409)."
    chunkCount: Int
  }

  "Version provenance for a served text (§5.2-C). The corpus is published-form text only: version_kind is original|corp|stub-header|republicare and consolidare rows do not exist yet, so latestConsolidation* reads null/false until the consolidation-timeline lane loads them."
  type LegalVersionProvenance {
    "The canonical document's version_kind ('' when the act has no canonical document)."
    versionKind: String!
    versionDate: Date
    "The legislatie.just.ro deep link — where the consolidated form can be checked. Never our own act page, which serves this same published text."
    sourceUrl: String
    "Incoming modifica/completeaza edges — how many times the act changed after this text."
    amendedAfterPublication: Int!
    latestConsolidationDate: Date
    "False while a consolidation is only a timeline anchor we have not fetched."
    latestConsolidationLoaded: Boolean!
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

  type LegalCitationKey {
    actType: String!
    actNumber: String!
    actYear: Int!
    issuerSlug: String!
  }

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
  type LegalReferenceConnection {
    edges: [LegalReferenceEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }

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

  "A document TOC entry (document_nodes v2, role IS NULL headings only). Stable key is (documentId, path) — node ids are recompile-scoped and never served. charStart/charEnd locate the entry in the rendered clean text (UTF-16 units) for chunk-targeted fetches."
  type LegalOutlineEntry {
    documentId: String!
    path: String!
    nodeKind: String!
    label: String
    numberKey: String
    numberSystem: String
    "parsed | unparsed | ambiguous — an unparsed number is reported, never faked."
    numberStatus: String
    "Fixed grammar-rank indent depth (carte=1 … articol=7; anexa restarts at 1). Null when the node is not a TOC heading — nodeByPath resolves any structural node, and an alineat or a portion wrapper has no outline depth."
    depth: Int
    orderIndex: Int!
    charStart: Int
    charEnd: Int
  }

  type LegalOutlineConnection {
    entries: [LegalOutlineEntry!]!
    "Opaque keyset cursor; null when the outline is exhausted."
    next: String
  }

  type LegalExternalAct {
    externalActId: BigInt!
    identityKey: String!
    displayCitation: String!
    kind: String!
  }

  "A provision-level retrieval hit. snippet is grounded from document_summaries; charStart/charEnd locate the provision in the document's rendered clean text (REST render endpoint)."
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
  type LegalDocHit {
    act: LegalAct!
    summary: LegalActSummary
    score: Float!
  }

  "The hybrid search result. caveats carries the §5.2-C honesty + semantic-gate notes."
  type LegalSearchResult {
    acts: [LegalDocHit!]!
    sections: [LegalSectionHit!]!
    caveats: [String!]!
    "WHICH path answered: 'opensearch' | 'postgres'. The two have different guarantees — the engine knows real totals, the Postgres path only ever returns a bounded slice — so the client is told rather than left to assume."
    engine: String!
    "Real match count for the acts channel; NULL when the answering path cannot count (never the page size)."
    actsTotal: Int
    "Real match count for the sections channel; NULL when that channel did not run or cannot count."
    sectionsTotal: Int
    "False when a total is a lower bound, or when the path cannot count at all."
    totalsExhaustive: Boolean!
    "True when a leg the request wanted could not run (missing index, embedder down). caveats says which, in Romanian."
    degraded: Boolean!
    "Index build stamp (_meta.built_at) behind the answer; null on the Postgres path."
    asOf: String
    "Engine hits the database REFUSED to hydrate — non-canonical, absent, or failing a privacy gate — and so MISSING from this page. Non-zero means the list is shorter than the engine's ranking; a silently shortened page is indistinguishable from a genuinely small result set. Always 0 on the Postgres path, which selects and hydrates in one query."
    unhydratedHits: Int!
  }

  type LegalActConnection {
    edges: [LegalActEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }
  type LegalActEdge {
    node: LegalAct!
    cursor: String!
  }

  "A name→value discovery hit (kernel ResolveHit shape, module-local SDL projection)."
  type LegalResolveHit {
    kind: String!
    value: String!
    label: String!
    score: Float
    hint: String
  }

  extend type Query {
    "An act by numeric act_id or free-text citation ('legea 227/2015' | 'codul fiscal')."
    legalAct(actId: BigInt, citation: String): LegalAct
    "Acts directory. Cursor-only (223k acts); default sort in_degree desc."
    legalActs(
      filter: LegalActsFilter
      sort: LegalSortKey = IN_DEGREE
      dir: LegalSortDir = DESC
      first: Int = 20
      after: String
    ): LegalActConnection!
    "Retrieval: identifier router (citation→act) first; then the OpenSearch engine when this deployment has an index — BM25 over legal-acts/legal-sections fused with the section kNN leg by app-layer RRF, keys-only, hydrated from Postgres. Without an index the bounded Postgres path answers and says so via the engine field. An engine that FAILS errors; it is never silently replaced by a lexical scan. A filter the engine cannot express is refused, not widened."
    legalSearch(
      q: String!
      filter: LegalActsFilter
      channel: LegalRetrievalChannel = auto
      includeHistorical: Boolean = false
      limit: Int = 20
    ): LegalSearchResult!
    "Document TOC: role-null heading nodes in document order, keyset-paged. THE outline authority — the reader derives no structure from render blocks."
    legalDocumentOutline(
      documentId: String!
      maxDepth: Int = 3
      first: Int = 200
      after: String
    ): LegalOutlineConnection!
    legalExternalAct(externalActId: BigInt!): LegalExternalAct
    "Resolve a free-text query to a filter value (citation→actId, name→issuerSlug, label→domain/category)."
    legalResolve(dim: String!, q: String!, limit: Int = 10): [LegalResolveHit!]!
  }
`;

export const legalTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
