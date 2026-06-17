/**
 * MCP Use Case: query_procurement_filters
 *
 * Answers public-contract aggregate questions from deterministic production
 * rollups. Generated LLM metadata is intentionally excluded from this path.
 */

import { err, ok, type Result } from 'neverthrow';

import { databaseError, invalidInputError, type McpError } from '../errors.js';

import type { McpProcurementRepo } from '../ports.js';
import type {
  QueryProcurementFiltersInput,
  QueryProcurementFiltersOutput,
} from '../schemas/tools.js';
import type {
  ProcurementAggregateQuality,
  ProcurementAnswerClass,
  ProcurementCapabilityAnswerClass,
  ProcurementFilterCapability,
  ProcurementFilterQuery,
} from '../types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface QueryProcurementFiltersDeps {
  procurementRepo: McpProcurementRepo;
}

interface NormalizedProcurementInput extends ProcurementFilterQuery {
  analysis: QueryProcurementFiltersInput['analysis'];
}

interface RequiredCapabilityCheck {
  readonly answerClass: ProcurementCapabilityAnswerClass;
  readonly dimensions: string[];
}

export async function queryProcurementFilters(
  deps: QueryProcurementFiltersDeps,
  input: QueryProcurementFiltersInput
): Promise<Result<QueryProcurementFiltersOutput, McpError>> {
  const normalized = normalizeInput(input);
  if (normalized.isErr()) {
    return err(normalized.error);
  }

  const query = normalized.value;
  const qualityResult = await deps.procurementRepo.getAggregateQuality([query.sourceGrain]);
  if (qualityResult.isErr()) {
    return err(qualityResult.error);
  }

  const quality = qualityResult.value.find((item) => item.sourceGrain === query.sourceGrain);
  if (quality === undefined) {
    return err(databaseError(`Missing procurement quality gate for ${query.sourceGrain}`));
  }

  const capabilitiesResult = await deps.procurementRepo.getFilterCapabilities([query.sourceGrain]);
  if (capabilitiesResult.isErr()) {
    return err(capabilitiesResult.error);
  }

  const requiredCapabilities = requiredCapabilityChecks(query);
  const capabilityGate = resolveCapabilityGate(
    capabilitiesResult.value,
    query.sourceGrain,
    requiredCapabilities
  );
  if (capabilityGate.isErr()) {
    return err(capabilityGate.error);
  }

  const answerClass = resolveAnswerClass(query);
  const capabilities = capabilityGate.value.capabilities;
  const caveats = buildCaveats(query, capabilities);
  const abstentionReason = resolveAbstentionReason(quality, answerClass);
  if (abstentionReason !== null) {
    return ok({
      ok: true,
      answerClass,
      capabilities,
      caveats,
      quality,
      query,
      rows: [],
      status: 'abstained',
      summary: abstentionReason,
    });
  }

  if (capabilityGate.value.abstentionReason !== null) {
    return ok({
      ok: true,
      answerClass,
      capabilities,
      caveats,
      quality,
      query,
      rows: [],
      status: 'abstained',
      summary: capabilityGate.value.abstentionReason,
    });
  }

  const rowsResult =
    query.analysis === 'top_suppliers'
      ? await deps.procurementRepo.rankSuppliers(query)
      : query.analysis === 'category_breakdown'
        ? await deps.procurementRepo.rankCpvDivisions(query)
        : await deps.procurementRepo.listSameDayDirectAcquisitionCandidates(query);

  if (rowsResult.isErr()) {
    return err(rowsResult.error);
  }

  return ok({
    ok: true,
    answerClass,
    capabilities,
    caveats,
    quality,
    query,
    rows: rowsResult.value,
    status: 'allowed',
    summary: buildSummary(query, rowsResult.value.length),
  });
}

function normalizeInput(
  input: QueryProcurementFiltersInput
): Result<NormalizedProcurementInput, McpError> {
  const sourceGrain = input.sourceGrain ?? 'direct_acquisition';
  const rankBy = input.rankBy ?? 'amount_ron';
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  if (
    input.analysis === 'same_day_direct_acquisition_candidates' &&
    sourceGrain !== 'direct_acquisition'
  ) {
    return err(
      invalidInputError('same_day_direct_acquisition_candidates only supports direct_acquisition')
    );
  }

  if (input.cpvDivisionCode !== undefined && !/^[0-9]{2}$/.test(input.cpvDivisionCode.trim())) {
    return err(invalidInputError('cpvDivisionCode must be a two-digit CPV division'));
  }

  if (
    input.yearStart !== undefined &&
    input.yearEnd !== undefined &&
    input.yearStart > input.yearEnd
  ) {
    return err(invalidInputError('yearStart must be less than or equal to yearEnd'));
  }

  if (!hasScopedFilter(input)) {
    return err(
      invalidInputError(
        'At least one of authorityCui, authorityCountyCode, authorityRegion, or cpvDivisionCode is required'
      )
    );
  }

  return ok({
    analysis: input.analysis,
    limit,
    rankBy,
    sourceGrain,
    ...(input.authorityCountyCode !== undefined && {
      authorityCountyCode: input.authorityCountyCode.trim(),
    }),
    ...(input.authorityCui !== undefined && {
      authorityCui: input.authorityCui.trim(),
    }),
    ...(input.authorityRegion !== undefined && {
      authorityRegion: input.authorityRegion.trim(),
    }),
    ...(input.cpvDivisionCode !== undefined && {
      cpvDivisionCode: input.cpvDivisionCode.trim(),
    }),
    ...(input.yearEnd !== undefined && { yearEnd: input.yearEnd }),
    ...(input.yearStart !== undefined && { yearStart: input.yearStart }),
  });
}

function hasScopedFilter(input: QueryProcurementFiltersInput): boolean {
  return (
    input.authorityCui !== undefined ||
    input.authorityCountyCode !== undefined ||
    input.authorityRegion !== undefined ||
    input.cpvDivisionCode !== undefined
  );
}

function resolveAnswerClass(query: NormalizedProcurementInput): ProcurementAnswerClass {
  if (query.analysis === 'same_day_direct_acquisition_candidates') {
    return 'review_signal';
  }
  return query.rankBy === 'amount_ron' ? 'spend_ranking' : 'filter';
}

function requiredCapabilityChecks(query: NormalizedProcurementInput): RequiredCapabilityCheck[] {
  if (query.analysis === 'same_day_direct_acquisition_candidates') {
    return [
      {
        answerClass: 'same_day_direct_acquisition_signal',
        dimensions: queryDimensions(query, 'candidate_date', false),
      },
    ];
  }

  const required: RequiredCapabilityCheck[] = [
    {
      answerClass: query.rankBy === 'amount_ron' ? 'spend_ranked_top_n' : 'count_ranked_top_n',
      dimensions: queryDimensions(query, 'month_start', true),
    },
  ];

  if (query.authorityCountyCode !== undefined || query.authorityRegion !== undefined) {
    required.push({
      answerClass: 'buyer_region_filter',
      dimensions: buyerRegionDimensions(query),
    });
  }
  if (query.cpvDivisionCode !== undefined) {
    required.push({
      answerClass: 'cpv_category_filter',
      dimensions: ['cpv_division_code'],
    });
  }

  return required;
}

function queryDimensions(
  query: NormalizedProcurementInput,
  dateDimension: 'candidate_date' | 'month_start',
  includeSourceGrain: boolean
): string[] {
  const dimensions: string[] = includeSourceGrain ? ['source_grain'] : [];
  if (query.authorityCui !== undefined) {
    dimensions.push('authority_cui');
  }
  if (query.authorityCountyCode !== undefined) {
    dimensions.push('authority_county_code');
  }
  if (query.authorityRegion !== undefined) {
    dimensions.push('authority_region');
  }
  if (query.cpvDivisionCode !== undefined) {
    dimensions.push('cpv_division_code');
  }
  if (query.yearStart !== undefined || query.yearEnd !== undefined) {
    dimensions.push(dateDimension);
  }
  return dimensions;
}

function buyerRegionDimensions(query: NormalizedProcurementInput): string[] {
  return [
    ...(query.authorityCountyCode !== undefined ? ['authority_county_code'] : []),
    ...(query.authorityRegion !== undefined ? ['authority_region'] : []),
  ];
}

function resolveCapabilityGate(
  capabilities: readonly ProcurementFilterCapability[],
  sourceGrain: ProcurementFilterQuery['sourceGrain'],
  required: readonly RequiredCapabilityCheck[]
): Result<
  {
    readonly abstentionReason: string | null;
    readonly capabilities: ProcurementFilterCapability[];
  },
  McpError
> {
  const selected: ProcurementFilterCapability[] = [];
  for (const check of required) {
    const matches = capabilities.filter(
      (candidate) =>
        candidate.sourceGrain === sourceGrain && candidate.answerClass === check.answerClass
    );
    if (matches.length > 1) {
      return err(
        databaseError(`Duplicate procurement capability ${sourceGrain}/${check.answerClass}`)
      );
    }
    const capability = matches[0];
    if (capability === undefined) {
      return err(
        databaseError(`Missing procurement capability ${sourceGrain}/${check.answerClass}`)
      );
    }
    selected.push(capability);
  }

  const blocked = selected.find((capability) => !capability.allowed);
  if (blocked === undefined) {
    const dimensionBlocker = selected
      .map((capability) => {
        const check = required.find(
          (candidate) => candidate.answerClass === capability.answerClass
        );
        const missingDimension = check?.dimensions.find(
          (dimension) => !capability.allowedDimensions.includes(dimension)
        );
        return missingDimension === undefined ? null : { capability, dimension: missingDimension };
      })
      .find((item) => item !== null);

    if (dimensionBlocker !== undefined) {
      return ok({
        abstentionReason: `Abstained: procurement capability ${dimensionBlocker.capability.sourceGrain}/${dimensionBlocker.capability.answerClass} does not approve dimension ${dimensionBlocker.dimension}.`,
        capabilities: selected,
      });
    }

    return ok({ abstentionReason: null, capabilities: selected });
  }

  const blockers = blocked.blockers.length > 0 ? `: ${blocked.blockers.join('; ')}` : '.';
  return ok({
    abstentionReason: `Abstained: procurement capability ${blocked.sourceGrain}/${blocked.answerClass} is not approved${blockers}`,
    capabilities: selected,
  });
}

function resolveAbstentionReason(
  quality: ProcurementAggregateQuality,
  answerClass: ProcurementAnswerClass
): string | null {
  if (!quality.filterAnswersAllowed) {
    return `Abstained: deterministic filter coverage is not approved for ${quality.sourceGrain}.`;
  }

  if (answerClass === 'spend_ranking' && !quality.spendRankingsAllowed) {
    return `Abstained: spend rankings are not approved for ${quality.sourceGrain}; use rankBy=flow_count or narrow the question.`;
  }

  return null;
}

function buildCaveats(
  query: NormalizedProcurementInput,
  capabilities: readonly ProcurementFilterCapability[]
): string[] {
  return [
    'Results come from deterministic procurement rollups over flows.money_flows; LLM-generated metadata is not used for authoritative filters.',
    'Authority region/county filters describe the buyer/public institution territory, not supplier headquarters.',
    ...capabilities.flatMap((capability) => capability.caveats),
    ...(query.analysis === 'same_day_direct_acquisition_candidates'
      ? ['Same-day direct-acquisition candidates are review signals, not findings of illegality.']
      : []),
  ];
}

function buildSummary(query: NormalizedProcurementInput, rowCount: number): string {
  if (query.analysis === 'top_suppliers') {
    return `Returned ${String(rowCount)} supplier aggregate rows for ${query.sourceGrain}.`;
  }
  if (query.analysis === 'category_breakdown') {
    return `Returned ${String(rowCount)} CPV division aggregate rows for ${query.sourceGrain}.`;
  }
  return `Returned ${String(rowCount)} same-day direct-acquisition candidate rows.`;
}
