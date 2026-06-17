/**
 * Judicial module — courts repo (plan 08 §4). Reads `justice.courts` (246-row
 * reference). Cheap; full scans acceptable. No PII in this table.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  toConditionBuilders,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { composeWhere } from './filter-helpers.js';
import { judicialCourtsSpec } from '../filters/judicial.spec.js';

import type { CourtListOptions, JudicialCourtRepo } from '../../core/ports.js';
import type { JudicialCourt, JudicialCourtLevel, JudicialMappingConfidence } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const COURT_COLUMNS = [
  'co.institution_code',
  'co.ordinal',
  'co.court_level',
  'co.specialization',
  'co.locality',
  'co.county_code',
  'co.parent_institution_code',
  'co.mapping_confidence',
] as const;

interface CourtRow {
  institution_code: string;
  ordinal: number;
  court_level: string;
  specialization: string | null;
  locality: string | null;
  county_code: string | null;
  parent_institution_code: string | null;
  mapping_confidence: string;
}

const mapCourt = (r: CourtRow): JudicialCourt => ({
  institutionCode: r.institution_code,
  ordinal: r.ordinal,
  courtLevel: r.court_level as JudicialCourtLevel,
  specialization: r.specialization,
  locality: r.locality,
  countySirutaCode: r.county_code,
  parentInstitutionCode: r.parent_institution_code,
  mappingConfidence: r.mapping_confidence as JudicialMappingConfidence,
});

export const makeJudicialCourtRepo = (db: Db): JudicialCourtRepo => {
  const baseSelect = () => db.selectFrom('justice.courts as co').select(COURT_COLUMNS);

  const list = async (opts: CourtListOptions): Promise<Result<readonly JudicialCourt[], ApiError>> => {
    const built = toConditionBuilders(judicialCourtsSpec, opts.filter);
    if (built.isErr()) return err(built.error);
    const where = composeWhere(built.value);
    try {
      const rows = await baseSelect().where(where).orderBy('co.ordinal', 'asc').execute();
      return ok(rows.map(mapCourt));
    } catch (error) {
      return err(databaseError('courts.list failed', error));
    }
  };

  const getByCode = async (code: string): Promise<Result<JudicialCourt | null, ApiError>> => {
    try {
      const row = await baseSelect().where('co.institution_code', '=', code).limit(1).executeTakeFirst();
      return ok(row === undefined ? null : mapCourt(row));
    } catch (error) {
      return err(databaseError('courts.getByCode failed', error));
    }
  };

  const listChildren = async (code: string): Promise<Result<readonly JudicialCourt[], ApiError>> => {
    try {
      const rows = await baseSelect()
        .where('co.parent_institution_code', '=', code)
        .orderBy('co.ordinal', 'asc')
        .execute();
      return ok(rows.map(mapCourt));
    } catch (error) {
      return err(databaseError('courts.listChildren failed', error));
    }
  };

  const resolveCourt = async (q: string, limit: number): Promise<Result<readonly JudicialCourt[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const pattern = '%' + needle.replace(/[\\%_]/gu, (m) => `\\${m}`) + '%';
    try {
      const rows = await baseSelect()
        .where(
          sql<boolean>`(co.locality ilike ${pattern} escape '\\' or co.institution_code ilike ${pattern} escape '\\')`
        )
        .orderBy('co.ordinal', 'asc')
        .limit(capped)
        .execute();
      return ok(rows.map(mapCourt));
    } catch (error) {
      return err(databaseError('courts.resolveCourt failed', error));
    }
  };

  const resolveCategory = async (
    q: string,
    limit: number
  ): Promise<Result<readonly { value: string; label: string | null }[], ApiError>> => {
    const needle = q.trim();
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const pattern = '%' + needle.replace(/[\\%_]/gu, (m) => `\\${m}`) + '%';
    try {
      // distinct category/category_name from cases. Bounded by the limit; category
      // is low-cardinality so this is cheap even unindexed.
      const rows = await db
        .selectFrom('justice.cases as c')
        .select(['c.category', sql<string | null>`max(c.category_name)`.as('category_name')])
        .where('c.category', 'is not', null)
        .$if(needle !== '', (qb) =>
          qb.where(
            sql<boolean>`(c.category ilike ${pattern} escape '\\' or c.category_name ilike ${pattern} escape '\\')`
          )
        )
        .groupBy('c.category')
        .orderBy('c.category', 'asc')
        .limit(capped)
        .execute();
      return ok(
        rows
          .filter((r): r is { category: string; category_name: string | null } => r.category !== null)
          .map((r) => ({ value: r.category, label: r.category_name }))
      );
    } catch (error) {
      return err(databaseError('courts.resolveCategory failed', error));
    }
  };

  return { list, getByCode, listChildren, resolveCourt, resolveCategory };
};
