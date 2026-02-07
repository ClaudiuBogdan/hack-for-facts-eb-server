/**
 * INS Repository Implementation
 *
 * Kysely-based repository for INS Tempo data access.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- Kysely dynamic query builder and JSON aggregation */
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import { setStatementTimeout } from '@/infra/database/query-builders/index.js';

import {
  createDatabaseError,
  createInvalidFilterError,
  createTimeoutError,
  isTimeoutError,
  type InsError,
} from '../../core/errors.js';
import {
  MAX_UAT_DASHBOARD_LIMIT,
  type InsContext,
  type InsContextConnection,
  type InsContextFilter,
  type InsClassificationType,
  type InsClassificationValue,
  type InsDataset,
  type InsDatasetConnection,
  type InsDatasetFilter,
  type InsDimension,
  type InsDimensionType,
  type InsDimensionValue,
  type InsDimensionValueConnection,
  type InsDimensionValueFilter,
  type InsObservation,
  type InsObservationConnection,
  type InsObservationFilter,
  type InsEntitySelectorInput,
  type InsLatestDatasetValue,
  type InsLatestMatchStrategy,
  type InsPeriodicity,
  type InsTerritory,
  type InsTerritoryLevel,
  type InsTimePeriod,
  type InsUnit,
  type ListInsLatestDatasetValuesInput,
  type ListInsObservationsInput,
} from '../../core/types.js';

import type { InsRepository } from '../../core/ports.js';
import type { InsDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;
const UAT_DASHBOARD_CONCURRENCY = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DynamicQuery = any;

interface DatasetRow {
  id: number;
  ins_code: string;
  name_ro: string | null;
  name_en: string | null;
  definition_ro: string | null;
  definition_en: string | null;
  start_year: number | null;
  end_year: number | null;
  has_uat_data: boolean | null;
  has_county_data: boolean | null;
  has_siruta: boolean | null;
  dimension_count: number;
  sync_status: InsDataset['sync_status'];
  last_sync_at: Date | string | null;
  context_code: string | null;
  context_name_ro: string | null;
  context_name_en: string | null;
  context_path: string | null;
  periodicity: unknown;
  metadata?: unknown;
  total_count?: string | number | null;
}

interface ContextRow {
  id: number;
  ins_code: string;
  name_ro: string | null;
  name_en: string | null;
  level: number | null;
  path: string;
  parent_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
  matrix_count: number | null;
  total_count?: string | number | null;
}

interface DimensionRow {
  matrix_id: number;
  dim_index: number;
  dimension_type: InsDimensionType;
  labels: unknown;
  classification_type_id: number | null;
  classification_type_code: string | null;
  classification_type_names: unknown;
  classification_type_is_hierarchical: boolean | null;
  is_hierarchical: boolean | null;
  option_count: number | null;
}

interface DimensionValueRow {
  matrix_id: number;
  dim_index: number;
  nom_item_id: number;
  dimension_type: InsDimensionType;
  labels: unknown;
  parent_nom_item_id: number | null;
  offset_order: number;
  territory_id: number | null;
  territory_code: string | null;
  territory_siruta_code: string | null;
  territory_level: InsTerritoryLevel | null;
  territory_name: string | null;
  territory_path: string | null;
  territory_parent_id: number | null;
  time_period_id: number | null;
  time_year: number | null;
  time_quarter: number | null;
  time_month: number | null;
  time_periodicity: InsPeriodicity | null;
  time_period_start: Date | string | null;
  time_period_end: Date | string | null;
  time_labels: unknown;
  classification_value_id: number | null;
  classification_code: string | null;
  classification_names: unknown;
  classification_level: number | null;
  classification_parent_id: number | null;
  classification_sort_order: number | null;
  classification_type_id: number | null;
  classification_type_code: string | null;
  classification_type_names: unknown;
  unit_id: number | null;
  unit_code: string | null;
  unit_symbol: string | null;
  unit_names: unknown;
  total_count?: string | number | null;
}

interface ObservationRow {
  statistic_id: string;
  matrix_id: number;
  dataset_code: string;
  value: string | null;
  value_status: string | null;
  territory_id: number | null;
  territory_code: string | null;
  territory_siruta_code: string | null;
  territory_level: InsTerritoryLevel | null;
  territory_name: string | null;
  territory_path: string | null;
  territory_parent_id: number | null;
  time_period_id: number;
  time_year: number;
  time_quarter: number | null;
  time_month: number | null;
  time_periodicity: InsPeriodicity;
  time_period_start: Date | string;
  time_period_end: Date | string;
  time_labels: unknown;
  unit_id: number | null;
  unit_code: string | null;
  unit_symbol: string | null;
  unit_names: unknown;
  classification_values: unknown;
}

interface ParsedPeriod {
  year: number;
  quarter: number | null;
  month: number | null;
  periodicity: InsPeriodicity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value);
  }
  return null;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const getJsonString = (value: unknown, key: string): string | null => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const raw = record[key];
    return typeof raw === 'string' ? raw : null;
  }
  return null;
};

const parsePeriodicityArray = (value: unknown): InsPeriodicity[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowed: InsPeriodicity[] = ['ANNUAL', 'QUARTERLY', 'MONTHLY'];
  return value.filter(
    (entry): entry is InsPeriodicity =>
      typeof entry === 'string' && allowed.includes(entry as InsPeriodicity)
  );
};

const buildIsoPeriod = (period: {
  year: number;
  quarter: number | null;
  month: number | null;
  periodicity: InsPeriodicity;
}): string => {
  if (period.periodicity === 'ANNUAL') {
    return String(period.year);
  }
  if (period.periodicity === 'QUARTERLY') {
    return `${String(period.year)}-Q${String(period.quarter ?? 0)}`;
  }
  return `${String(period.year)}-${String(period.month ?? 0).padStart(2, '0')}`;
};

const parsePeriodDate = (value: string): ParsedPeriod | null => {
  const yearMatch = /^\d{4}$/.exec(value);
  if (yearMatch !== null) {
    const year = Number.parseInt(value, 10);
    return Number.isNaN(year) ? null : { year, quarter: null, month: null, periodicity: 'ANNUAL' };
  }

  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarterMatch !== null) {
    const year = Number.parseInt(quarterMatch[1] ?? '', 10);
    const quarter = Number.parseInt(quarterMatch[2] ?? '', 10);
    if (Number.isNaN(year) || Number.isNaN(quarter)) {
      return null;
    }
    return { year, quarter, month: null, periodicity: 'QUARTERLY' };
  }

  const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (monthMatch !== null) {
    const year = Number.parseInt(monthMatch[1] ?? '', 10);
    const month = Number.parseInt(monthMatch[2] ?? '', 10);
    if (Number.isNaN(year) || Number.isNaN(month)) {
      return null;
    }
    return { year, quarter: null, month, periodicity: 'MONTHLY' };
  }

  return null;
};

const mapFrequencyToInsPeriodicity = (frequency: Frequency): InsPeriodicity => {
  if (frequency === Frequency.MONTH) return 'MONTHLY';
  if (frequency === Frequency.QUARTER) return 'QUARTERLY';
  return 'ANNUAL';
};

const getPeriodSortKey = (period: ParsedPeriod): number => {
  if (period.periodicity === 'ANNUAL') {
    return period.year;
  }
  if (period.periodicity === 'QUARTERLY') {
    return period.year * 10 + (period.quarter ?? 0);
  }
  return period.year * 100 + (period.month ?? 0);
};

const escapeILikePattern = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
};

const SAFE_LINK_PROTOCOL_REGEX = /^https?:\/\//i;

const sanitizeMarkdownUrl = (url: string): string | null => {
  const trimmed = url.trim();
  return SAFE_LINK_PROTOCOL_REGEX.test(trimmed) ? trimmed : null;
};

const htmlToMarkdownLinks = (input: string): string => {
  return input.replace(
    /<a\s+[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, text: string) => {
      const safeUrl = sanitizeMarkdownUrl(href);
      const cleanText = text.replace(/<\/?[^>]+>/g, '').trim();
      if (safeUrl === null || cleanText === '') {
        return cleanText;
      }
      return `[${cleanText}](${safeUrl})`;
    }
  );
};

const normalizeContextLabel = (value: string): string => {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const toContextMarkdown = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const withMarkdownLinks = htmlToMarkdownLinks(value);
  const withoutHtml = withMarkdownLinks.replace(/<\/?[^>]+>/g, ' ');
  const normalized = normalizeContextLabel(withoutHtml);

  return normalized === '' ? null : normalized;
};

const normalizeScoreText = (value: string): string => {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
};

const TOTAL_HINT_REGEX = /\b(total|total general|ambele sexe|general)\b/;

const getTotalLikeClassificationCount = (observation: InsObservation): number => {
  if (observation.classifications.length === 0) {
    return 0;
  }

  return observation.classifications.filter((classification) => {
    const label = classification.name_ro ?? classification.name_en ?? classification.code;
    return TOTAL_HINT_REGEX.test(normalizeScoreText(label));
  }).length;
};

const hasPreferredClassification = (
  observation: InsObservation,
  preferredCodes: Set<string>
): boolean => {
  if (preferredCodes.size === 0) {
    return false;
  }

  return observation.classifications.some((classification) =>
    preferredCodes.has(classification.code.toLowerCase())
  );
};

const isTotalLikeObservation = (observation: InsObservation): boolean => {
  if (observation.classifications.length === 0) {
    return true;
  }

  return getTotalLikeClassificationCount(observation) === observation.classifications.length;
};

const getObservationRankingScore = (
  observation: InsObservation,
  preferredCodes: Set<string>
): number => {
  let score = 0;

  if (hasPreferredClassification(observation, preferredCodes)) {
    score += 1_000;
  }

  const totalLikeCount = getTotalLikeClassificationCount(observation);
  if (observation.classifications.length === 0) {
    score += 600;
  } else if (totalLikeCount === observation.classifications.length) {
    score += 500;
  } else {
    score += totalLikeCount * 120;
  }

  score -= observation.classifications.length * 10;

  if (observation.value_status !== null && observation.value_status !== '') {
    score -= 200;
  }

  if (observation.value !== null) {
    score += 5;
  }

  return score;
};

const getLatestMatchStrategy = (
  observation: InsObservation | null,
  preferredCodes: Set<string>
): InsLatestMatchStrategy => {
  if (observation === null) {
    return 'NO_DATA';
  }

  if (hasPreferredClassification(observation, preferredCodes)) {
    return 'PREFERRED_CLASSIFICATION';
  }

  if (isTotalLikeObservation(observation)) {
    return 'TOTAL_FALLBACK';
  }

  return 'REPRESENTATIVE_FALLBACK';
};

const buildDimensionsJson = (observation: InsObservation): Record<string, unknown> => {
  const dimensions: Record<string, unknown> = {};

  if (observation.territory !== null) {
    dimensions['territory_code'] = observation.territory.code;
    if (observation.territory.siruta_code !== null) {
      dimensions['siruta_code'] = observation.territory.siruta_code;
    }
  }

  dimensions['period'] = observation.time_period.iso_period;

  if (observation.unit !== null) {
    dimensions['unit_code'] = observation.unit.code;
  }

  if (observation.classifications.length > 0) {
    const classificationMap: Record<string, string> = {};
    for (const item of observation.classifications) {
      classificationMap[item.type_code] = item.code;
    }
    dimensions['classifications'] = classificationMap;
  }

  return dimensions;
};

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

class KyselyInsRepo implements InsRepository {
  constructor(private readonly db: InsDbClient) {}

  async listDatasets(
    filter: InsDatasetFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsDatasetConnection, InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      let countQuery: DynamicQuery = this.db.selectFrom('v_matrices');
      countQuery = this.applyDatasetFilters(countQuery, filter);

      const countRow = await countQuery
        .select(sql<string>`COUNT(*)`.as('total_count'))
        .executeTakeFirst();

      const totalCount = countRow !== undefined ? (toNumber(countRow.total_count) ?? 0) : 0;

      let dataQuery: DynamicQuery = this.db.selectFrom('v_matrices').selectAll();
      dataQuery = this.applyDatasetFilters(dataQuery, filter)
        .orderBy('ins_code', 'asc')
        .limit(limit)
        .offset(offset);

      const rows: DatasetRow[] = await dataQuery.execute();

      const datasets = rows.map((row) => this.mapDatasetRow(row));

      return ok({
        nodes: datasets,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listDatasets timed out', error));
      }
      return err(createDatabaseError('INS listDatasets failed', error));
    }
  }

  async listContexts(
    filter: InsContextFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsContextConnection, InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      let countQuery: DynamicQuery = this.db.selectFrom('v_contexts');
      countQuery = this.applyContextFilters(countQuery, filter);

      const countRow = await countQuery
        .select(sql<string>`COUNT(*)`.as('total_count'))
        .executeTakeFirst();

      const totalCount = countRow !== undefined ? (toNumber(countRow.total_count) ?? 0) : 0;

      let dataQuery: DynamicQuery = this.db.selectFrom('v_contexts').selectAll();
      dataQuery = this.applyContextFilters(dataQuery, filter)
        .orderBy('path', 'asc')
        .limit(limit)
        .offset(offset);

      const rows: ContextRow[] = await dataQuery.execute();

      return ok({
        nodes: rows.map((row) => this.mapContextRow(row)),
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listContexts timed out', error));
      }
      return err(createDatabaseError('INS listContexts failed', error));
    }
  }

  async getDatasetByCode(code: string): Promise<Result<InsDataset | null, InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const row = await this.db
        .selectFrom('matrices as m')
        .leftJoin('contexts as c', 'm.context_id', 'c.id')
        .select([
          'm.id',
          'm.ins_code',
          'm.metadata',
          'm.sync_status',
          'm.last_sync_at',
          'c.ins_code as context_code',
          sql<string>`m.metadata->'names'->>'ro'`.as('name_ro'),
          sql<string>`m.metadata->'names'->>'en'`.as('name_en'),
          sql<string>`m.metadata->'definitions'->>'ro'`.as('definition_ro'),
          sql<string>`m.metadata->'definitions'->>'en'`.as('definition_en'),
          sql<number>`(m.metadata->'yearRange'->>0)::int`.as('start_year'),
          sql<number>`(m.metadata->'yearRange'->>1)::int`.as('end_year'),
          sql`m.metadata->'periodicity'`.as('periodicity'),
          sql<number>`jsonb_array_length(m.dimensions)`.as('dimension_count'),
          sql<boolean>`(m.metadata->'flags'->>'hasUatData')::boolean`.as('has_uat_data'),
          sql<boolean>`(m.metadata->'flags'->>'hasCountyData')::boolean`.as('has_county_data'),
          sql<boolean>`(m.metadata->'flags'->>'hasSiruta')::boolean`.as('has_siruta'),
          sql<string>`c.names->>'ro'`.as('context_name_ro'),
          sql<string>`c.names->>'en'`.as('context_name_en'),
          sql<string>`c.path::text`.as('context_path'),
        ])
        .where('m.ins_code', '=', code)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      const dataset = this.mapDatasetRow({
        ...(row as DatasetRow),
        metadata: row.metadata,
      });

      return ok(dataset);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS getDatasetByCode timed out', error));
      }
      return err(createDatabaseError('INS getDatasetByCode failed', error));
    }
  }

  async listDimensions(matrixId: number): Promise<Result<InsDimension[], InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const rows: DimensionRow[] = await this.db
        .selectFrom('matrix_dimensions as md')
        .leftJoin('classification_types as ct', 'md.classification_type_id', 'ct.id')
        .select([
          'md.matrix_id',
          'md.dim_index',
          'md.dimension_type',
          'md.labels',
          'md.is_hierarchical',
          'md.option_count',
          'ct.id as classification_type_id',
          'ct.code as classification_type_code',
          'ct.names as classification_type_names',
          'ct.is_hierarchical as classification_type_is_hierarchical',
        ])
        .where('md.matrix_id', '=', matrixId)
        .orderBy('md.dim_index', 'asc')
        .execute();

      const dimensions = rows.map((row) => this.mapDimensionRow(row));
      return ok(dimensions);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listDimensions timed out', error));
      }
      return err(createDatabaseError('INS listDimensions failed', error));
    }
  }

  async listDimensionValues(
    matrixId: number,
    dimIndex: number,
    filter: InsDimensionValueFilter,
    limit: number,
    offset: number
  ): Promise<Result<InsDimensionValueConnection, InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      let query: DynamicQuery = this.db
        .selectFrom('matrix_nom_items as mni')
        .leftJoin('territories as t', 'mni.territory_id', 't.id')
        .leftJoin('time_periods as tp', 'mni.time_period_id', 'tp.id')
        .leftJoin('classification_values as cv', 'mni.classification_value_id', 'cv.id')
        .leftJoin('classification_types as ct', 'cv.type_id', 'ct.id')
        .leftJoin('units_of_measure as u', 'mni.unit_id', 'u.id')
        .select([
          'mni.matrix_id',
          'mni.dim_index',
          'mni.nom_item_id',
          'mni.dimension_type',
          'mni.labels',
          'mni.parent_nom_item_id',
          'mni.offset_order',
          't.id as territory_id',
          't.code as territory_code',
          't.siruta_code as territory_siruta_code',
          't.level as territory_level',
          't.name as territory_name',
          't.path as territory_path',
          't.parent_id as territory_parent_id',
          'tp.id as time_period_id',
          'tp.year as time_year',
          'tp.quarter as time_quarter',
          'tp.month as time_month',
          'tp.periodicity as time_periodicity',
          'tp.period_start as time_period_start',
          'tp.period_end as time_period_end',
          'tp.labels as time_labels',
          'cv.id as classification_value_id',
          'cv.code as classification_code',
          'cv.names as classification_names',
          'cv.level as classification_level',
          'cv.parent_id as classification_parent_id',
          'cv.sort_order as classification_sort_order',
          'ct.id as classification_type_id',
          'ct.code as classification_type_code',
          'ct.names as classification_type_names',
          'u.id as unit_id',
          'u.code as unit_code',
          'u.symbol as unit_symbol',
          'u.names as unit_names',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ])
        .where('mni.matrix_id', '=', matrixId)
        .where('mni.dim_index', '=', dimIndex);

      if (filter.search !== undefined && filter.search.trim() !== '') {
        const pattern = `%${escapeILikePattern(filter.search.trim())}%`;
        query = query.where((eb: DynamicQuery) =>
          eb.or([
            sql<boolean>`(${sql.ref('mni.labels')}->>'ro') ILIKE ${pattern}`,
            sql<boolean>`(${sql.ref('mni.labels')}->>'en') ILIKE ${pattern}`,
          ])
        );
      }

      const rows: DimensionValueRow[] = await query
        .orderBy('mni.offset_order', 'asc')
        .limit(limit)
        .offset(offset)
        .execute();

      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? (toNumber(firstRow.total_count) ?? 0) : 0;
      const values = rows.map((row) => this.mapDimensionValueRow(row));

      return ok({
        nodes: values,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listDimensionValues timed out', error));
      }
      return err(createDatabaseError('INS listDimensionValues failed', error));
    }
  }

  async listObservations(
    input: ListInsObservationsInput
  ): Promise<Result<InsObservationConnection, InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      let matrixIds: number[] | null = null;
      if (input.dataset_codes.length > 0) {
        const matrixRows = await this.db
          .selectFrom('matrices')
          .select(['id'])
          .where('ins_code', 'in', input.dataset_codes)
          .execute();

        matrixIds = matrixRows.map((row) => row.id);
        if (matrixIds.length === 0) {
          return ok({
            nodes: [],
            pageInfo: {
              totalCount: 0,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          });
        }
      }

      let countQuery: DynamicQuery = this.db
        .selectFrom('statistics as s')
        .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
        .leftJoin('territories as t', 't.id', 's.territory_id')
        .leftJoin('units_of_measure as u', 'u.id', 's.unit_id');

      if (matrixIds !== null) {
        countQuery = countQuery.where('s.matrix_id', 'in', matrixIds);
      }

      const filteredCountResult = this.applyObservationFilters(countQuery, input.filter);
      if (filteredCountResult.isErr()) {
        return err(filteredCountResult.error);
      }

      const countRow = await filteredCountResult.value
        .select(sql<string>`COUNT(*)`.as('total_count'))
        .executeTakeFirst();

      const totalCount = countRow !== undefined ? (toNumber(countRow.total_count) ?? 0) : 0;

      let idQuery: DynamicQuery = this.db
        .selectFrom('statistics as s')
        .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
        .leftJoin('territories as t', 't.id', 's.territory_id')
        .leftJoin('units_of_measure as u', 'u.id', 's.unit_id');

      if (matrixIds !== null) {
        idQuery = idQuery.where('s.matrix_id', 'in', matrixIds);
      }

      const filteredIdResult = this.applyObservationFilters(idQuery, input.filter);
      if (filteredIdResult.isErr()) {
        return err(filteredIdResult.error);
      }

      const idRows: { statistic_id: string; matrix_id: number }[] = await filteredIdResult.value
        .select(['s.id as statistic_id', 's.matrix_id'])
        .orderBy('tp.year', 'desc')
        .orderBy('tp.quarter', 'desc')
        .orderBy('tp.month', 'desc')
        .orderBy('t.code', 'asc')
        .limit(input.limit)
        .offset(input.offset)
        .execute();

      if (idRows.length === 0) {
        return ok({
          nodes: [],
          pageInfo: {
            totalCount,
            hasNextPage: input.offset + input.limit < totalCount,
            hasPreviousPage: input.offset > 0,
          },
        });
      }

      const orderMap = new Map<string, number>();
      const statisticIds = idRows.map((row, index) => {
        const id = row.statistic_id;
        orderMap.set(id, index);
        return id;
      });

      let dataQuery: DynamicQuery = this.db
        .selectFrom('statistics as s')
        .innerJoin('matrices as m', 'm.id', 's.matrix_id')
        .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
        .leftJoin('territories as t', 't.id', 's.territory_id')
        .leftJoin('units_of_measure as u', 'u.id', 's.unit_id')
        .where('s.id', 'in', statisticIds);

      if (matrixIds !== null) {
        dataQuery = dataQuery.where('s.matrix_id', 'in', matrixIds);
      }

      const baseRows: Omit<ObservationRow, 'classification_values'>[] = await dataQuery
        .select([
          's.id as statistic_id',
          's.matrix_id',
          'm.ins_code as dataset_code',
          's.value',
          's.value_status',
          't.id as territory_id',
          't.code as territory_code',
          't.siruta_code as territory_siruta_code',
          't.level as territory_level',
          't.name as territory_name',
          't.path as territory_path',
          't.parent_id as territory_parent_id',
          'tp.id as time_period_id',
          'tp.year as time_year',
          'tp.quarter as time_quarter',
          'tp.month as time_month',
          'tp.periodicity as time_periodicity',
          'tp.period_start as time_period_start',
          'tp.period_end as time_period_end',
          'tp.labels as time_labels',
          'u.id as unit_id',
          'u.code as unit_code',
          'u.symbol as unit_symbol',
          'u.names as unit_names',
        ])
        .execute();

      const classificationMatrixId =
        matrixIds !== null && matrixIds.length === 1 ? matrixIds[0] : undefined;
      const classificationMap = await this.loadClassificationMap(
        statisticIds,
        classificationMatrixId
      );
      const rows: ObservationRow[] = baseRows.map((row) => ({
        ...row,
        classification_values: classificationMap.get(row.statistic_id) ?? [],
      }));

      const observations = rows.map((row) => this.mapObservationRow(row));
      observations.sort((a, b) => {
        const aIndex = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });

      return ok({
        nodes: observations,
        pageInfo: {
          totalCount,
          hasNextPage: input.offset + input.limit < totalCount,
          hasPreviousPage: input.offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listObservations timed out', error));
      }
      return err(createDatabaseError('INS listObservations failed', error));
    }
  }

  async listLatestDatasetValues(
    input: ListInsLatestDatasetValuesInput
  ): Promise<Result<InsLatestDatasetValue[], InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      if (input.dataset_codes.length === 0) {
        return ok([]);
      }

      let datasetQuery: DynamicQuery = this.db
        .selectFrom('v_matrices')
        .selectAll()
        .where('ins_code', 'in', input.dataset_codes);

      datasetQuery = datasetQuery.orderBy('ins_code', 'asc');
      const datasetRows: DatasetRow[] = await datasetQuery.execute();
      const datasetMap = new Map(datasetRows.map((row) => [row.ins_code, this.mapDatasetRow(row)]));

      const preferredCodes = new Set(
        (input.preferred_classification_codes ?? []).map((code) => code.toLowerCase())
      );

      const results: InsLatestDatasetValue[] = [];

      for (const datasetCode of input.dataset_codes) {
        const dataset = datasetMap.get(datasetCode);
        if (dataset === undefined) {
          continue;
        }

        let latestPeriodQuery: DynamicQuery = this.db
          .selectFrom('statistics as s')
          .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
          .innerJoin('territories as t', 't.id', 's.territory_id')
          .select([
            'tp.year as time_year',
            'tp.quarter as time_quarter',
            'tp.month as time_month',
            'tp.periodicity as time_periodicity',
          ])
          .where('s.matrix_id', '=', dataset.id);

        latestPeriodQuery = this.applyEntitySelectorFilter(latestPeriodQuery, input.entity);

        const latestPeriodRow = await latestPeriodQuery
          .orderBy('tp.year', 'desc')
          .orderBy(sql`tp.quarter desc nulls last`)
          .orderBy(sql`tp.month desc nulls last`)
          .limit(1)
          .executeTakeFirst();

        if (latestPeriodRow === undefined) {
          results.push({
            dataset,
            observation: null,
            latest_period: null,
            match_strategy: 'NO_DATA',
            has_data: false,
          });
          continue;
        }

        const periodicity = latestPeriodRow.time_periodicity as InsPeriodicity;
        const year = toNumber(latestPeriodRow.time_year);
        const quarter = toNumber(latestPeriodRow.time_quarter);
        const month = toNumber(latestPeriodRow.time_month);

        if (year === null) {
          results.push({
            dataset,
            observation: null,
            latest_period: null,
            match_strategy: 'NO_DATA',
            has_data: false,
          });
          continue;
        }

        const latestPeriod = buildIsoPeriod({ year, quarter, month, periodicity });

        let observationQuery: DynamicQuery = this.db
          .selectFrom('statistics as s')
          .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
          .innerJoin('territories as t', 't.id', 's.territory_id')
          .leftJoin('units_of_measure as u', 'u.id', 's.unit_id')
          .where('s.matrix_id', '=', dataset.id)
          .where('tp.periodicity', '=', periodicity)
          .where('tp.year', '=', year);

        if (quarter !== null) {
          observationQuery = observationQuery.where('tp.quarter', '=', quarter);
        }
        if (month !== null) {
          observationQuery = observationQuery.where('tp.month', '=', month);
        }

        observationQuery = this.applyEntitySelectorFilter(observationQuery, input.entity);

        const baseRows: Omit<ObservationRow, 'classification_values'>[] = await observationQuery
          .select([
            's.id as statistic_id',
            's.matrix_id',
            sql.lit(dataset.code).as('dataset_code'),
            's.value',
            's.value_status',
            't.id as territory_id',
            't.code as territory_code',
            't.siruta_code as territory_siruta_code',
            't.level as territory_level',
            't.name as territory_name',
            't.path as territory_path',
            't.parent_id as territory_parent_id',
            'tp.id as time_period_id',
            'tp.year as time_year',
            'tp.quarter as time_quarter',
            'tp.month as time_month',
            'tp.periodicity as time_periodicity',
            'tp.period_start as time_period_start',
            'tp.period_end as time_period_end',
            'tp.labels as time_labels',
            'u.id as unit_id',
            'u.code as unit_code',
            'u.symbol as unit_symbol',
            'u.names as unit_names',
          ])
          .execute();

        if (baseRows.length === 0) {
          results.push({
            dataset,
            observation: null,
            latest_period: latestPeriod,
            match_strategy: 'NO_DATA',
            has_data: false,
          });
          continue;
        }

        const statisticIds = baseRows.map((row) => row.statistic_id);
        const classificationMap = await this.loadClassificationMap(statisticIds, dataset.id);
        const rows: ObservationRow[] = baseRows.map((row) => ({
          ...row,
          classification_values: classificationMap.get(row.statistic_id) ?? [],
        }));

        const observations = rows.map((row) => this.mapObservationRow(row));
        const sorted = observations.sort((left, right) => {
          const leftScore = getObservationRankingScore(left, preferredCodes);
          const rightScore = getObservationRankingScore(right, preferredCodes);
          if (leftScore !== rightScore) {
            return rightScore - leftScore;
          }
          return left.id.localeCompare(right.id);
        });

        const observation = sorted[0] ?? null;
        results.push({
          dataset,
          observation,
          latest_period: latestPeriod,
          match_strategy: getLatestMatchStrategy(observation, preferredCodes),
          has_data: observation !== null,
        });
      }

      return ok(results);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listLatestDatasetValues timed out', error));
      }
      return err(createDatabaseError('INS listLatestDatasetValues failed', error));
    }
  }

  async listUatDatasetsWithObservations(
    sirutaCode: string,
    contextCode?: string,
    period?: string
  ): Promise<Result<{ dataset: InsDataset; observations: InsObservation[] }[], InsError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Step 1: Find UAT datasets
      let datasetQuery: DynamicQuery = this.db
        .selectFrom('v_matrices')
        .selectAll()
        .where('has_uat_data', '=', true);

      if (contextCode !== undefined && contextCode.trim() !== '') {
        datasetQuery = datasetQuery.where('context_code', '=', contextCode.trim());
      }

      datasetQuery = datasetQuery.orderBy('ins_code', 'asc');

      const datasetRows: DatasetRow[] = await datasetQuery.execute();

      if (datasetRows.length === 0) {
        return ok([]);
      }

      const datasets = datasetRows.map((row) => this.mapDatasetRow(row));

      let parsedPeriod: ParsedPeriod | null = null;
      if (period !== undefined && period.trim() !== '') {
        parsedPeriod = parsePeriodDate(period.trim());
        if (parsedPeriod === null) {
          return err(createInvalidFilterError('period', 'Invalid period format'));
        }
      }

      const results: { dataset: InsDataset; observations: InsObservation[] }[] = [];
      let remaining = MAX_UAT_DASHBOARD_LIMIT;

      const fetchDataset = async (
        dataset: InsDataset,
        limit: number
      ): Promise<{ dataset: InsDataset; observations: InsObservation[]; count: number }> => {
        let obsQuery: DynamicQuery = this.db
          .selectFrom('statistics as s')
          .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
          .leftJoin('territories as t', 't.id', 's.territory_id')
          .leftJoin('units_of_measure as u', 'u.id', 's.unit_id')
          .where('s.matrix_id', '=', dataset.id)
          .where('t.siruta_code', '=', sirutaCode);

        if (parsedPeriod !== null) {
          obsQuery = obsQuery
            .where('tp.periodicity', '=', parsedPeriod.periodicity)
            .where('tp.year', '=', parsedPeriod.year);
          if (parsedPeriod.quarter !== null) {
            obsQuery = obsQuery.where('tp.quarter', '=', parsedPeriod.quarter);
          }
          if (parsedPeriod.month !== null) {
            obsQuery = obsQuery.where('tp.month', '=', parsedPeriod.month);
          }
        }

        const baseRows: Omit<ObservationRow, 'classification_values'>[] = await obsQuery
          .select([
            's.id as statistic_id',
            's.matrix_id',
            sql.lit(dataset.code).as('dataset_code'),
            's.value',
            's.value_status',
            't.id as territory_id',
            't.code as territory_code',
            't.siruta_code as territory_siruta_code',
            't.level as territory_level',
            't.name as territory_name',
            't.path as territory_path',
            't.parent_id as territory_parent_id',
            'tp.id as time_period_id',
            'tp.year as time_year',
            'tp.quarter as time_quarter',
            'tp.month as time_month',
            'tp.periodicity as time_periodicity',
            'tp.period_start as time_period_start',
            'tp.period_end as time_period_end',
            'tp.labels as time_labels',
            'u.id as unit_id',
            'u.code as unit_code',
            'u.symbol as unit_symbol',
            'u.names as unit_names',
          ])
          .orderBy('tp.year', 'desc')
          .orderBy('tp.quarter', 'desc')
          .orderBy('tp.month', 'desc')
          .limit(limit)
          .execute();

        if (baseRows.length === 0) {
          return { dataset, observations: [], count: 0 };
        }

        const statisticIds = baseRows.map((row) => row.statistic_id);
        const classificationMap = await this.loadClassificationMap(statisticIds, dataset.id);
        const rows: ObservationRow[] = baseRows.map((row) => ({
          ...row,
          classification_values: classificationMap.get(row.statistic_id) ?? [],
        }));

        const observations = rows.map((row) => this.mapObservationRow(row));
        return { dataset, observations, count: baseRows.length };
      };

      for (
        let index = 0;
        index < datasets.length && remaining > 0;
        index += UAT_DASHBOARD_CONCURRENCY
      ) {
        const batch = datasets.slice(index, index + UAT_DASHBOARD_CONCURRENCY);
        if (batch.length === 0) {
          break;
        }
        const quotas = new Array(batch.length).fill(0) as number[];
        for (let quotaIndex = 0; quotaIndex < remaining; quotaIndex += 1) {
          const position = quotaIndex % batch.length;
          const currentQuota = quotas[position] ?? 0;
          quotas[position] = currentQuota + 1;
        }

        const scheduledBatch = batch
          .map((dataset, batchIndex) => ({ dataset, limit: quotas[batchIndex] ?? 0 }))
          .filter((item) => item.limit > 0);

        const batchResults = await Promise.all(
          scheduledBatch.map((item) => fetchDataset(item.dataset, item.limit))
        );

        for (const result of batchResults) {
          if (remaining <= 0) {
            break;
          }
          if (result.observations.length === 0) {
            continue;
          }
          results.push({ dataset: result.dataset, observations: result.observations });
          remaining -= result.count;
        }
      }

      return ok(results);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('INS listUatDatasetsWithObservations timed out', error));
      }
      return err(createDatabaseError('INS listUatDatasetsWithObservations failed', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private mapDatasetRow(row: DatasetRow): InsDataset {
    const periodicity = parsePeriodicityArray(row.periodicity);
    const yearRange: [number, number] | null =
      row.start_year !== null && row.end_year !== null ? [row.start_year, row.end_year] : null;

    return {
      id: row.id,
      code: row.ins_code,
      name_ro: row.name_ro,
      name_en: row.name_en,
      definition_ro: row.definition_ro,
      definition_en: row.definition_en,
      periodicity,
      year_range: yearRange,
      dimension_count: row.dimension_count,
      has_uat_data: row.has_uat_data === true,
      has_county_data: row.has_county_data === true,
      has_siruta: row.has_siruta === true,
      sync_status: row.sync_status ?? null,
      last_sync_at: toDate(row.last_sync_at),
      context_code: row.context_code,
      context_name_ro: row.context_name_ro,
      context_name_en: row.context_name_en,
      context_path: row.context_path,
      metadata:
        row.metadata !== undefined && row.metadata !== null && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : null,
    };
  }

  private mapContextRow(row: ContextRow): InsContext {
    return {
      id: row.id,
      code: row.ins_code,
      name_ro: row.name_ro,
      name_en: row.name_en,
      name_ro_markdown: toContextMarkdown(row.name_ro),
      name_en_markdown: toContextMarkdown(row.name_en),
      level: row.level,
      path: row.path,
      parent_id: row.parent_id,
      parent_code: row.parent_code,
      parent_name_ro: row.parent_name_ro,
      matrix_count: row.matrix_count ?? 0,
    };
  }

  private mapDimensionRow(row: DimensionRow): InsDimension {
    const labelRo = getJsonString(row.labels, 'ro');
    const labelEn = getJsonString(row.labels, 'en');

    let classificationType: InsClassificationType | null = null;
    if (row.classification_type_id !== null) {
      classificationType = {
        id: row.classification_type_id,
        code: row.classification_type_code ?? '',
        name_ro: getJsonString(row.classification_type_names, 'ro'),
        name_en: getJsonString(row.classification_type_names, 'en'),
        is_hierarchical: row.classification_type_is_hierarchical === true,
        value_count: null,
      };
    }

    return {
      matrix_id: row.matrix_id,
      index: row.dim_index,
      type: row.dimension_type,
      label_ro: labelRo,
      label_en: labelEn,
      classification_type: classificationType,
      is_hierarchical: row.is_hierarchical === true,
      option_count: row.option_count ?? 0,
    };
  }

  private mapDimensionValueRow(row: DimensionValueRow): InsDimensionValue {
    const labelRo = getJsonString(row.labels, 'ro');
    const labelEn = getJsonString(row.labels, 'en');

    const territory: InsTerritory | null =
      row.territory_id !== null && row.territory_code !== null && row.territory_level !== null
        ? {
            id: row.territory_id,
            code: row.territory_code,
            siruta_code: row.territory_siruta_code,
            level: row.territory_level,
            name_ro: row.territory_name ?? '',
            path: row.territory_path,
            parent_id: row.territory_parent_id,
          }
        : null;

    let timePeriod: InsTimePeriod | null = null;
    if (row.time_period_id !== null && row.time_year !== null && row.time_periodicity !== null) {
      timePeriod = {
        id: row.time_period_id,
        year: row.time_year,
        quarter: row.time_quarter,
        month: row.time_month,
        periodicity: row.time_periodicity,
        period_start: toDate(row.time_period_start) ?? new Date(0),
        period_end: toDate(row.time_period_end) ?? new Date(0),
        label_ro: getJsonString(row.time_labels, 'ro'),
        label_en: getJsonString(row.time_labels, 'en'),
        iso_period: buildIsoPeriod({
          year: row.time_year,
          quarter: row.time_quarter,
          month: row.time_month,
          periodicity: row.time_periodicity,
        }),
      };
    }

    let classificationValue: InsClassificationValue | null = null;
    if (row.classification_value_id !== null && row.classification_type_id !== null) {
      classificationValue = {
        id: row.classification_value_id,
        type_id: row.classification_type_id,
        type_code: row.classification_type_code ?? '',
        type_name_ro: getJsonString(row.classification_type_names, 'ro'),
        type_name_en: getJsonString(row.classification_type_names, 'en'),
        code: row.classification_code ?? '',
        name_ro: getJsonString(row.classification_names, 'ro'),
        name_en: getJsonString(row.classification_names, 'en'),
        level: row.classification_level,
        parent_id: row.classification_parent_id,
        sort_order: row.classification_sort_order,
      };
    }

    const unit: InsUnit | null =
      row.unit_id !== null && row.unit_code !== null
        ? {
            id: row.unit_id,
            code: row.unit_code,
            symbol: row.unit_symbol,
            name_ro: getJsonString(row.unit_names, 'ro'),
            name_en: getJsonString(row.unit_names, 'en'),
          }
        : null;

    return {
      matrix_id: row.matrix_id,
      dim_index: row.dim_index,
      nom_item_id: row.nom_item_id,
      dimension_type: row.dimension_type,
      label_ro: labelRo,
      label_en: labelEn,
      parent_nom_item_id: row.parent_nom_item_id,
      offset_order: row.offset_order,
      territory,
      time_period: timePeriod,
      classification_value: classificationValue,
      unit,
    };
  }

  private mapObservationRow(row: ObservationRow): InsObservation {
    const territory: InsTerritory | null =
      row.territory_id !== null && row.territory_code !== null && row.territory_level !== null
        ? {
            id: row.territory_id,
            code: row.territory_code,
            siruta_code: row.territory_siruta_code,
            level: row.territory_level,
            name_ro: row.territory_name ?? '',
            path: row.territory_path,
            parent_id: row.territory_parent_id,
          }
        : null;

    const timePeriod: InsTimePeriod = {
      id: row.time_period_id,
      year: row.time_year,
      quarter: row.time_quarter,
      month: row.time_month,
      periodicity: row.time_periodicity,
      period_start: toDate(row.time_period_start) ?? new Date(0),
      period_end: toDate(row.time_period_end) ?? new Date(0),
      label_ro: getJsonString(row.time_labels, 'ro'),
      label_en: getJsonString(row.time_labels, 'en'),
      iso_period: buildIsoPeriod({
        year: row.time_year,
        quarter: row.time_quarter,
        month: row.time_month,
        periodicity: row.time_periodicity,
      }),
    };

    const unit: InsUnit | null =
      row.unit_id !== null && row.unit_code !== null
        ? {
            id: row.unit_id,
            code: row.unit_code,
            symbol: row.unit_symbol,
            name_ro: getJsonString(row.unit_names, 'ro'),
            name_en: getJsonString(row.unit_names, 'en'),
          }
        : null;

    const classifications = this.parseClassificationValues(row.classification_values);

    const observation: InsObservation = {
      id: row.statistic_id,
      dataset_code: row.dataset_code,
      matrix_id: row.matrix_id,
      territory,
      time_period: timePeriod,
      unit,
      value: row.value !== null ? new Decimal(row.value) : null,
      value_status: row.value_status,
      classifications,
      dimensions: {},
    };

    observation.dimensions = buildDimensionsJson(observation);

    return observation;
  }

  private applyDatasetFilters(query: DynamicQuery, filter: InsDatasetFilter): DynamicQuery {
    if (filter.search !== undefined && filter.search.trim() !== '') {
      const pattern = `%${escapeILikePattern(filter.search.trim())}%`;
      query = query.where((eb: DynamicQuery) =>
        eb.or([
          eb('ins_code', 'ilike', pattern),
          eb('name_ro', 'ilike', pattern),
          eb('name_en', 'ilike', pattern),
          eb('definition_ro', 'ilike', pattern),
          eb('definition_en', 'ilike', pattern),
        ])
      );
    }

    if (filter.codes !== undefined && filter.codes.length > 0) {
      query = query.where('ins_code', 'in', filter.codes);
    }

    if (filter.context_code !== undefined && filter.context_code.trim() !== '') {
      query = query.where('context_code', '=', filter.context_code.trim());
    }

    if (filter.root_context_code !== undefined && filter.root_context_code.trim() !== '') {
      query = query.where(
        sql<boolean>`split_part(${sql.ref('context_path')}, '.', 2) = ${filter.root_context_code.trim()}`
      );
    }

    if (filter.sync_status !== undefined && filter.sync_status.length > 0) {
      query = query.where('sync_status', 'in', filter.sync_status);
    }

    if (filter.has_uat_data !== undefined) {
      query = query.where(
        sql<boolean>`coalesce(${sql.ref('has_uat_data')}, false) = ${filter.has_uat_data}`
      );
    }

    if (filter.has_county_data !== undefined) {
      query = query.where(
        sql<boolean>`coalesce(${sql.ref('has_county_data')}, false) = ${filter.has_county_data}`
      );
    }

    if (filter.periodicity !== undefined && filter.periodicity.length > 0) {
      query = query.where(
        sql<boolean>`${sql.ref('periodicity')} ?| ${sql.lit(
          `{${filter.periodicity.join(',')}}`
        )}::text[]`
      );
    }

    return query;
  }

  private applyContextFilters(query: DynamicQuery, filter: InsContextFilter): DynamicQuery {
    if (filter.search !== undefined && filter.search.trim() !== '') {
      const pattern = `%${escapeILikePattern(filter.search.trim())}%`;
      query = query.where((eb: DynamicQuery) =>
        eb.or([
          eb('ins_code', 'ilike', pattern),
          eb('name_ro', 'ilike', pattern),
          eb('name_en', 'ilike', pattern),
          eb('path', 'ilike', pattern),
        ])
      );
    }

    if (filter.level !== undefined) {
      query = query.where('level', '=', filter.level);
    }

    if (filter.parent_code !== undefined && filter.parent_code.trim() !== '') {
      query = query.where('parent_code', '=', filter.parent_code.trim());
    }

    if (filter.root_context_code !== undefined && filter.root_context_code.trim() !== '') {
      query = query.where(
        sql<boolean>`split_part(${sql.ref('path')}, '.', 2) = ${filter.root_context_code.trim()}`
      );
    }

    return query;
  }

  private applyEntitySelectorFilter(
    query: DynamicQuery,
    entity: InsEntitySelectorInput
  ): DynamicQuery {
    if (entity.siruta_code !== undefined && entity.siruta_code.trim() !== '') {
      return query.where('t.siruta_code', '=', entity.siruta_code.trim());
    }

    if (
      entity.territory_code !== undefined &&
      entity.territory_code.trim() !== '' &&
      entity.territory_level !== undefined
    ) {
      return query
        .where('t.code', '=', entity.territory_code.trim())
        .where('t.level', '=', entity.territory_level);
    }

    return query.where(sql<boolean>`false`);
  }

  private parseClassificationValues(value: unknown): InsClassificationValue[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const parsed: InsClassificationValue[] = [];

    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const id = toNumber(record['id']);
      const typeId = toNumber(record['type_id']);
      if (id === null || typeId === null) {
        continue;
      }

      parsed.push({
        id,
        type_id: typeId,
        type_code: typeof record['type_code'] === 'string' ? record['type_code'] : '',
        type_name_ro: getJsonString(record['type_names'], 'ro'),
        type_name_en: getJsonString(record['type_names'], 'en'),
        code: typeof record['code'] === 'string' ? record['code'] : '',
        name_ro: getJsonString(record['names'], 'ro'),
        name_en: getJsonString(record['names'], 'en'),
        level: toNumber(record['level']),
        parent_id: toNumber(record['parent_id']),
        sort_order: toNumber(record['sort_order']),
      });
    }

    return parsed;
  }

  private async loadClassificationMap(
    statisticIds: string[],
    matrixId?: number
  ): Promise<Map<string, unknown[]>> {
    if (statisticIds.length === 0) {
      return new Map();
    }

    let query: DynamicQuery = this.db
      .selectFrom('statistic_classifications as sc')
      .innerJoin('classification_values as cv', 'cv.id', 'sc.classification_value_id')
      .innerJoin('classification_types as ct', 'ct.id', 'cv.type_id')
      .select([
        'sc.statistic_id as statistic_id',
        'cv.id as classification_value_id',
        'cv.code as classification_code',
        'cv.names as classification_names',
        'cv.level as classification_level',
        'cv.parent_id as classification_parent_id',
        'cv.sort_order as classification_sort_order',
        'ct.id as classification_type_id',
        'ct.code as classification_type_code',
        'ct.names as classification_type_names',
      ])
      .where('sc.statistic_id', 'in', statisticIds);

    if (matrixId !== undefined) {
      query = query.where('sc.matrix_id', '=', matrixId);
    }

    const rows: {
      statistic_id: string;
      classification_value_id: number;
      classification_code: string;
      classification_names: unknown;
      classification_level: number | null;
      classification_parent_id: number | null;
      classification_sort_order: number | null;
      classification_type_id: number;
      classification_type_code: string;
      classification_type_names: unknown;
    }[] = await query.orderBy('sc.statistic_id', 'asc').orderBy('cv.sort_order', 'asc').execute();

    const map = new Map<string, unknown[]>();
    for (const row of rows) {
      const key = row.statistic_id;
      let list = map.get(key);
      if (list === undefined) {
        list = [];
        map.set(key, list);
      }

      list.push({
        id: row.classification_value_id,
        code: row.classification_code,
        names: row.classification_names,
        level: row.classification_level,
        parent_id: row.classification_parent_id,
        sort_order: row.classification_sort_order,
        type_id: row.classification_type_id,
        type_code: row.classification_type_code,
        type_names: row.classification_type_names,
      });
    }

    return map;
  }

  private applyObservationFilters(
    query: DynamicQuery,
    filter: InsObservationFilter | undefined
  ): Result<DynamicQuery, InsError> {
    if (filter === undefined) {
      return ok(query);
    }

    if (filter.territory_codes !== undefined && filter.territory_codes.length > 0) {
      query = query.where('t.code', 'in', filter.territory_codes);
    }

    if (filter.siruta_codes !== undefined && filter.siruta_codes.length > 0) {
      query = query.where('t.siruta_code', 'in', filter.siruta_codes);
    }

    if (filter.territory_levels !== undefined && filter.territory_levels.length > 0) {
      query = query.where('t.level', 'in', filter.territory_levels);
    }

    if (filter.unit_codes !== undefined && filter.unit_codes.length > 0) {
      query = query.where('u.code', 'in', filter.unit_codes);
    }

    if (
      filter.classification_value_codes !== undefined &&
      filter.classification_value_codes.length > 0
    ) {
      const codes = filter.classification_value_codes;
      query = query.where((eb: DynamicQuery) =>
        eb.exists(
          eb
            .selectFrom('statistic_classifications as sc')
            .innerJoin('classification_values as cv', 'cv.id', 'sc.classification_value_id')
            .whereRef('sc.matrix_id', '=', 's.matrix_id')
            .whereRef('sc.statistic_id', '=', 's.id')
            .where('cv.code', 'in', codes)
        )
      );
    }

    if (
      filter.classification_type_codes !== undefined &&
      filter.classification_type_codes.length > 0
    ) {
      const codes = filter.classification_type_codes;
      query = query.where((eb: DynamicQuery) =>
        eb.exists(
          eb
            .selectFrom('statistic_classifications as sc')
            .innerJoin('classification_values as cv', 'cv.id', 'sc.classification_value_id')
            .innerJoin('classification_types as ct', 'ct.id', 'cv.type_id')
            .whereRef('sc.matrix_id', '=', 's.matrix_id')
            .whereRef('sc.statistic_id', '=', 's.id')
            .where('ct.code', 'in', codes)
        )
      );
    }

    if (filter.period !== undefined) {
      const expectedPeriodicity = mapFrequencyToInsPeriodicity(filter.period.type);
      const periodSelection = filter.period.selection;

      query = query.where('tp.periodicity', '=', expectedPeriodicity);

      if (periodSelection.interval !== undefined) {
        const start = parsePeriodDate(periodSelection.interval.start);
        const end = parsePeriodDate(periodSelection.interval.end);

        if (start === null || end === null) {
          return err(createInvalidFilterError('period', 'Invalid period range'));
        }
        if (start.periodicity !== expectedPeriodicity || end.periodicity !== expectedPeriodicity) {
          return err(
            createInvalidFilterError('period', 'Period type does not match selected dates')
          );
        }
        if (getPeriodSortKey(start) > getPeriodSortKey(end)) {
          return err(
            createInvalidFilterError('period', 'Period interval start must be before end')
          );
        }

        if (expectedPeriodicity === 'ANNUAL') {
          query = query.where('tp.year', '>=', start.year).where('tp.year', '<=', end.year);
        } else if (expectedPeriodicity === 'QUARTERLY') {
          if (start.quarter === null || end.quarter === null) {
            return err(createInvalidFilterError('period', 'Quarter interval is invalid'));
          }
          const startKey = start.year * 10 + start.quarter;
          const endKey = end.year * 10 + end.quarter;
          query = query.where(
            sql<boolean>`(${sql.ref('tp.year')} * 10 + ${sql.ref('tp.quarter')}) >= ${startKey}`
          );
          query = query.where(
            sql<boolean>`(${sql.ref('tp.year')} * 10 + ${sql.ref('tp.quarter')}) <= ${endKey}`
          );
        } else {
          if (start.month === null || end.month === null) {
            return err(createInvalidFilterError('period', 'Month interval is invalid'));
          }
          const startKey = start.year * 100 + start.month;
          const endKey = end.year * 100 + end.month;
          query = query.where(
            sql<boolean>`(${sql.ref('tp.year')} * 100 + ${sql.ref('tp.month')}) >= ${startKey}`
          );
          query = query.where(
            sql<boolean>`(${sql.ref('tp.year')} * 100 + ${sql.ref('tp.month')}) <= ${endKey}`
          );
        }
      } else {
        const periodDates = periodSelection.dates;
        if (periodDates.length > 0) {
          const parsedDates: ParsedPeriod[] = [];
          for (const periodDate of periodDates) {
            const parsedDate = parsePeriodDate(periodDate);
            if (parsedDate?.periodicity !== expectedPeriodicity) {
              return err(createInvalidFilterError('period', 'Invalid date in period selection'));
            }
            parsedDates.push(parsedDate);
          }

          query = query.where((eb: DynamicQuery) =>
            eb.or(
              parsedDates.map((parsedDate) => {
                const clauses: DynamicQuery[] = [eb('tp.year', '=', parsedDate.year)];
                if (parsedDate.quarter !== null) {
                  clauses.push(eb('tp.quarter', '=', parsedDate.quarter));
                }
                if (parsedDate.month !== null) {
                  clauses.push(eb('tp.month', '=', parsedDate.month));
                }
                return eb.and(clauses);
              })
            )
          );
        }
      }
    }

    if (filter.has_value === true) {
      query = query.where(sql<boolean>`${sql.ref('s.value')} IS NOT NULL`);
    }

    if (filter.has_value === false) {
      query = query.where(sql<boolean>`${sql.ref('s.value')} IS NULL`);
    }

    return ok(query);
  }
}

export const makeInsRepo = (db: InsDbClient): InsRepository => new KyselyInsRepo(db);
