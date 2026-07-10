/**
 * Reference module — GraphQL SDL slice (plan §6). Module-owned types are
 * `Reference*`-prefixed (§14.8); kernel `Organization`/`Territory`/`Entity` are
 * REUSED un-prefixed (§14.8 EXEMPTION lists them explicitly). Extends root `Query`
 * + the kernel `Entity` type. Filter inputs are GENERATED from the §7 specs via the
 * kernel `toGraphQLInput(spec)` so the surfaces never drift.
 *
 * `ReferencePublicEntity.territory` is the FULL kernel `Territory` (no forked
 * trimmed type — review BLOCKER) and resolves via a CUI/siruta-keyed DataLoader on
 * the kernel TerritoryRepo. The resolve surface returns the kernel-shaped
 * `ReferenceResolveHit { kind, value, label, score, hint }` (kind = the dimension).
 *
 * Generated input type names follow `pascal(collection)+"Filter"`:
 *   reference_public_entity → ReferencePublicEntityFilter
 *   reference_territory     → ReferenceTerritoryFilter
 *   reference_classification → ReferenceClassificationFilter
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import {
  referenceClassificationFilterSpec,
  referencePublicEntityFilterSpec,
  referenceTerritoryFilterSpec,
} from '../../core/filters.js';

const filterInputs = [
  referencePublicEntityFilterSpec,
  referenceTerritoryFilterSpec,
  referenceClassificationFilterSpec,
]
  .map((spec) => toGraphQLInput(spec))
  .join('\n\n');

const objectsAndQuery = /* GraphQL */ `
  enum ReferenceResolveDim {
    public_entity
    territory
    classification
    organization
  }
  enum ReferenceAggregateDim {
    entity_type
    category
    is_uat
    county
  }
  enum ReferencePublicEntitySort {
    name
    cui
    entity_type
    updated_at
  }
  enum ReferenceTerritorySort {
    name
    population
    county_code
  }
  enum ReferenceClassificationSort {
    code
    label
  }

  "Provenance of the UAT mapping (reference-only attrs)."
  type ReferenceUatMapping {
    method: String
    confidence: String
    unresolvedReason: String
  }
  "Parent-creditor CUIs (link, not merge)."
  type ReferenceParentCreditors {
    cui1: CUI
    cui2: CUI
  }

  "A budget-world public entity (the registry card over core.public_entities)."
  type ReferencePublicEntity {
    cui: CUI!
    name: String!
    address: String
    "Open set: education | uat | public_entity | health | ... (free string, not a closed enum)."
    entityType: String
    "~50-value open set (a free string facet)."
    category: String
    tags: [String!]!
    isUat: Boolean!
    "Territory link key on core.territories (no FK)."
    territorialSirutaCode: SIRUTA
    "Canonical kernel Territory (county/region/population), resolved via the kernel TerritoryRepo. Null on lists / unresolved links."
    territory: Territory
    uatMapping: ReferenceUatMapping!
    parents: ReferenceParentCreditors!
    "main_creditors jsonb passthrough (PII-free objects)."
    mainCreditors: [JSON!]!
    defaultReportType: String
    "Data-quality issues (the public_entities.issues pattern). Empty in the current snapshot."
    issues: [JSON!]!
    "Debug provenance; null unless requested with includeTrace:true on the detail query. NEVER emitted via MCP."
    fieldTrace: JSON
    updatedAt: DateTime!
    "Kernel cross-source join by CUI (companies / budget / procurement / pnrr slices)."
    entity: Entity
  }

  type ReferenceClassificationCode {
    system: String!
    code: String!
    label: String
    parentCode: String
  }
  type ReferenceClassificationSystem {
    system: String!
    count: Int!
  }
  type ReferenceCounty {
    countyCode: String!
    countyName: String!
    region: String
    uatCount: Int!
    population: Int
  }
  type ReferenceRegion {
    region: String!
    countyCount: Int!
    uatCount: Int!
  }
  type ReferenceCountBucket {
    key: String!
    label: String
    count: Int!
  }
  "A name→value discovery hit (kernel ResolveHit shape; kind = the resolved dimension)."
  type ReferenceResolveHit {
    kind: String!
    value: String!
    label: String!
    score: Float
    hint: String
  }

  # Relay connections (kernel cursor envelope). totalCount = the filtered registry total (cheap COUNT, small dim).
  type ReferencePublicEntityConnection {
    edges: [ReferencePublicEntityEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type ReferencePublicEntityEdge {
    node: ReferencePublicEntity!
    cursor: String!
  }
  type ReferenceTerritoryConnection {
    edges: [ReferenceTerritoryNodeEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type ReferenceTerritoryNodeEdge {
    node: Territory!
    cursor: String!
  }
  type ReferenceClassificationConnection {
    edges: [ReferenceClassificationEdge!]!
    pageInfo: PageInfo!
  }
  type ReferenceClassificationEdge {
    node: ReferenceClassificationCode!
    cursor: String!
  }

  extend type Query {
    "Public-entity registry detail by CUI. includeTrace adds field_trace (debug)."
    referencePublicEntity(cui: CUI!, includeTrace: Boolean = false): ReferencePublicEntity
    "Public-entity registry directory (default sort name asc)."
    referencePublicEntities(
      filter: ReferencePublicEntityFilter
      first: Int = 20
      after: String
      sort: ReferencePublicEntitySort
    ): ReferencePublicEntityConnection!
    "Children of a creditor (parent1_cui/parent2_cui org tree)."
    referencePublicEntityChildren(cui: CUI!): [ReferencePublicEntity!]!
    "Registry stats grouped by entity_type / category / is_uat / county."
    referencePublicEntityAggregate(
      by: ReferenceAggregateDim!
      filter: ReferencePublicEntityFilter
    ): [ReferenceCountBucket!]!

    "Territory/UAT detail by surrogate id OR territorial SIRUTA (exactly one of)."
    referenceTerritory(id: ID, siruta: SIRUTA): Territory
    "Territory/UAT browse (kernel Territory nodes; default sort name asc)."
    referenceTerritories(
      filter: ReferenceTerritoryFilter
      first: Int = 20
      after: String
      sort: ReferenceTerritorySort
    ): ReferenceTerritoryConnection!
    "42 counties (rollup, cached long)."
    referenceCounties: [ReferenceCounty!]!
    "8 development regions (rollup, cached long)."
    referenceRegions: [ReferenceRegion!]!

    "CAEN classification code detail."
    referenceClassificationCode(system: String!, code: String!): ReferenceClassificationCode
    "CAEN classification browse (default sort code asc)."
    referenceClassificationCodes(
      filter: ReferenceClassificationFilter
      first: Int = 50
      after: String
      sort: ReferenceClassificationSort
    ): ReferenceClassificationConnection!
    "The CAEN systems + code counts."
    referenceClassificationSystems: [ReferenceClassificationSystem!]!

    "Organization reference card by CUI (kernel identity hub; companies-only today — a public-entity-only CUI returns null)."
    referenceOrganization(cui: CUI!): Organization

    "Resolve a free-text query to a filter value: institution name → CUI, locality → SIRUTA, CAEN label → code, company name/CUI → CUI."
    referenceResolve(
      dim: ReferenceResolveDim!
      q: String!
      limit: Int = 10
    ): [ReferenceResolveHit!]!
  }

  extend type Entity {
    "Public-entity registry card for this CUI (via the cross-source contributor)."
    reference: ReferencePublicEntity
  }
`;

export const referenceTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
