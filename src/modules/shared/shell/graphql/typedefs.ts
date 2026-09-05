/**
 * Shared Kernel — base GraphQL SDL (foundation §6.2, §14.8).
 *
 * Kernel-owned base types (Entity join type, Organization, Territory, MoneyFlow,
 * Document, PageInfo, health/search outputs) + the root Query. Modules EXTEND
 * `type Entity` and `extend type Query` — they never re-declare these (the §14.8
 * prefix exemption: kernel base types are un-prefixed and reused).
 */

import { scalarTypeDefs } from './scalars.js';

export const baseTypeDefs = /* GraphQL */ `
  ${scalarTypeDefs}

  "Relay-style page info (kernel-owned)."
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  "A canonical organization from the CUI identity hub (core.organizations)."
  type Organization {
    orgId: BigInt!
    cui: CUI
    registrationNumber: String
    kind: String!
    name: String!
    normalizedName: String
    countyName: String
    localityName: String
    sirutaCode: SIRUTA
    firstSeenSource: String!
    attrs: JSON!
  }

  type OrgIdentifier {
    scheme: String!
    value: String!
    source: String!
  }

  "Why a label carries no name — never inferred from a null canonicalName."
  enum OrganizationLabelStatus {
    "The spine has a canonical registry name for this CUI."
    named
    """
    The spine has the organization but no name yet: a minted placeholder whose
    stored name is the CUI itself. Present in analytics, not yet nameable.
    """
    placeholder
    """
    No servable identity — unknown, malformed, or restricted. Deliberately one
    state: distinguishing them would turn the field into an existence oracle.
    """
    unavailable
  }

  "A name for one requested identifier, resolved from the identity spine."
  type OrganizationLabel {
    """
    The normalized identifier, or null when the input was malformed or is not
    served. Correlate by POSITION: the list always matches the request length
    and order.
    """
    cui: CUI
    "The canonical registry name. Null unless status is named."
    canonicalName: String
    """
    Human-cased name. Currently ALWAYS null: the derived display_name mangles
    585,811 rows (diacritics, and acronyms such as CFR → Cfr), and the canonical
    casing is the raw registry string. Reserved for a repaired derivation.
    """
    displayName: String
    "Spine kind (company/public_entity/ngo/unknown). Descriptive only — never a membership test."
    kind: String
    status: OrganizationLabelStatus!
  }

  "A canonical geographic node with optional SIRUTA/NUTS identifiers."
  type Territory {
    id: Int!
    level: String
    kind: String
    territoryKey: String
    parentId: Int
    nutsCode: String
    territorialSirutaCode: SIRUTA
    sirutaCode: SIRUTA
    countySirutaCode: SIRUTA
    uatCode: String
    name: String!
    countyCode: String
    countyName: String
    region: String
    population: Int
  }

  "A single cross-source money flow (flows.money_flows)."
  type MoneyFlow {
    flowId: BigInt!
    flowType: String!
    sourceId: String
    sourceRef: String
    payerCui: CUI
    payerName: String
    payeeCui: CUI
    payeeName: String
    amountRon: Money
    amountEur: Money
    currency: String
    flowDate: Date
    flowYear: Int
    title: String
    classificationSystem: String
    classificationCode: String
    countyName: String
  }

  type FlowTypeBreakdown {
    flowType: String!
    count: Int!
    totalAmountRon: Money!
  }

  type FlowSummary {
    direction: String!
    count: Int!
    totalAmountRon: Money!
    minYear: Int
    maxYear: Int
    byFlowType: [FlowTypeBreakdown!]!
  }

  "A search.documents projection (kernel-owned)."
  type Document {
    docId: String!
    docType: String!
    title: String!
    body: String
    cuis: [CUI!]!
    docDate: Date
    amountRon: Money
    countyName: String
    url: String
    attrs: JSON!
  }

  "A hybrid-search hit (entities Meili index, pg fallback). Entity projection fields are nullable (present only for entity-index hits). \`visibility\`/raw \`attrs\` are deliberately NOT exposed."
  type SearchHit {
    id: String!
    docType: String!
    title: String!
    snippet: String
    score: Float
    source: String!
    "Stable source id (the type:key form) — the Postgres hydration join key."
    docId: String
    "The id key (substring after the first \`:\`) — for native deep-links."
    docKey: String
    "Secondary display line (the entity doc's subtitle)."
    subtitle: String
    countyName: String
    "External/source URL — interim deep-link for types without a native page."
    url: String
    "Precomputed importance (sort signal)."
    rankBoost: Float
    "Associated CUI identifiers (exact-match filter / CUI-spine deep-link)."
    cuis: [String!]
    "Every searchable identifier: CUIs, ONRC numbers, citations, PLx numbers."
    identifiers: [String!]
    "Every role this identity plays (a municipality may also be a PNRR entity)."
    roles: [String!]
    "False for struck-off companies and repealed acts."
    isActive: Boolean
    "Deprecated compatibility field for pre-palette clients; always null."
    year: Int @deprecated(reason: "Ambiguous across entity types; use source-specific filters")
  }

  "One facet bucket (e.g. doc_type distribution → the type-filter chips)."
  type SearchFacet {
    field: String!
    value: String!
    count: Int!
  }

  type OrgNameMatch {
    orgId: BigInt!
    cui: CUI
    name: String!
    countyName: String
    kind: String!
    score: Float
  }

  type SourcePresence {
    source: String!
    present: Boolean!
    label: String
    count: Int
    badges: [String!]
    attrs: JSON
  }

  "The cross-source entity join type. Source modules extend this by CUI (§6.2)."
  type Entity {
    cui: CUI!
    organization: Organization
    identifiers: [OrgIdentifier!]!
    territory: Territory
    flowsIn: FlowSummary!
    flowsOut: FlowSummary!
    documentCount: Int!
    presence: [SourcePresence!]!
  }

  type GlobalSearchResult {
    query: String!
    engine: String!
    """
    True when the search engine was unreachable and this answer came from the
    reduced outage path (exact-identifier lookup only). Empty hits then mean
    "we could not look", NOT "no matches" — tell the user that instead of
    rendering an empty state, and do not cache the answer.
    """
    degraded: Boolean!
    hits: [SearchHit!]!
    "Doc-type facet distribution → type-filter chips (empty on the degraded path)."
    facets: [SearchFacet!]!
    "Meili's approximate total (capped by maxTotalHits, default 1000); on the pg path it is the hit count."
    estimatedTotalHits: Int!
    "Deprecated: always empty; consume the indexed and visibility-filtered \`hits\` instead."
    organizations: [OrgNameMatch!]!
  }

  type ServiceStatus {
    status: String!
    latencyMs: Int
    error: String
  }

  type HealthReport {
    overall: String!
    postgres: ServiceStatus!
    meilisearch: ServiceStatus!
    opensearch: ServiceStatus!
    synthetic: ServiceStatus!
  }

  type Query {
    "Kernel liveness + aux service statuses (degrades, never hard-fails)."
    health: HealthReport!
    "Cross-source entity-360 addressed by CUI."
    entity(cui: CUI!): Entity
    """
    Batch name lookup on the identity SPINE — one label per requested identifier,
    in the order asked, resolved in a single query.

    Use this to label parties in any multi-party display (rankings, breakdowns,
    record lists) instead of querying a role registry. referencePublicEntities
    answers only for public INSTITUTIONS and companies() only for the ANAF
    registry, so a buyer that is a state company resolves in neither — 41.5% of
    contract award money is spent by buyers they cannot name.

    Read the status field rather than testing canonicalName for null. Bounded at
    250 identifiers per request; more is an InvalidInput error, never a silent
    truncation.
    """
    organizationLabels(cuis: [String!]!): [OrganizationLabel!]!
    """
    Global search over the entity palette (Meili-primary, pg fallback).
    One hit per IDENTITY: docTypes narrows what a thing IS, roles narrows what
    it PLAYS (a municipality that is also a PNRR beneficiary is one hit carrying
    both). county is a canonical county name. isActive drops struck-off
    entities. NOTE: no backticks here - this SDL is a TS template literal.
    """
    searchEntities(
      q: String!
      docTypes: [String!]
      roles: [String!]
      county: String
      isActive: Boolean
      year: Int @deprecated(reason: "Ignored compatibility argument for pre-palette clients")
      limit: Int
      offset: Int
    ): GlobalSearchResult!
  }
`;
