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

  const answerClass = resolveAnswerClass(query);
  const abstentionReason = resolveAbstentionReason(quality, answerClass);
  if (abstentionReason !== null) {
    return ok({
      ok: true,
      answerClass,
      caveats: buildCaveats(query),
      quality,
      query,
      rows: [],
      status: 'abstained',
      summary: abstentionReason,
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
    caveats: buildCaveats(query),
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
        'At least one of authorityCui, authorityCountyCode, authorityRegion, cpvDivisionCode, yearStart, or yearEnd is required'
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

function buildCaveats(query: NormalizedProcurementInput): string[] {
  return [
    'Results come from deterministic procurement rollups over flows.money_flows; LLM-generated metadata is not used for authoritative filters.',
    'Authority region/county filters describe the buyer/public institution territory, not supplier headquarters.',
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
