/**
 * Legacy dimension usecases: argument validation, the legacy clamps, and the
 * legacy `pageInfo` formulas — reproduced per root because the client compares
 * them byte for byte:
 *  - sectors / funding sources: `hasNextPage = offset + limit < totalCount`
 *    (budget-sector-repo.ts:105, funding-sources-repo.ts:109);
 *  - classifications: `hasNextPage = offset + rows.length < totalCount`
 *    (classification-repo.ts:129).
 * `hasPreviousPage = offset > 0` everywhere.
 *
 * Documented deltas (design 13 §1 "fix the bugs, document every difference"):
 *  - non-integer `[ID!]` values are `InvalidInput` (legacy silently dropped them
 *    and widened the result — design 13 §7 delta 11 policy);
 *  - `totalCount` when the page is empty is the real count (legacy sectors /
 *    funding sources answered 0 for an offset past the end);
 *  - the FUNCTIONAL classification count uses the same predicate as the rows
 *    (legacy counted `contains` matches while listing `prefix` matches for a
 *    code-like search; the economic repo was already consistent);
 *  - an explicit `null` for `filter`, `search` or a code/id list means "no
 *    filter" (the SDL allows the null); legacy answered `Internal server error`
 *    (it called `.trim()` / `.length` on the null — codex r2 probe 2026-09-02).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  LEGACY_CLASSIFICATIONS_DEFAULT_LIMIT,
  LEGACY_CLASSIFICATIONS_MAX_LIMIT,
  LEGACY_FUNDING_SOURCES_DEFAULT_LIMIT,
  LEGACY_FUNDING_SOURCES_MAX_LIMIT,
  LEGACY_SECTORS_DEFAULT_LIMIT,
  LEGACY_SECTORS_MAX_LIMIT,
  type LegacyClassification,
  type LegacyClassificationKind,
  type LegacyClassificationPageInput,
  type LegacyDimensionPageInput,
  type LegacyFundingSource,
  type LegacyPage,
  type LegacySector,
} from './types.js';

import type { LegacyDimensionRepo } from './ports.js';

const clampLimit = (limit: number | null | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(1, limit ?? fallback), max);

const clampOffset = (offset: number | null | undefined): number => Math.max(0, offset ?? 0);

const parseIds = (
  ids: readonly string[] | null | undefined,
  field: string
): Result<readonly number[] | undefined, ApiError> => {
  if (ids === undefined || ids === null || ids.length === 0) return ok(undefined);
  const parsed: number[] = [];
  for (const raw of ids) {
    if (!/^\d+$/u.test(raw)) {
      return err(invalidInput(`${field} must contain integer ids (got "${raw}")`, field));
    }
    parsed.push(Number.parseInt(raw, 10));
  }
  return ok(parsed);
};

const search = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

export const listLegacyBudgetSectors = async (
  repo: LegacyDimensionRepo,
  input: LegacyDimensionPageInput
): Promise<Result<LegacyPage<LegacySector>, ApiError>> => {
  const ids = parseIds(input.ids, 'sector_ids');
  if (ids.isErr()) return err(ids.error);
  const limit = clampLimit(input.limit, LEGACY_SECTORS_DEFAULT_LIMIT, LEGACY_SECTORS_MAX_LIMIT);
  const offset = clampOffset(input.offset);
  const term = search(input.search);
  const result = await repo.listSectors({
    ...(term !== undefined && { search: term }),
    ...(ids.value !== undefined && { ids: ids.value }),
    limit,
    offset,
  });
  if (result.isErr()) return err(result.error);
  return ok({
    nodes: result.value.rows.map((r) => ({
      sector_id: String(r.sectorId),
      sector_description: r.sectorDescription ?? '',
    })),
    pageInfo: {
      totalCount: result.value.totalCount,
      hasNextPage: offset + limit < result.value.totalCount,
      hasPreviousPage: offset > 0,
    },
  });
};

export const listLegacyFundingSources = async (
  repo: LegacyDimensionRepo,
  input: LegacyDimensionPageInput
): Promise<Result<LegacyPage<LegacyFundingSource>, ApiError>> => {
  const ids = parseIds(input.ids, 'source_ids');
  if (ids.isErr()) return err(ids.error);
  const limit = clampLimit(
    input.limit,
    LEGACY_FUNDING_SOURCES_DEFAULT_LIMIT,
    LEGACY_FUNDING_SOURCES_MAX_LIMIT
  );
  const offset = clampOffset(input.offset);
  const term = search(input.search);
  const result = await repo.listFundingSources({
    ...(term !== undefined && { search: term }),
    ...(ids.value !== undefined && { ids: ids.value }),
    limit,
    offset,
  });
  if (result.isErr()) return err(result.error);
  return ok({
    nodes: result.value.rows.map((r) => ({
      source_id: String(r.sourceId),
      source_description: r.sourceDescription ?? '',
    })),
    pageInfo: {
      totalCount: result.value.totalCount,
      hasNextPage: offset + limit < result.value.totalCount,
      hasPreviousPage: offset > 0,
    },
  });
};

export const listLegacyClassifications = async (
  repo: LegacyDimensionRepo,
  kind: LegacyClassificationKind,
  input: LegacyClassificationPageInput
): Promise<Result<LegacyPage<LegacyClassification>, ApiError>> => {
  const limit = clampLimit(
    input.limit,
    LEGACY_CLASSIFICATIONS_DEFAULT_LIMIT,
    LEGACY_CLASSIFICATIONS_MAX_LIMIT
  );
  const offset = clampOffset(input.offset);
  const term = search(input.search);
  const codes =
    input.codes === undefined || input.codes === null || input.codes.length === 0
      ? undefined
      : input.codes;
  const result = await repo.listClassifications(kind, {
    ...(term !== undefined && { search: term }),
    ...(codes !== undefined && { codes }),
    limit,
    offset,
  });
  if (result.isErr()) return err(result.error);
  const nodes = result.value.rows.map((r) => ({ code: r.code, name: r.name ?? '' }));
  return ok({
    nodes,
    pageInfo: {
      totalCount: result.value.totalCount,
      hasNextPage: offset + nodes.length < result.value.totalCount,
      hasPreviousPage: offset > 0,
    },
  });
};
