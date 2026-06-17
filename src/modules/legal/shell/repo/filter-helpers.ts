/**
 * Legal repo — filter-input + cursor helpers (plan §3/§7).
 *
 * `year`/`yearFrom`/`yearTo` all map to the same physical column `a.act_year`;
 * the kernel composer handles them directly (eq/gte/lte) so there are NO virtual
 * fields in legal (unlike pnrr). These helpers cover: composing the kernel
 * conditions, the unconditional canonical JOIN, and the `(sortcol, act_id)`
 * keyset cursor where `act_id` is the bigint tiebreaker.
 */

import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
  toConditionBuilders,
} from '@/modules/shared/index.js';

/** Join a list of conditions with AND (TRUE if empty). */
export const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** Compile the spec's kernel-composed conditions (TRUE if none). */
export const kernelConditions = (
  spec: CollectionFilterSpec,
  input: FilterInput
): Result<RawBuilder<SqlBool>, ApiError> => {
  const built = toConditionBuilders(spec, input);
  if (built.isErr()) return err(built.error);
  return ok(composeWhere(built.value));
};

/** Clamp a list `first` into [1, max]. */
export const clampLimit = (first: number, max: number): number =>
  Math.min(Math.max(Math.floor(first), 1), max);

/**
 * The FIXED canonical-join FROM for the acts list (§7.1). Returns the alias map
 * `a`/`d`/`s` so the spec's per-field aliases resolve. The `is_canonical`
 * predicate is in the JOIN so a multi-document act yields exactly one summary row.
 */
export const actsListFrom = sql`
  legal.acts a
  left join legal.act_documents d on d.act_id = a.act_id and d.is_canonical
  left join legal.document_summaries s on s.document_id = d.document_id
`;

/**
 * Build the keyset cursor predicate for a `(sortExpr, act_id)` tuple. `sortExpr`
 * is a trusted internal SQL fragment (the sort column / expression); `actId` is
 * the bigint tiebreaker compared as `::bigint` (NOT text — string ordering would
 * mis-sort '9' vs '100'). NULL sort values sort LAST in both directions; the
 * cursor encodes a NULL sort value as the empty-string sentinel.
 *
 *  - desc: keep rows strictly "after" (sort < c, or sort = c and act_id < key,
 *    plus the trailing NULL section when c is non-null).
 *  - asc: mirror image.
 */
/** The sort-value cast kind (a closed set, so each maps to a typed sql fragment). */
export type SortCast = 'int' | 'date' | 'text';

/** Bind the cursor sort value with its proper type (no `sql.raw` — closed set). */
const castValue = (cVal: string, cast: SortCast): RawBuilder<unknown> => {
  switch (cast) {
    case 'int':
      return sql`${cVal}::int`;
    case 'date':
      return sql`${cVal}::date`;
    case 'text':
      return sql`${cVal}`;
  }
};

export const keysetCursor = (
  sortExpr: RawBuilder<unknown>,
  cast: SortCast,
  cVal: string,
  cActId: string,
  dir: 'asc' | 'desc'
): RawBuilder<unknown> => {
  const actId = sql`a.act_id`;
  const k = sql`${cActId}::bigint`;
  const cmp = dir === 'desc' ? sql`<` : sql`>`;
  if (cVal === '') {
    // Already inside the NULL-sort section: only the act_id tiebreak applies.
    return sql`(${sortExpr} is null and ${actId} ${cmp} ${k})`;
  }
  const v = castValue(cVal, cast);
  // Both directions are NULLS LAST, so the trailing null-sort section comes AFTER
  // every non-null row. From a non-null cursor we must therefore keep `sortExpr IS
  // NULL` rows reachable in BOTH directions — otherwise the null section is skipped
  // (Codex finding: the asc path dropped it).
  if (dir === 'desc') {
    // sort desc nulls last: smaller sort, OR the null section, OR equal+key.
    return sql`(${sortExpr} ${cmp} ${v} or ${sortExpr} is null or (${sortExpr} = ${v} and ${actId} ${cmp} ${k}))`;
  }
  // sort asc nulls last: larger sort, OR the null section, OR equal+key.
  return sql`(${sortExpr} ${cmp} ${v} or ${sortExpr} is null or (${sortExpr} = ${v} and ${actId} ${cmp} ${k}))`;
};
