import {
  COMMITMENTS_REPORT_TYPE_BY_GQL,
  type CommitmentsMetric,
  type DbCommitmentsReportType,
  type GqlCommitmentsReportType,
} from '@/common/types/commitments.js';
import { Frequency } from '@/common/types/temporal.js';
import {
  resolveNormalizationRequest,
  type GqlNormalization,
  type NormalizationService,
  type PopulationRepository,
} from '@/modules/normalization/index.js';

import { getCommitmentVsExecution } from '../../core/usecases/get-commitment-vs-execution.js';
import { getCommitmentsAggregated } from '../../core/usecases/get-commitments-aggregated.js';
import { getCommitmentsAnalytics } from '../../core/usecases/get-commitments-analytics.js';
import { getCommitmentsLineItems } from '../../core/usecases/get-commitments-line-items.js';
import { getCommitmentsSummary } from '../../core/usecases/get-commitments-summary.js';

import type { CommitmentsRepository } from '../../core/ports.js';
import type {
  CommitmentsAggregatedInput,
  CommitmentsFilter,
  CommitmentsLineItem,
  CommitmentsSummaryResult,
  CommitmentExecutionComparisonInput,
} from '../../core/types.js';
import type { Currency, PeriodDate, PeriodType } from '@/common/types/analytics.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ============================================================================
// Deps
// ============================================================================

export interface MakeCommitmentsResolversDeps {
  repo: CommitmentsRepository;
  normalizationService: NormalizationService;
  populationRepo: PopulationRepository;
}

// ============================================================================
// GraphQL Input Types
// ============================================================================

interface GraphQLReportPeriodInput {
  type: 'MONTH' | 'QUARTER' | 'YEAR';
  selection: {
    interval?: { start: string; end: string } | undefined;
    dates?: string[] | undefined;
  };
}

interface GraphQLCommitmentsExcludeInput {
  report_ids?: string[] | undefined;
  entity_cuis?: string[] | undefined;
  main_creditor_cui?: string | undefined;

  functional_codes?: string[] | undefined;
  functional_prefixes?: string[] | undefined;
  economic_codes?: string[] | undefined;
  economic_prefixes?: string[] | undefined;

  funding_source_ids?: string[] | undefined;
  budget_sector_ids?: string[] | undefined;

  county_codes?: string[] | undefined;
  regions?: string[] | undefined;
  uat_ids?: string[] | undefined;
  entity_types?: string[] | undefined;
}

interface GraphQLCommitmentsFilterInput {
  report_period: GraphQLReportPeriodInput;
  report_type?: GqlCommitmentsReportType | undefined;

  entity_cuis?: string[] | undefined;
  main_creditor_cui?: string | undefined;
  entity_types?: string[] | undefined;
  is_uat?: boolean | undefined;
  search?: string | undefined;

  functional_codes?: string[] | undefined;
  functional_prefixes?: string[] | undefined;
  economic_codes?: string[] | undefined;
  economic_prefixes?: string[] | undefined;

  funding_source_ids?: string[] | undefined;
  budget_sector_ids?: string[] | undefined;

  county_codes?: string[] | undefined;
  regions?: string[] | undefined;
  uat_ids?: string[] | undefined;

  min_population?: number | undefined;
  max_population?: number | undefined;

  aggregate_min_amount?: number | undefined;
  aggregate_max_amount?: number | undefined;
  item_min_amount?: number | undefined;
  item_max_amount?: number | undefined;

  normalization?: GqlNormalization | undefined;
  currency?: Currency | undefined;
  inflation_adjusted?: boolean | undefined;
  show_period_growth?: boolean | undefined;

  exclude?: GraphQLCommitmentsExcludeInput | undefined;
  exclude_transfers?: boolean | undefined;
}

interface CommitmentsSummaryQueryArgs {
  filter: GraphQLCommitmentsFilterInput;
  limit?: number;
  offset?: number;
}

interface CommitmentsLineItemsQueryArgs {
  filter: GraphQLCommitmentsFilterInput;
  limit?: number;
  offset?: number;
}

interface CommitmentsAnalyticsQueryArgs {
  inputs: {
    filter: GraphQLCommitmentsFilterInput;
    metric: CommitmentsMetric;
    seriesId?: string | undefined;
  }[];
}

interface CommitmentsAggregatedQueryArgs {
  input: {
    filter: GraphQLCommitmentsFilterInput;
    metric: CommitmentsMetric;
    limit?: number;
    offset?: number;
  };
}

interface CommitmentVsExecutionQueryArgs {
  input: {
    filter: GraphQLCommitmentsFilterInput;
    commitments_metric?: CommitmentsMetric | undefined;
  };
}

// ============================================================================
// Helpers
// ============================================================================

const GQL_REPORT_TYPE_BY_DB: Record<DbCommitmentsReportType, GqlCommitmentsReportType> = {
  'Executie - Angajamente bugetare detaliat': 'DETAILED',
  'Executie - Angajamente bugetare agregat principal': 'PRINCIPAL_AGGREGATED',
  'Executie - Angajamente bugetare agregat secundar': 'SECONDARY_AGGREGATED',
};

const mapPeriodType = (type: PeriodType): Frequency => {
  switch (type) {
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
    case 'YEAR':
      return Frequency.YEAR;
  }
};

const toDomainExclude = (
  input: GraphQLCommitmentsExcludeInput | undefined
): CommitmentsFilter['exclude'] => {
  if (input === undefined) return undefined;

  const out: NonNullable<CommitmentsFilter['exclude']> = {};

  if (input.report_ids !== undefined) out.report_ids = input.report_ids;
  if (input.entity_cuis !== undefined) out.entity_cuis = input.entity_cuis;
  if (input.main_creditor_cui !== undefined) out.main_creditor_cui = input.main_creditor_cui;

  if (input.functional_codes !== undefined) out.functional_codes = input.functional_codes;
  if (input.functional_prefixes !== undefined) out.functional_prefixes = input.functional_prefixes;
  if (input.economic_codes !== undefined) out.economic_codes = input.economic_codes;
  if (input.economic_prefixes !== undefined) out.economic_prefixes = input.economic_prefixes;

  if (input.funding_source_ids !== undefined) out.funding_source_ids = input.funding_source_ids;
  if (input.budget_sector_ids !== undefined) out.budget_sector_ids = input.budget_sector_ids;

  if (input.county_codes !== undefined) out.county_codes = input.county_codes;
  if (input.regions !== undefined) out.regions = input.regions;
  if (input.uat_ids !== undefined) out.uat_ids = input.uat_ids;
  if (input.entity_types !== undefined) out.entity_types = input.entity_types;

  return Object.keys(out).length > 0 ? out : undefined;
};

const toDomainFilter = (input: GraphQLCommitmentsFilterInput): CommitmentsFilter => {
  const reportPeriod = input.report_period;

  const normRequest = resolveNormalizationRequest({
    normalization: input.normalization ?? null,
    currency: input.currency ?? null,
    inflationAdjusted: input.inflation_adjusted ?? null,
    showPeriodGrowth: input.show_period_growth ?? null,
  });

  const reportTypeDb =
    input.report_type !== undefined ? COMMITMENTS_REPORT_TYPE_BY_GQL[input.report_type] : undefined;

  const selection =
    reportPeriod.selection.interval !== undefined
      ? {
          interval: {
            start: reportPeriod.selection.interval.start as PeriodDate,
            end: reportPeriod.selection.interval.end as PeriodDate,
          },
        }
      : {
          dates: (reportPeriod.selection.dates ??
            []) as unknown as PeriodDate[] satisfies PeriodDate[],
        };

  const exclude = toDomainExclude(input.exclude);

  return {
    report_period: {
      type: mapPeriodType(reportPeriod.type as unknown as PeriodType),
      selection,
    },
    ...(reportTypeDb !== undefined && { report_type: reportTypeDb }),

    ...(input.entity_cuis !== undefined && { entity_cuis: input.entity_cuis }),
    ...(input.main_creditor_cui !== undefined && { main_creditor_cui: input.main_creditor_cui }),
    ...(input.entity_types !== undefined && { entity_types: input.entity_types }),
    ...(input.is_uat !== undefined && { is_uat: input.is_uat }),
    ...(input.search !== undefined && { search: input.search }),

    ...(input.functional_codes !== undefined && { functional_codes: input.functional_codes }),
    ...(input.functional_prefixes !== undefined && {
      functional_prefixes: input.functional_prefixes,
    }),
    ...(input.economic_codes !== undefined && { economic_codes: input.economic_codes }),
    ...(input.economic_prefixes !== undefined && { economic_prefixes: input.economic_prefixes }),

    ...(input.funding_source_ids !== undefined && { funding_source_ids: input.funding_source_ids }),
    ...(input.budget_sector_ids !== undefined && { budget_sector_ids: input.budget_sector_ids }),

    ...(input.county_codes !== undefined && { county_codes: input.county_codes }),
    ...(input.regions !== undefined && { regions: input.regions }),
    ...(input.uat_ids !== undefined && { uat_ids: input.uat_ids }),

    ...(input.min_population !== undefined && { min_population: input.min_population }),
    ...(input.max_population !== undefined && { max_population: input.max_population }),

    ...(input.aggregate_min_amount !== undefined && {
      aggregate_min_amount: input.aggregate_min_amount,
    }),
    ...(input.aggregate_max_amount !== undefined && {
      aggregate_max_amount: input.aggregate_max_amount,
    }),
    ...(input.item_min_amount !== undefined && { item_min_amount: input.item_min_amount }),
    ...(input.item_max_amount !== undefined && { item_max_amount: input.item_max_amount }),

    normalization: normRequest.normalization,
    currency: normRequest.currency,
    inflation_adjusted: normRequest.inflationAdjusted,
    show_period_growth: normRequest.showPeriodGrowth,
    ...(exclude !== undefined && { exclude }),
    exclude_transfers: input.exclude_transfers ?? true,
  };
};

const toGqlSummaryResult = (row: CommitmentsSummaryResult) => {
  if (row.__typename === 'CommitmentsMonthlySummary') {
    return {
      __typename: row.__typename,
      year: row.year,
      month: row.month,
      entity_cui: row.entity_cui,
      entity_name: row.entity_name,
      main_creditor_cui: row.main_creditor_cui,
      report_type: GQL_REPORT_TYPE_BY_DB[row.report_type],
      credite_angajament: row.credite_angajament.toNumber(),
      plati_trezor: row.plati_trezor.toNumber(),
      plati_non_trezor: row.plati_non_trezor.toNumber(),
      receptii_totale: row.receptii_totale.toNumber(),
      receptii_neplatite_change: row.receptii_neplatite_change.toNumber(),
      total_plati: row.total_plati.toNumber(),
    };
  }

  if (row.__typename === 'CommitmentsQuarterlySummary') {
    return {
      __typename: row.__typename,
      year: row.year,
      quarter: row.quarter,
      entity_cui: row.entity_cui,
      entity_name: row.entity_name,
      main_creditor_cui: row.main_creditor_cui,
      report_type: GQL_REPORT_TYPE_BY_DB[row.report_type],

      credite_angajament: row.credite_angajament.toNumber(),
      limita_credit_angajament: row.limita_credit_angajament.toNumber(),
      credite_bugetare: row.credite_bugetare.toNumber(),
      credite_angajament_initiale: row.credite_angajament_initiale.toNumber(),
      credite_bugetare_initiale: row.credite_bugetare_initiale.toNumber(),
      credite_angajament_definitive: row.credite_angajament_definitive.toNumber(),
      credite_bugetare_definitive: row.credite_bugetare_definitive.toNumber(),
      credite_angajament_disponibile: row.credite_angajament_disponibile.toNumber(),
      credite_bugetare_disponibile: row.credite_bugetare_disponibile.toNumber(),
      receptii_totale: row.receptii_totale.toNumber(),
      plati_trezor: row.plati_trezor.toNumber(),
      plati_non_trezor: row.plati_non_trezor.toNumber(),
      receptii_neplatite: row.receptii_neplatite.toNumber(),

      total_plati: row.total_plati.toNumber(),
      execution_rate: row.execution_rate !== null ? row.execution_rate.toNumber() : null,
      commitment_rate: row.commitment_rate !== null ? row.commitment_rate.toNumber() : null,
    };
  }

  return {
    __typename: row.__typename,
    year: row.year,
    entity_cui: row.entity_cui,
    entity_name: row.entity_name,
    main_creditor_cui: row.main_creditor_cui,
    report_type: GQL_REPORT_TYPE_BY_DB[row.report_type],

    credite_angajament: row.credite_angajament.toNumber(),
    limita_credit_angajament: row.limita_credit_angajament.toNumber(),
    credite_bugetare: row.credite_bugetare.toNumber(),
    credite_angajament_initiale: row.credite_angajament_initiale.toNumber(),
    credite_bugetare_initiale: row.credite_bugetare_initiale.toNumber(),
    credite_angajament_definitive: row.credite_angajament_definitive.toNumber(),
    credite_bugetare_definitive: row.credite_bugetare_definitive.toNumber(),
    credite_angajament_disponibile: row.credite_angajament_disponibile.toNumber(),
    credite_bugetare_disponibile: row.credite_bugetare_disponibile.toNumber(),
    receptii_totale: row.receptii_totale.toNumber(),
    plati_trezor: row.plati_trezor.toNumber(),
    plati_non_trezor: row.plati_non_trezor.toNumber(),
    receptii_neplatite: row.receptii_neplatite.toNumber(),

    total_plati: row.total_plati.toNumber(),
    execution_rate: row.execution_rate !== null ? row.execution_rate.toNumber() : null,
    commitment_rate: row.commitment_rate !== null ? row.commitment_rate.toNumber() : null,
  };
};

const toGqlLineItem = (item: CommitmentsLineItem) => ({
  id: item.line_item_id,
  year: item.year,
  month: item.month,
  report_type: GQL_REPORT_TYPE_BY_DB[item.report_type],
  entity_cui: item.entity_cui,
  entity_name: item.entity_name,
  main_creditor_cui: item.main_creditor_cui,
  budget_sector_id: item.budget_sector_id,
  budget_sector_name: item.budget_sector_name,
  funding_source_id: item.funding_source_id,
  funding_source_name: item.funding_source_name,
  functional_code: item.functional_code,
  functional_name: item.functional_name,
  economic_code: item.economic_code,
  economic_name: item.economic_name,

  credite_angajament: item.credite_angajament.toNumber(),
  limita_credit_angajament: item.limita_credit_angajament.toNumber(),
  credite_bugetare: item.credite_bugetare.toNumber(),
  credite_angajament_initiale: item.credite_angajament_initiale.toNumber(),
  credite_bugetare_initiale: item.credite_bugetare_initiale.toNumber(),
  credite_angajament_definitive: item.credite_angajament_definitive.toNumber(),
  credite_bugetare_definitive: item.credite_bugetare_definitive.toNumber(),
  credite_angajament_disponibile: item.credite_angajament_disponibile.toNumber(),
  credite_bugetare_disponibile: item.credite_bugetare_disponibile.toNumber(),
  receptii_totale: item.receptii_totale.toNumber(),
  plati_trezor: item.plati_trezor.toNumber(),
  plati_non_trezor: item.plati_non_trezor.toNumber(),
  receptii_neplatite: item.receptii_neplatite.toNumber(),

  monthly_plati_trezor: item.monthly_plati_trezor.toNumber(),
  monthly_plati_non_trezor: item.monthly_plati_non_trezor.toNumber(),
  monthly_receptii_totale: item.monthly_receptii_totale.toNumber(),
  monthly_receptii_neplatite_change: item.monthly_receptii_neplatite_change.toNumber(),
  monthly_credite_angajament: item.monthly_credite_angajament.toNumber(),

  is_quarterly: item.is_quarterly,
  quarter: item.quarter,
  is_yearly: item.is_yearly,
  anomaly: item.anomaly,
});

// ============================================================================
// Resolver Factory
// ============================================================================

export const makeCommitmentsResolvers = (deps: MakeCommitmentsResolversDeps): IResolvers => {
  const { repo, normalizationService, populationRepo } = deps;

  return {
    CommitmentsSummaryResult: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL union resolution hook.
      __resolveType: (obj: unknown) => {
        if (typeof obj !== 'object' || obj === null) return null;
        const typename = (obj as Record<string, unknown>)['__typename'];
        return typeof typename === 'string' ? typename : null;
      },
    },
    Query: {
      commitmentsSummary: async (
        _parent: unknown,
        args: CommitmentsSummaryQueryArgs,
        context: MercuriusContext
      ) => {
        const filter = toDomainFilter(args.filter);

        const result = await getCommitmentsSummary(
          { repo, normalization: normalizationService },
          {
            filter,
            limit: args.limit,
            offset: args.offset,
          }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, filter: args.filter },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return {
          nodes: result.value.nodes.map(toGqlSummaryResult),
          pageInfo: result.value.pageInfo,
        };
      },

      commitmentsLineItems: async (
        _parent: unknown,
        args: CommitmentsLineItemsQueryArgs,
        context: MercuriusContext
      ) => {
        const filter = toDomainFilter(args.filter);

        const result = await getCommitmentsLineItems(
          { repo, normalization: normalizationService },
          { filter, limit: args.limit, offset: args.offset }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, filter: args.filter },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return {
          nodes: result.value.nodes.map(toGqlLineItem),
          pageInfo: result.value.pageInfo,
        };
      },

      commitmentsAnalytics: async (
        _parent: unknown,
        args: CommitmentsAnalyticsQueryArgs,
        context: MercuriusContext
      ) => {
        const inputs = args.inputs.map((i) => ({
          filter: toDomainFilter(i.filter),
          metric: i.metric,
          ...(i.seriesId !== undefined && { seriesId: i.seriesId }),
        }));

        const result = await getCommitmentsAnalytics(
          { repo, normalization: normalizationService, populationRepo },
          inputs
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, inputs: args.inputs },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },

      commitmentsAggregated: async (
        _parent: unknown,
        args: CommitmentsAggregatedQueryArgs,
        context: MercuriusContext
      ) => {
        const input: CommitmentsAggregatedInput = {
          filter: toDomainFilter(args.input.filter),
          metric: args.input.metric,
          limit: args.input.limit ?? 50,
          offset: args.input.offset ?? 0,
        };

        const result = await getCommitmentsAggregated(
          { repo, normalization: normalizationService, populationRepo },
          input
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, input: args.input },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return {
          nodes: result.value.nodes.map((n) => ({
            functional_code: n.functional_code,
            functional_name: n.functional_name,
            economic_code: n.economic_code,
            economic_name: n.economic_name,
            amount: n.amount.toNumber(),
            count: n.count,
          })),
          pageInfo: result.value.pageInfo,
        };
      },

      commitmentVsExecution: async (
        _parent: unknown,
        args: CommitmentVsExecutionQueryArgs,
        context: MercuriusContext
      ) => {
        const input: CommitmentExecutionComparisonInput = {
          filter: toDomainFilter(args.input.filter),
          commitments_metric: args.input.commitments_metric ?? 'PLATI_TREZOR',
        };

        const result = await getCommitmentVsExecution(
          { repo, normalization: normalizationService, populationRepo },
          input
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, input: args.input },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return {
          frequency: result.value.frequency,
          data: result.value.data.map((p) => ({
            period: p.period,
            commitment_value: p.commitment_value.toNumber(),
            execution_value: p.execution_value.toNumber(),
            difference: p.difference.toNumber(),
            difference_percent:
              p.difference_percent !== null ? p.difference_percent.toNumber() : null,
            commitment_growth_percent:
              p.commitment_growth_percent !== undefined && p.commitment_growth_percent !== null
                ? p.commitment_growth_percent.toNumber()
                : null,
            execution_growth_percent:
              p.execution_growth_percent !== undefined && p.execution_growth_percent !== null
                ? p.execution_growth_percent.toNumber()
                : null,
            difference_growth_percent:
              p.difference_growth_percent !== undefined && p.difference_growth_percent !== null
                ? p.difference_growth_percent.toNumber()
                : null,
          })),
          total_commitment: result.value.total_commitment.toNumber(),
          total_execution: result.value.total_execution.toNumber(),
          total_difference: result.value.total_difference.toNumber(),
          overall_difference_percent:
            result.value.overall_difference_percent !== null
              ? result.value.overall_difference_percent.toNumber()
              : null,
          matched_count: result.value.matched_count,
          unmatched_commitment_count: result.value.unmatched_commitment_count,
          unmatched_execution_count: result.value.unmatched_execution_count,
        };
      },
    },
  };
};
