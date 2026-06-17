/**
 * Budget module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP would. `ApiError` → `GraphQLError` with `extensions.code`. Cursor
 * pages → Relay connections (per-edge cursor bound to the active fhash).
 * `Entity.budget` goes through the kernel `makeEntityProfileSlice` (contributor
 * parity, §14.7) via a CUI DataLoader so an entity-list fan-out is one MV probe
 * per batch. Fact lists are connections; rankings are bounded lists.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type CollectionFilterSpec,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  budgetCommitmentFactFilterSpec,
  budgetFactFilterSpec,
} from '../../core/filters.js';
import {
  aggregateByClassification,
  budgetAsOf,
  budgetTimeseries,
  budgetVsExecution,
  commitmentTimeseries,
  countyHeatmap,
  getEntityBudget,
  getEntityCommitments,
  getExecutionLineItem,
  listApprovedBudgetFacts,
  listBudgetSectors,
  listCommitmentLineItems,
  listEconomicClassifications,
  listExecutionLineItems,
  listFunctionalClassifications,
  listFundingSources,
  listReports,
  rankCommitmentEntities,
  rankEntities,
  resolveBudgetFilter,
} from '../../core/usecases.js';

import type {
  AccountCategory,
  BudgetFrequency,
  BudgetNormalization,
  CommitmentReportType,
  ExecutionReportType,
} from '../../core/constants.js';
import type { BudgetDiscoveryRepo, BudgetRepo } from '../../core/ports.js';
import type {
  BudgetRankingMetric,
  BudgetResolveDim,
  CommitmentLineItem,
  CommitmentRankingMetric,
  ExecutionLineItem,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface BudgetResolverDeps {
  readonly repo: BudgetRepo;
  readonly discovery: BudgetDiscoveryRepo;
  readonly registry: ContributorRegistry;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, { extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type } });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

interface PageArgs {
  filter?: FilterInput;
  sort?: 'LINE_ORDER' | 'AMOUNT_DESC' | 'AMOUNT_ASC';
  first?: number;
  after?: string;
}

/** Build a Relay connection from a CursorPage (per-edge cursor bound to fhash). */
const toConnection = <T>(
  page: CursorPage<T>,
  spec: CollectionFilterSpec,
  filter: FilterInput,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[]
): { edges: { node: T; cursor: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } => {
  const fhash = fhashFor(spec, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort, dir, fhash, lastKeys: keysOf(node) }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
  };
};

const dirOf = (sort: string | undefined): 'asc' | 'desc' => (sort === 'AMOUNT_ASC' ? 'asc' : 'desc');

export const makeBudgetResolvers = (deps: BudgetResolverDeps): Record<string, unknown> => {
  const { repo, discovery, registry } = deps;

  // Batch + dedupe `Entity.budget` fan-out so an entity-list query is one MV probe
  // per distinct CUI per tick, not N (the profileSlice does several reads + a
  // top-categories aggregate). Goes through the SAME contributor usecase (§14.7).
  const budgetSliceLoader = makeBatchLoader<EntityProfileShape | null>(async (cuis) => {
    const entries = await Promise.all(
      cuis.map(async (cui) => {
        const slice = unwrap(await makeEntityProfileSlice(registry, 'budget', cui));
        return [cui, sliceToProfile(slice)] as const;
      })
    );
    return new Map(entries);
  }, null);

  return {
    Query: {
      budgetExecutionLineItem: async (
        _r: unknown,
        args: { year: number; reportType: ExecutionReportType; accountCategory: AccountCategory; id: string }
      ) => unwrap(await getExecutionLineItem(repo, args)),

      budgetExecutionLineItems: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const sort = args.sort ?? 'LINE_ORDER';
        const page = unwrap(
          await listExecutionLineItems(repo, {
            filter,
            sort,
            page: { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) },
          })
        );
        return toConnection(page, budgetFactFilterSpec, filter, sort, dirOf(sort), (n: ExecutionLineItem) =>
          sort === 'LINE_ORDER' ? [n.executionLineItemId] : [amountOf(n, filter), n.executionLineItemId]
        );
      },

      budgetCommitmentLineItems: async (
        _r: unknown,
        args: PageArgs & { metric?: CommitmentRankingMetric }
      ) => {
        const filter = args.filter ?? {};
        const sort = args.sort ?? 'LINE_ORDER';
        const metric = args.metric ?? 'plati_trezor';
        const page = unwrap(
          await listCommitmentLineItems(repo, {
            filter,
            metric,
            sort,
            page: { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) },
          })
        );
        return toConnection(page, budgetCommitmentFactFilterSpec, filter, sort, dirOf(sort), (n: CommitmentLineItem) =>
          sort === 'LINE_ORDER' ? [n.commitmentLineItemId] : [commitmentAmountOf(n, metric, filter), n.commitmentLineItemId]
        );
      },

      budgetEntitySummary: async (
        _r: unknown,
        args: { cui: string; year?: number; yearFrom?: number; yearTo?: number; frequency?: BudgetFrequency; reportType?: ExecutionReportType }
      ) =>
        unwrap(
          await getEntityBudget(repo, args.cui, {
            frequency: args.frequency ?? 'YEAR',
            ...(args.year !== undefined && { year: args.year }),
            ...(args.yearFrom !== undefined && { yearFrom: args.yearFrom }),
            ...(args.yearTo !== undefined && { yearTo: args.yearTo }),
            ...(args.reportType !== undefined && { reportType: args.reportType }),
          })
        ),

      budgetCommitmentSummary: async (
        _r: unknown,
        args: { cui: string; year?: number; yearFrom?: number; yearTo?: number; frequency?: BudgetFrequency; reportType?: CommitmentReportType }
      ) =>
        unwrap(
          await getEntityCommitments(repo, args.cui, {
            frequency: args.frequency ?? 'YEAR',
            ...(args.year !== undefined && { year: args.year }),
            ...(args.yearFrom !== undefined && { yearFrom: args.yearFrom }),
            ...(args.yearTo !== undefined && { yearTo: args.yearTo }),
            ...(args.reportType !== undefined && { reportType: args.reportType }),
          })
        ),

      budgetTimeseries: async (
        _r: unknown,
        args: { cui: string; reportType: ExecutionReportType; metric: BudgetRankingMetric; frequency: BudgetFrequency; yearFrom?: number; yearTo?: number; normalization?: BudgetNormalization }
      ) =>
        unwrap(
          await budgetTimeseries(repo, {
            entityCui: args.cui,
            reportType: args.reportType,
            metric: args.metric,
            frequency: args.frequency,
            normalization: args.normalization ?? 'TOTAL',
            ...(args.yearFrom !== undefined && { yearFrom: args.yearFrom }),
            ...(args.yearTo !== undefined && { yearTo: args.yearTo }),
          })
        ),

      budgetCommitmentTimeseries: async (
        _r: unknown,
        args: { cui: string; reportType: CommitmentReportType; metric: CommitmentRankingMetric; frequency: BudgetFrequency; yearFrom?: number; yearTo?: number }
      ) =>
        unwrap(
          await commitmentTimeseries(repo, {
            entityCui: args.cui,
            reportType: args.reportType,
            metric: args.metric,
            frequency: args.frequency,
            ...(args.yearFrom !== undefined && { yearFrom: args.yearFrom }),
            ...(args.yearTo !== undefined && { yearTo: args.yearTo }),
          })
        ),

      budgetEntityRanking: async (
        _r: unknown,
        args: { filter?: FilterInput; metric?: BudgetRankingMetric; normalization?: BudgetNormalization; ascending?: boolean; limit?: number }
      ) => {
        const ranking = parseRankingFilter(args.filter ?? {});
        return unwrap(
          await rankEntities(repo, {
            ...ranking,
            metric: args.metric ?? 'EXPENSE',
            normalization: args.normalization ?? 'TOTAL',
            ascending: args.ascending ?? false,
            limit: args.limit ?? 50,
          })
        );
      },

      budgetCommitmentRanking: async (
        _r: unknown,
        args: { year: number; reportType: CommitmentReportType; metric?: CommitmentRankingMetric; limit?: number }
      ) =>
        unwrap(
          await rankCommitmentEntities(repo, {
            year: args.year,
            reportType: args.reportType,
            metric: args.metric ?? 'plati_trezor',
            limit: args.limit ?? 50,
          })
        ),

      budgetAggregateByClassification: async (
        _r: unknown,
        args: { filter: FilterInput; normalization?: BudgetNormalization; minAmount?: string; maxAmount?: string; limit?: number }
      ) =>
        unwrap(
          await aggregateByClassification(repo, {
            filter: args.filter,
            normalization: args.normalization ?? 'TOTAL',
            limit: args.limit ?? 50,
            ...(args.minAmount !== undefined && { minAmount: args.minAmount }),
            ...(args.maxAmount !== undefined && { maxAmount: args.maxAmount }),
          })
        ),

      budgetCountyHeatmap: async (
        _r: unknown,
        args: { year: number; reportType: ExecutionReportType; metric?: BudgetRankingMetric; normalization?: BudgetNormalization }
      ) =>
        unwrap(
          await countyHeatmap(repo, {
            year: args.year,
            reportType: args.reportType,
            metric: args.metric ?? 'EXPENSE',
            normalization: args.normalization ?? 'TOTAL',
          })
        ),

      budgetReports: async (_r: unknown, args: { filter: FilterInput; page?: number; pageSize?: number }) =>
        unwrap(await listReports(repo, { filter: args.filter, page: args.page ?? 1, pageSize: args.pageSize ?? 20 })),
      budgetReport: async (_r: unknown, args: { reportId: string }) => unwrap(await repo.getReport(args.reportId)),

      budgetFunctionalClassifications: async (_r: unknown, args: { search?: string; codes?: string[]; limit?: number }) =>
        unwrap(await listFunctionalClassifications(repo, { limit: args.limit ?? 50, ...(args.search !== undefined && { search: args.search }), ...(args.codes !== undefined && { codes: args.codes }) })),
      budgetEconomicClassifications: async (_r: unknown, args: { search?: string; codes?: string[]; limit?: number }) =>
        unwrap(await listEconomicClassifications(repo, { limit: args.limit ?? 50, ...(args.search !== undefined && { search: args.search }), ...(args.codes !== undefined && { codes: args.codes }) })),
      budgetSectors: async (_r: unknown, args: { search?: string; ids?: number[] }) =>
        unwrap(await listBudgetSectors(repo, { ...(args.search !== undefined && { search: args.search }), ...(args.ids !== undefined && { ids: args.ids }) })),
      budgetFundingSources: async (_r: unknown, args: { search?: string; ids?: number[] }) =>
        unwrap(await listFundingSources(repo, { ...(args.search !== undefined && { search: args.search }), ...(args.ids !== undefined && { ids: args.ids }) })),

      budgetApprovedFacts: async (_r: unknown, args: { filter?: FilterInput; page?: number; pageSize?: number }) =>
        unwrap(await listApprovedBudgetFacts(repo, { filter: args.filter ?? {}, page: args.page ?? 1, pageSize: args.pageSize ?? 20 })),
      budgetVsExecution: async (_r: unknown, args: { budgetYear?: number; page?: number; pageSize?: number }) =>
        unwrap(await budgetVsExecution(repo, { page: args.page ?? 1, pageSize: args.pageSize ?? 20, ...(args.budgetYear !== undefined && { budgetYear: args.budgetYear }) })),

      budgetResolve: async (_r: unknown, args: { dim: BudgetResolveDim; q: string; limit?: number }) =>
        unwrap(await resolveBudgetFilter(discovery, args.dim, args.q, args.limit ?? 10)),
      budgetAsOf: async () => unwrap(await budgetAsOf(repo)),
    },

    // The summary view models carry a nested `period`; the SDL exposes flat
    // year/month/quarter — flatten via field resolvers (no second query).
    BudgetEntitySummary: {
      year: (p: { period: { year: number } }) => p.period.year,
      month: (p: { period: { month: number | null } }) => p.period.month,
      quarter: (p: { period: { quarter: number | null } }) => p.period.quarter,
    },
    BudgetCommitmentSummary: {
      year: (p: { period: { year: number } }) => p.period.year,
      month: (p: { period: { month: number | null } }) => p.period.month,
      quarter: (p: { period: { quarter: number | null } }) => p.period.quarter,
    },
    BudgetSeriesPoint: {
      year: (p: { period: { year: number } }) => p.period.year,
      month: (p: { period: { month: number | null } }) => p.period.month,
      quarter: (p: { period: { quarter: number | null } }) => p.period.quarter,
    },

    // `entity` lazy join: hand the kernel Entity resolver a { cui } so its own
    // field resolvers (organization/territory/flows/presence) take over by CUI.
    BudgetExecutionLineItem: {
      entity: (p: { entityCui: string | null }) => (p.entityCui !== null ? { cui: p.entityCui } : null),
    },
    BudgetCommitmentLineItem: {
      entity: (p: { entityCui: string | null }) => (p.entityCui !== null ? { cui: p.entityCui } : null),
    },
    BudgetRankedEntity: {
      entity: (p: { entityCui: string | null }) => (p.entityCui !== null ? { cui: p.entityCui } : null),
    },
    BudgetRankedCommitmentEntity: {
      entity: (p: { entityCui: string | null }) => (p.entityCui !== null ? { cui: p.entityCui } : null),
    },
    BudgetReport: {
      entity: (p: { entityCui: string | null }) => (p.entityCui !== null ? { cui: p.entityCui } : null),
    },

    Entity: {
      // Batched + deduped through the loader → contributor (§14.7 parity).
      budget: async (parent: { cui: string }): Promise<EntityProfileShape | null> =>
        budgetSliceLoader.load(parent.cui),
    },
  };
};

// ── small parse helpers ───────────────────────────────────────────────────────

interface EntityProfileShape {
  presence: boolean;
  latestYear: number | null;
  latestCompleteYear: number | null;
  reportType: string | null;
  totalIncome: string | null;
  totalExpense: string | null;
  budgetBalance: string | null;
  topExpenseCategories: unknown;
  refreshedAt: string | null;
}

/** Project a kernel profile slice into the GraphQL `BudgetEntityProfile` shape. */
const sliceToProfile = (slice: { data?: Record<string, unknown> } | null): EntityProfileShape => {
  const d = slice?.data;
  if (d === undefined) {
    return {
      presence: false,
      latestYear: null,
      latestCompleteYear: null,
      reportType: null,
      totalIncome: null,
      totalExpense: null,
      budgetBalance: null,
      topExpenseCategories: [],
      refreshedAt: null,
    };
  }
  return {
    presence: true,
    latestYear: (d['latestYear'] as number | null) ?? null,
    latestCompleteYear: (d['latestCompleteYear'] as number | null) ?? null,
    reportType: (d['reportType'] as string | null) ?? null,
    totalIncome: (d['totalIncome'] as string | null) ?? null,
    totalExpense: (d['totalExpense'] as string | null) ?? null,
    budgetBalance: (d['budgetBalance'] as string | null) ?? null,
    topExpenseCategories: d['topExpenseCategories'] ?? [],
    refreshedAt: (d['refreshedAt'] as string | null) ?? null,
  };
};

/** Pick the cursor amount for an execution node, by the active frequency. */
const amountOf = (n: ExecutionLineItem, filter: FilterInput): string => {
  const freq = readEq(filter, 'frequency') ?? 'YEAR';
  return freq === 'MONTH' ? n.monthlyAmount : freq === 'QUARTER' ? (n.quarterlyAmount ?? '') : n.ytdAmount;
};

/**
 * Pick the cursor amount for a commitment node — MUST mirror the repo's sort
 * column `${prefix}${metric}` (ytd/monthly/quarterly by the active frequency), or
 * the keyset cursor skips/duplicates rows across pages (R1 review).
 */
const commitmentAmountOf = (n: CommitmentLineItem, metric: CommitmentRankingMetric, filter: FilterInput): string => {
  const m = n[metricToField(metric)];
  const freq = readEq(filter, 'frequency') ?? 'YEAR';
  const v = freq === 'MONTH' ? m.monthly : freq === 'QUARTER' ? m.quarterly : m.ytd;
  return v ?? '';
};

const metricToField = (
  metric: CommitmentRankingMetric
): 'platiTrezor' | 'platiNonTrezor' | 'crediteAngajament' | 'receptiiTotale' => {
  switch (metric) {
    case 'plati_non_trezor':
      return 'platiNonTrezor';
    case 'credite_angajament':
      return 'crediteAngajament';
    case 'receptii_totale':
      return 'receptiiTotale';
    default:
      return 'platiTrezor';
  }
};

const readEq = (filter: FilterInput, name: string): string | undefined => {
  const f = filter[name];
  if (f === undefined || typeof f !== 'object') return undefined;
  const eq = (f as Record<string, unknown>)['eq'];
  return typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean' ? String(eq) : undefined;
};

/** Parse the ranking FilterInput (year/reportType + geo) into an EntityRankingQuery core. */
const parseRankingFilter = (
  filter: FilterInput
): {
  year: number;
  reportType: ExecutionReportType;
  countyCodes?: readonly string[];
  regions?: readonly string[];
  isUat?: boolean;
  minPopulation?: number;
  maxPopulation?: number;
} => {
  const yearStr = readEq(filter, 'year');
  const year = yearStr !== undefined ? Number(yearStr) : NaN;
  if (!Number.isInteger(year)) {
    throw new GraphQLError('ranking requires filter.year', { extensions: { code: 'INVALID_INPUT', type: 'InvalidInput' } });
  }
  const reportType = (readEq(filter, 'reportType') ?? 'EXECUTION_DETAILED') as ExecutionReportType;
  const counties = readIn(filter, 'countyCodes');
  const regions = readIn(filter, 'regions');
  const isUatStr = readEq(filter, 'isUat');
  const minPop = readEq(filter, 'minPopulation');
  const maxPop = readEq(filter, 'maxPopulation');
  return {
    year,
    reportType,
    ...(counties !== undefined && { countyCodes: counties }),
    ...(regions !== undefined && { regions }),
    ...(isUatStr !== undefined && { isUat: isUatStr === 'true' }),
    ...(minPop !== undefined && Number.isFinite(Number(minPop)) && { minPopulation: Number(minPop) }),
    ...(maxPop !== undefined && Number.isFinite(Number(maxPop)) && { maxPopulation: Number(maxPop) }),
  };
};

const readIn = (filter: FilterInput, name: string): readonly string[] | undefined => {
  const f = filter[name];
  if (f === undefined || typeof f !== 'object') return undefined;
  const v = (f as Record<string, unknown>)['in'];
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
};
