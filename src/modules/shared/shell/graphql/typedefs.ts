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

  "A SIRUTA-keyed territory (core.territories)."
  type Territory {
    id: Int!
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
    year: Int
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
    hits: [SearchHit!]!
    "Doc-type facet distribution → type-filter chips (empty on the pg fallback)."
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
    "Hybrid global search (Meili-primary, pg fallback). county = canonical county name; year = exact match."
    searchEntities(
      q: String!
      docTypes: [String!]
      county: String
      year: Int
      limit: Int
      offset: Int
    ): GlobalSearchResult!
  }
`;
