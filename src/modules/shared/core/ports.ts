/**
 * Shared Kernel — Port interfaces (foundation §4).
 *
 * Repositories and external clients the kernel + every source module depend on.
 * Core stays pure: ports return `Result<T, ApiError>` (neverthrow); the shell
 * adapts them to Kysely/Fastify/MCP. A source module depends on these ports and
 * never on another source module.
 */

import type { ApiError } from './errors.js';
import type { CursorPage } from './pagination.js';
import type {
  CounterpartyNetwork,
  CountyRef,
  Counterparty,
  Cui,
  Document,
  EntityProfileSlice,
  FlowAggregateGroup,
  FlowDirection,
  FlowSummary,
  MoneyFlow,
  OrgIdentifier,
  OrgNameMatch,
  Organization,
  SearchHit,
  Siruta,
  SourcePresence,
  Territory,
} from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Identity hub (§4.1, §15.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgResolution {
  readonly org: Organization;
  readonly confidence: number; // 0..1
}

export interface IdentityRepo {
  findByCui(cui: Cui): Promise<Result<Organization | null, ApiError>>;
  findByOrgId(orgId: string): Promise<Result<Organization | null, ApiError>>;
  getIdentifiers(orgId: string): Promise<Result<readonly OrgIdentifier[], ApiError>>;
  /** Meili-primary name search with a bounded pg fallback (§15.7). */
  searchByName(q: string, limit: number): Promise<Result<readonly OrgNameMatch[], ApiError>>;
  resolve(cuiOrName: string): Promise<Result<OrgResolution | null, ApiError>>;
  /** core.public_entities.cui → territorial_siruta_code → core.territories (§15.3). */
  territoryForCui(cui: Cui): Promise<Result<Territory | null, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Territory hub (§4.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface TerritoryRepo {
  byTerritorialSiruta(code: Siruta): Promise<Result<Territory | null, ApiError>>;
  byCounty(countyCode: string): Promise<Result<readonly Territory[], ApiError>>;
  searchUat(q: string, limit: number): Promise<Result<readonly Territory[], ApiError>>;
  listCounties(): Promise<Result<readonly CountyRef[], ApiError>>;
  listRegions(): Promise<Result<readonly string[], ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money flows — the ONLY repo that reads flows.money_flows (§4.3, §14.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowListOptions {
  readonly direction: FlowDirection;
  readonly flowType?: string;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly limit: number;
  /**
   * The opaque cursor string from the previous page (NOT pre-decoded keys). The
   * repo decodes it and validates it against the active filter set's fhash/sort/
   * dir, rejecting filter-mismatched cursors at this boundary (§14.3).
   */
  readonly cursor?: string;
}

export interface FlowsRepo {
  /**
   * Aggregated flow summary. `byYear` (per-(year, flow_type)) is computed ONLY when
   * `includeYearBreakdown` is true — it costs an extra aggregate over money_flows, so
   * the entity-360 hot path (which exposes only `byFlowType`) leaves it off and gets
   * an empty `byYear`. Company.publicMoney opts in.
   */
  getFlowSummary(
    cui: Cui,
    direction: FlowDirection,
    includeYearBreakdown?: boolean
  ): Promise<Result<FlowSummary, ApiError>>;
  getTopCounterparties(
    cui: Cui,
    direction: FlowDirection,
    limit: number
  ): Promise<Result<readonly Counterparty[], ApiError>>;
  listFlows(cui: Cui, options: FlowListOptions): Promise<Result<CursorPage<MoneyFlow>, ApiError>>;
  getCounterpartyNetwork(
    rootCui: Cui,
    depth: number,
    nodeLimit: number
  ): Promise<Result<CounterpartyNetwork, ApiError>>;
  aggregateFlows(
    groupBy: 'year' | 'flow_type' | 'county' | 'cpv',
    filters: { flowType?: string; yearFrom?: number; yearTo?: number }
  ): Promise<Result<readonly FlowAggregateGroup[], ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search — hybrid contract (§4.5)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchRepo {
  /** Count search.documents whose `cuis` array contains the CUI. */
  countByCui(cui: Cui): Promise<Result<number, ApiError>>;
  /** Bounded ILIKE fallback over search.documents (when aux engines are down). */
  fallbackTextSearch(
    q: string,
    docTypes: readonly string[],
    limit: number
  ): Promise<Result<readonly SearchHit[], ApiError>>;
  /**
   * Visibility-scoped, entity-doc-type-scoped Postgres fallback for the global
   * entity search — always filters `visibility='public'` + `deleted_at IS NULL`
   * + the entity-grade `doc_type` set, optionally narrowed by `docTypes`/county/
   * year. The Meili-parity degrade path (impl lands in T2). Empty `q` → no rows.
   */
  searchEntities(
    q: string,
    opts: {
      readonly docTypes?: readonly string[];
      readonly county?: string;
      readonly year?: number;
      readonly limit: number;
      readonly offset?: number;
    }
  ): Promise<Result<readonly SearchHit[], ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents (§4.5)
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentRepo {
  findById(docId: string): Promise<Result<Document | null, ApiError>>;
  listByCui(cui: Cui, limit: number): Promise<Result<readonly Document[], ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// External clients (§4.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface MeiliSearchResult {
  readonly index: string;
  readonly hits: readonly SearchHit[];
  readonly totalHits: number;
}

/**
 * The result of a single-index `entities` search: mapped hits, the raw facet
 * distribution from Meili (`{ field: { value: count } }`), and the approximate
 * total (capped by `maxTotalHits`). The usecase flattens `facetDistribution`
 * into the typed `SearchFacet[]`.
 */
export interface EntitiesSearchResult {
  readonly hits: readonly SearchHit[];
  readonly facetDistribution: Readonly<Record<string, Record<string, number>>>;
  readonly estimatedTotalHits: number;
}

export interface MeiliClient {
  multiSearch(
    q: string,
    indexes: readonly string[],
    limit: number
  ): Promise<Result<readonly MeiliSearchResult[], ApiError>>;
  /**
   * Single-index search against the `entities` index. `filter` is Meili's array
   * filter form (built by `buildEntitiesFilter` — never a hand-built string);
   * `facets` requests a facet distribution. The impl sets `showRankingScore` +
   * `attributesToHighlight` (lands in T2). A missing/corrupt index is surfaced
   * as an error so the usecase can degrade to Postgres.
   */
  searchEntities(
    q: string,
    index: string,
    opts: {
      readonly filter?: unknown;
      readonly facets?: readonly string[];
      readonly limit: number;
      readonly offset?: number;
    }
  ): Promise<Result<EntitiesSearchResult, ApiError>>;
  healthCheck(): Promise<Result<void, ApiError>>;
}

export interface OpenSearchAggBucket {
  readonly key: string;
  readonly docCount: number;
  readonly totalRon: number;
}

export interface OpenSearchClient {
  healthCheck(): Promise<Result<{ status: string }, ApiError>>;
  termsAggregation(
    index: string,
    field: string,
    filters: Record<string, unknown>,
    size?: number
  ): Promise<Result<readonly OpenSearchAggBucket[], ApiError>>;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
}

export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: string;
}

export interface SyntheticClient {
  embed(text: string, model: string): Promise<Result<readonly number[], ApiError>>;
  chat(
    messages: readonly ChatMessage[],
    model: string,
    tools?: readonly ToolDefinition[],
    timeoutMs?: number
  ): Promise<Result<ChatResponse, ApiError>>;
  discoverEmbeddingModel(): Promise<Result<string, ApiError>>;
  discoverChatModel(): Promise<Result<string, ApiError>>;
  healthCheck(): Promise<Result<void, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source contributor registry (§4.4, §14.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each source module registers one contributor. Kernel usecases (entity-360,
 * global search, ask) iterate the registry — adding a source extends entity-360
 * WITHOUT editing the kernel. GraphQL `Entity.<source>` resolvers MUST call the
 * same `profileSlice` (§14.7).
 */
export interface SourceContributor {
  readonly source: string;
  presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>>;
  profileSlice?(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>>;
}

/** A mutable registry of contributors (register at wiring time; iterate later). */
export interface ContributorRegistry {
  register(contributor: SourceContributor): void;
  list(): readonly SourceContributor[];
  get(source: string): SourceContributor | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module legal-act loader (kernel port; legal module implements — §15.4)
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal legal-act shape the loader returns. The legal module owns the full type. */
export interface LegalActRef {
  readonly actId: string;
  readonly title: string | null;
  readonly actType: string | null;
  readonly resolutionStatus: 'resolved' | 'dangling';
}

/**
 * Parliament (04) + judicial (08) resolve `act_id → LegalAct` without importing
 * the legal module. The legal module (05) provides the impl and registers it.
 * MUST tolerate a dangling id: return null + status, never error (§15.4).
 */
export interface LegalActByIdLoader {
  load(actId: string): Promise<LegalActRef | null>;
  loadMany(ids: readonly string[]): Promise<readonly (LegalActRef | null)[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search capabilities (§14.5) — resolved once at boot, per domain
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchCapabilities {
  readonly meili: boolean;
  readonly opensearch: boolean;
}

export interface DomainSearchCapabilities {
  readonly semantic: boolean;
  readonly reason?: string;
}

export interface CapabilityResolver {
  readonly engines: SearchCapabilities;
  forDomain(domain: string): DomainSearchCapabilities;
}
