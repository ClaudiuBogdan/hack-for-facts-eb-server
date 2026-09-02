/**
 * Legacy dimension roots — SQL over the Chronos dimension tables, reproducing
 * the legacy modules' predicates (docs/server-redesign/13 §4 "dimension usecases"):
 *
 *  - sectors (`budget.budget_sectors`) and funding sources
 *    (`budget.v_funding_sources_compat`, the phoenix-ordinal ids; the synthetic
 *    `source_code IS NULL` row is not a public source): search =
 *    `description ILIKE '%term%' OR similarity(description, term) > 0.1`
 *    (pg_trgm, `public` schema on Chronos — legacy budget-sector-repo.ts:73-78),
 *    optional id list, `ORDER BY id`, `COUNT(*) OVER()` for the exact total;
 *  - classifications (`budget.functional_classifications` /
 *    `budget.economic_classifications`): the two legacy repos differ and both
 *    are reproduced — FUNCTIONAL: a code-like term (`/^[\d.]+$/`) is a prefix
 *    match on the code (legacy classification-repo.ts:75-80), any other term a
 *    contains match on code or name; ECONOMIC: always a contains match on code
 *    or name (classification-repo.ts:187-194). The contains match is
 *    DIACRITIC-INSENSITIVE via `unaccent` (user decision S1-9: the Chronos
 *    catalog carries diacritics, the legacy one did not). The legacy repos pass
 *    the term to ILIKE UNESCAPED (`%` / `_` act as wildcards); that is kept —
 *    a search of "%" lists the whole catalog on both endpoints. Optional code
 *    list; `ORDER BY code`; the count uses the SAME predicate as the rows
 *    (legacy FUNCTIONAL counted `contains` while listing `prefix` matches —
 *    documented delta; economic was already consistent).
 *
 * An empty page (offset past the end) still reports the real `totalCount`
 * (one extra count statement), where legacy sectors / funding sources said 0.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import {
  LEGACY_SIMILARITY_THRESHOLD,
  type LegacyClassificationKind,
} from '../../core/legacy-dimensions/types.js';

import type {
  LegacyClassificationQuery,
  LegacyClassificationRow,
  LegacyDimensionQuery,
  LegacyDimensionRepo,
  LegacyDimensionRows,
  LegacyFundingSourceRow,
  LegacySectorRow,
} from '../../core/legacy-dimensions/ports.js';

/**
 * Legacy `escapeLikePattern` (budget-sector / funding-sources repos ONLY):
 * backslash, `%` and `_` become literals. The classification repos never
 * escaped — see `listClassifications`.
 */
export const escapeLike = (term: string): string =>
  term.replace(/\\/gu, '\\\\').replace(/%/gu, '\\%').replace(/_/gu, '\\_');

/** A code-like FUNCTIONAL search term is matched as a code prefix (legacy classification-repo.ts:75). */
export const isCodeLike = (term: string): boolean => /^[\d.]+$/u.test(term);

interface CountedRow {
  readonly total_count: string | number;
}

const whereOf = (conds: readonly RawBuilder<unknown>[]): RawBuilder<unknown> =>
  conds.length === 0 ? sql`` : sql`where ${sql.join(conds, sql` and `)}`;

const toCount = (value: string | number | undefined): number =>
  value === undefined ? 0 : Number(value);

export const makeLegacyDimensionRepo = (db: Kysely<ProdDatabase>): LegacyDimensionRepo => {
  /** Rows + exact total; falls back to a count statement when the page is empty. */
  const paged = async <R extends CountedRow>(
    select: RawBuilder<R>,
    count: RawBuilder<{ total_count: string | number }>
  ): Promise<{ rows: readonly R[]; totalCount: number }> => {
    const result = await select.execute(db);
    if (result.rows.length > 0) {
      return { rows: result.rows, totalCount: toCount(result.rows[0]?.total_count) };
    }
    const counted = await count.execute(db);
    return { rows: [], totalCount: toCount(counted.rows[0]?.total_count) };
  };

  const descriptionSearch = (column: RawBuilder<unknown>, term: string): RawBuilder<unknown> =>
    sql`(${column} ilike ${`%${escapeLike(term)}%`} or similarity(${column}, ${term}) > ${LEGACY_SIMILARITY_THRESHOLD})`;

  const listSectors = async (
    q: LegacyDimensionQuery
  ): Promise<Result<LegacyDimensionRows<LegacySectorRow>, ApiError>> => {
    try {
      const conds: RawBuilder<unknown>[] = [];
      if (q.search !== undefined)
        conds.push(descriptionSearch(sql.ref('s.sector_description'), q.search));
      if (q.ids !== undefined && q.ids.length > 0) {
        conds.push(
          sql`s.sector_id in (${sql.join(
            q.ids.map((id) => sql`${id}`),
            sql`, `
          )})`
        );
      }
      const where = whereOf(conds);
      const page = await paged(
        sql<{ sector_id: number; sector_description: string | null; total_count: string }>`
          select s.sector_id, s.sector_description, count(*) over() as total_count
          from budget.budget_sectors as s
          ${where}
          order by s.sector_id asc
          limit ${q.limit} offset ${q.offset}
        `,
        sql<{
          total_count: string;
        }>`select count(*) as total_count from budget.budget_sectors as s ${where}`
      );
      return ok({
        rows: page.rows.map((r) => ({
          sectorId: r.sector_id,
          sectorDescription: r.sector_description,
        })),
        totalCount: page.totalCount,
      });
    } catch (error) {
      return err(databaseError('legacy listSectors failed', error));
    }
  };

  const listFundingSources = async (
    q: LegacyDimensionQuery
  ): Promise<Result<LegacyDimensionRows<LegacyFundingSourceRow>, ApiError>> => {
    try {
      const conds: RawBuilder<unknown>[] = [sql`fs.source_code is not null`];
      if (q.search !== undefined)
        conds.push(descriptionSearch(sql.ref('fs.source_description'), q.search));
      if (q.ids !== undefined && q.ids.length > 0) {
        conds.push(
          sql`fs.source_id in (${sql.join(
            q.ids.map((id) => sql`${id}`),
            sql`, `
          )})`
        );
      }
      const where = whereOf(conds);
      const page = await paged(
        sql<{ source_id: number; source_description: string | null; total_count: string }>`
          select fs.source_id, fs.source_description, count(*) over() as total_count
          from budget.v_funding_sources_compat as fs
          ${where}
          order by fs.source_id asc
          limit ${q.limit} offset ${q.offset}
        `,
        sql<{
          total_count: string;
        }>`select count(*) as total_count from budget.v_funding_sources_compat as fs ${where}`
      );
      return ok({
        rows: page.rows.map((r) => ({
          sourceId: r.source_id,
          sourceDescription: r.source_description,
        })),
        totalCount: page.totalCount,
      });
    } catch (error) {
      return err(databaseError('legacy listFundingSources failed', error));
    }
  };

  const listClassifications = async (
    kind: LegacyClassificationKind,
    q: LegacyClassificationQuery
  ): Promise<Result<LegacyDimensionRows<LegacyClassificationRow>, ApiError>> => {
    const table =
      kind === 'functional'
        ? sql.ref('budget.functional_classifications')
        : sql.ref('budget.economic_classifications');
    const code = kind === 'functional' ? sql.ref('d.functional_code') : sql.ref('d.economic_code');
    const name = kind === 'functional' ? sql.ref('d.functional_name') : sql.ref('d.economic_name');
    try {
      const conds: RawBuilder<unknown>[] = [];
      if (q.search !== undefined) {
        // Legacy lower-cased the term and passed it UNESCAPED (wildcards act).
        const term = q.search.toLowerCase();
        if (kind === 'functional' && isCodeLike(term)) {
          conds.push(sql`${code} ilike ${`${term}%`}`);
        } else {
          const pattern = `%${term}%`;
          conds.push(
            sql`(unaccent(${code}) ilike unaccent(${pattern}) or unaccent(${name}) ilike unaccent(${pattern}))`
          );
        }
      }
      if (q.codes !== undefined && q.codes.length > 0) {
        conds.push(
          sql`${code} in (${sql.join(
            q.codes.map((c) => sql`${c}`),
            sql`, `
          )})`
        );
      }
      const where = whereOf(conds);
      const page = await paged(
        sql<{ code: string; name: string | null; total_count: string }>`
          select ${code} as code, ${name} as name, count(*) over() as total_count
          from ${table} as d
          ${where}
          order by ${code} asc
          limit ${q.limit} offset ${q.offset}
        `,
        sql<{ total_count: string }>`select count(*) as total_count from ${table} as d ${where}`
      );
      return ok({
        rows: page.rows.map((r) => ({ code: r.code, name: r.name })),
        totalCount: page.totalCount,
      });
    } catch (error) {
      return err(databaseError(`legacy listClassifications(${kind}) failed`, error));
    }
  };

  return { listSectors, listFundingSources, listClassifications };
};
