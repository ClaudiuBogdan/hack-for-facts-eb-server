/**
 * Budget module — discovery / name-resolution repo (plan §7.4/§7.5).
 *
 * Resolves Romanian names → filter values (the Entity Resolution Gate):
 *  - `entity`     → CUI, via core.public_entities (GIN pg_trgm on `name`).
 *  - `territory`  → SIRUTA/uat, via core.territories (the kernel territory hub).
 *  - `functional` / `economic` → CODE prefix only (the classification CATALOGS
 *    are EMPTY in prod — names live denormalized on the 126M fact rows, which are
 *    too large to substring-scan). A code-prefix query hits the dim table (returns
 *    nothing while empty); a name query returns a caveat-style empty result rather
 *    than scanning facts. Long-term: a loader-built distinct catalog (DESIGN).
 *
 * Diacritic folding is done in TS (§15.7 — `unaccent` is not installed and C-locale
 * `lower()` does not fold Ș/Ț/Ă/Î/Â); the pg_trgm GIN index tolerates the raw query.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { BudgetDiscoveryRepo } from '../../core/ports.js';
import type { BudgetResolveDim, ResolveMatch } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const clampLimit = (n: number): number => Math.min(Math.max(Math.floor(n), 1), 25);

const likePattern = (q: string): string => `%${q.trim().replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;

const looksLikeCode = (q: string): boolean => /^[0-9][0-9.]*$/u.test(q.trim());

export const makeBudgetDiscoveryRepo = (db: Db): BudgetDiscoveryRepo => {
  const resolveEntity = async (q: string, limit: number): Promise<readonly ResolveMatch[]> => {
    const pattern = likePattern(q);
    const rows = await db
      .selectFrom('core.public_entities as e')
      .select(['e.cui', 'e.name', 'e.entity_type', 'e.is_uat'])
      .where(sql<boolean>`e.name ilike ${pattern} escape '\\'`)
      .orderBy(sql`length(e.name)`)
      .limit(limit + 1)
      .execute();
    const ambiguous = rows.length > limit;
    return rows.slice(0, limit).map((r) => ({
      dim: 'entity' as const,
      value: r.cui,
      label: r.name,
      hint: r.is_uat === true ? 'UAT' : (r.entity_type ?? null),
      score: null,
      ambiguous,
    }));
  };

  const resolveTerritory = async (q: string, limit: number): Promise<readonly ResolveMatch[]> => {
    const pattern = likePattern(q);
    const rows = await db
      .selectFrom('core.territories as t')
      .select(['t.territorial_siruta_code', 't.name', 't.county_name', 't.county_code'])
      .where(
        sql<boolean>`(t.name ilike ${pattern} escape '\\' or t.county_name ilike ${pattern} escape '\\')`
      )
      .where('t.territorial_siruta_code', 'is not', null)
      .where('t.level', 'in', ['county', 'uat', 'locality'])
      .where(
        sql<boolean>`exists (select 1 from core.public_entities pe where pe.territory_id = t.id)`
      )
      .orderBy(sql`length(t.name)`)
      .limit(limit + 1)
      .execute();
    const ambiguous = rows.length > limit;
    return rows
      .slice(0, limit)
      .filter(
        (r): r is typeof r & { territorial_siruta_code: string } =>
          r.territorial_siruta_code !== null
      )
      .map((r) => ({
        dim: 'territory' as const,
        value: r.territorial_siruta_code,
        label: r.name,
        hint: r.county_name ?? r.county_code ?? null,
        score: null,
        ambiguous,
      }));
  };

  const resolveClassification = async (
    dim: 'functional' | 'economic',
    q: string,
    limit: number
  ): Promise<readonly ResolveMatch[]> => {
    const table =
      dim === 'functional'
        ? 'budget.functional_classifications'
        : 'budget.economic_classifications';
    const codeCol = dim === 'functional' ? 'functional_code' : 'economic_code';
    const nameCol = dim === 'functional' ? 'functional_name' : 'economic_name';
    const code = sql.ref(`d.${codeCol}`);
    const name = sql.ref(`d.${nameCol}`);
    const tableRef = sql.ref(table);
    // Code prefix uses the dim table directly; a name query also tries the dim
    // table but it is empty in prod, so this returns nothing + the caller's caveat.
    const cond = looksLikeCode(q)
      ? sql`${code} like ${`${q.trim()}%`}`
      : sql`${name} ilike ${likePattern(q)} escape '\\'`;
    const stmt = sql<{ code: string; name: string | null }>`
      select ${code} as code, ${name} as name
      from ${tableRef} as d
      where ${cond}
      order by ${code} asc
      limit ${limit}
    `;
    const result = await stmt.execute(db);
    return result.rows.map((r) => ({
      dim,
      value: r.code,
      label: r.name ?? r.code,
      hint: null,
      score: null,
      ambiguous: false,
    }));
  };

  const resolve = async (
    dim: BudgetResolveDim,
    q: string,
    rawLimit: number
  ): Promise<Result<readonly ResolveMatch[], ApiError>> => {
    if (q.trim().length < 2) return err(invalidInput('query must be at least 2 characters', 'q'));
    const limit = clampLimit(rawLimit);
    try {
      switch (dim) {
        case 'entity':
          return ok(await resolveEntity(q, limit));
        case 'territory':
          return ok(await resolveTerritory(q, limit));
        case 'functional':
        case 'economic':
          return ok(await resolveClassification(dim, q, limit));
        default:
          return err(invalidInput(`unknown resolve dimension '${String(dim)}'`, 'dim'));
      }
    } catch (error) {
      return err(databaseError('resolve failed', error));
    }
  };

  return { resolve };
};
