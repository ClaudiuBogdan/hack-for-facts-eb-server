/**
 * Reference module — ClassificationRepo over `core.classification_codes` (plan §3.2).
 *
 * The ONLY reader of `core.classification_codes` (CAEN rev1/2/3, 3,111 rows). PK is
 * `(system, code)`; prefix filters on `code` are index-prunable when `system` is
 * fixed. Cursor lists order by the UNIQUE full PK `(sortValue, system, code)` so a
 * non-unique `code`/`label` never skips/duplicates rows (review BLOCKER).
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
  type ResolveHit,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { mapClassification } from './mappers.js';
import { referenceClassificationFilterSpec } from '../../core/filters.js';

import type { CursorPageRequest, ClassificationRepo } from '../../core/ports.js';
import type { ReferenceClassificationCode } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);
const clampLimit = (limit: number, max = 50): number =>
  Math.min(Math.max(Math.floor(limit), 1), max);
const escapeLike = (s: string): string => s.replace(/[%_\\]/gu, '\\$&');

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const SORT_COLUMN: Record<string, string> = { code: 'c.code', label: 'c.label' };

export const makeClassificationRepo = (db: Db): ClassificationRepo => {
  const findOne = async (
    system: string,
    code: string
  ): Promise<Result<ReferenceClassificationCode | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('core.classification_codes as c')
        .select(['c.system', 'c.code', 'c.label', 'c.parent_code'])
        .where('c.system', '=', system)
        .where('c.code', '=', code)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapClassification(row));
    } catch (error) {
      return err(databaseError('findOne failed', error));
    }
  };

  const list = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ReferenceClassificationCode>, ApiError>> => {
    const sortField =
      page.sort !== undefined && page.sort in SORT_COLUMN
        ? page.sort
        : referenceClassificationFilterSpec.sort.default;
    const sortCol = SORT_COLUMN[sortField] ?? 'c.code';
    const limit = clampFirst(page.first);
    const fhash = fhashFor(referenceClassificationFilterSpec, f);

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortField, dir: 'asc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const kernel = toConditionBuilders(referenceClassificationFilterSpec, f);
    if (kernel.isErr()) return err(kernel.error);
    const conds = [...kernel.value];
    // Keyset on (sortValue, system, code) — the unique full PK tiebreak. The sort is
    // `<col> asc NULLS LAST`, so for the nullable `label` sort the cursor must reach
    // the trailing null-label section: a non-null cursor keeps rows strictly after it
    // INCLUDING null-label rows (`col IS NULL`); a null cursor ('' sentinel) keeps
    // only further rows by the (system, code) PK tiebreak (review BLOCKER). `code` is
    // the non-null PK so its null branches never fire.
    if (cursorKeys?.length === 3) {
      const sv = cursorKeys[0] ?? '';
      const cSys = cursorKeys[1] ?? '';
      const cCode = cursorKeys[2] ?? '';
      const col = sql.ref(sortCol);
      const pkAfter = sql`(c.system > ${cSys} or (c.system = ${cSys} and c.code > ${cCode}))`;
      if (sv === '' && sortField === 'label') {
        // Inside the null-label section: only the PK tiebreak advances.
        conds.push(sql`(${col} is null and ${pkAfter})`);
      } else {
        conds.push(sql`(${col} > ${sv} or ${col} is null or (${col} = ${sv} and ${pkAfter}))`);
      }
    }

    try {
      const rows = await db
        .selectFrom('core.classification_codes as c')
        .select(['c.system', 'c.code', 'c.label', 'c.parent_code'])
        .where(composeWhere(conds))
        .orderBy(sql`${sql.ref(sortCol)} asc nulls last`)
        .orderBy('c.system', 'asc')
        .orderBy('c.code', 'asc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapClassification(r));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          const sv = sortField === 'label' ? (last.label ?? '') : last.code;
          next = buildNextCursor({
            sort: sortField,
            dir: 'asc',
            fhash,
            lastKeys: [sv, last.system, last.code],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('list failed', error));
    }
  };

  const resolve = async (
    system: string | null,
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = clampLimit(limit, 50);
    const pattern = `%${escapeLike(needle)}%`;
    try {
      // The OR must be PARENTHESIZED — a bare `code ILIKE … OR label ILIKE …` AND-ed
      // with `system = …` binds as `code ILIKE … OR (label ILIKE … AND system = …)`,
      // leaking other systems' code matches (review SHOULD-FIX).
      let query = db
        .selectFrom('core.classification_codes as c')
        .select(['c.system', 'c.code', 'c.label'])
        .where(
          sql<boolean>`(c.code ilike ${pattern} escape '\\' or c.label ilike ${pattern} escape '\\')`
        );
      if (system !== null) query = query.where('c.system', '=', system);
      const rows = await query.orderBy('c.code', 'asc').limit(capped).execute();
      return ok(
        rows.map(
          (r): ResolveHit => ({
            kind: 'classification',
            value: r.code,
            label: r.label ?? r.code,
            hint: r.system,
          })
        )
      );
    } catch (error) {
      return err(databaseError('resolve failed', error));
    }
  };

  const listSystems = async (): Promise<
    Result<readonly { readonly system: string; readonly count: number }[], ApiError>
  > => {
    try {
      const rows = await db
        .selectFrom('core.classification_codes as c')
        .select(['c.system', sql<string>`count(*)`.as('cnt')])
        .groupBy('c.system')
        .orderBy('c.system', 'asc')
        .execute();
      return ok(rows.map((r) => ({ system: r.system, count: Number(r.cnt) })));
    } catch (error) {
      return err(databaseError('listSystems failed', error));
    }
  };

  return { findOne, list, resolve, listSystems };
};
