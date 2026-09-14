import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { publishedAnnualPopulation } from './published-population.js';
import { databaseError, type ApiError } from '../../core/errors.js';

import type { AnnualPopulationCell, AnnualPopulationPort } from './annual-population-port.js';
import type { ProdDatabase } from '../db/types.js';

const PublicLocator = Type.Object(
  {
    datasetCode: Type.Optional(Type.String({ maxLength: 32 })),
    revisionId: Type.Optional(Type.String({ maxLength: 32 })),
    responseId: Type.Optional(Type.String({ maxLength: 128 })),
    sheet: Type.Optional(Type.String({ maxLength: 256 })),
    cell: Type.Optional(Type.String({ maxLength: 512 })),
    periodId: Type.Optional(Type.Integer()),
    timeMember: Type.Optional(Type.Integer()),
    ageMember: Type.Optional(Type.Integer()),
    sexMember: Type.Optional(Type.Integer()),
    unitMember: Type.Optional(Type.Integer()),
    geoPairs: Type.Optional(
      Type.Array(Type.Tuple([Type.Integer(), Type.Integer()]), { maxItems: 2 })
    ),
  },
  { additionalProperties: false }
);

/** Internal capture object locations stay in the operator audit manifest. */
export function publicPopulationLocator(
  value: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (value === null) return null;
  const locator = Object.fromEntries(
    Object.entries(value).filter(([key]) => Object.hasOwn(PublicLocator.properties, key))
  );
  return Value.Check(PublicLocator, locator) ? locator : null;
}

/** Indexed published denominators. All source selection/carry happens in ETL. */
export async function readCuratedPopulation(
  db: Kysely<ProdDatabase>,
  territoryIds: readonly number[],
  years: readonly number[]
): Promise<Result<readonly AnnualPopulationCell[], ApiError>> {
  const ids = [...new Set(territoryIds)];
  const selectedYears = [...new Set(years)];
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    selectedYears.some((year) => !Number.isInteger(year) || year < 1 || year > 9999)
  )
    return err({
      type: 'InvalidInput',
      field: 'population',
      message: 'Invalid population territory or year',
    });
  if (ids.length === 0 || selectedYears.length === 0) return ok([]);
  try {
    const rows = await sql<{
      territory_id: number;
      applied_year: number;
      population: string;
      calculation: 'SOURCE' | 'TERRITORY_SUM';
      source_year_min: number;
      source_year_max: number;
      carried_count: number;
      provisional_count: number;
      constituent_count: number;
      source_code: string | null;
      source_url: string | null;
      source_sha256: string | null;
      publication_status: string | null;
      source_locator: Record<string, unknown> | null;
      load_run_id: string;
      input_sha256: string;
    }>`select p.*, p.population::text as population, p.load_run_id::text as load_run_id
      from ${publishedAnnualPopulation} p
      join core.territories t on t.id=p.territory_id and t.privacy_class='public'
      where p.territory_id=any(${ids}::int[]) and p.applied_year=any(${selectedYears}::int[])`.execute(
      db
    );
    const cells = new Map(
      rows.rows.map((row) => [`${String(row.territory_id)}/${String(row.applied_year)}`, row])
    );
    return ok(
      ids.flatMap((territoryId) =>
        selectedYears.map((year): AnnualPopulationCell => {
          const row = cells.get(`${String(territoryId)}/${String(year)}`);
          return {
            territoryId,
            year,
            population: row?.population ?? null,
            metadata:
              row === undefined
                ? null
                : {
                    calculation: row.calculation,
                    sourceYearMin: row.source_year_min,
                    sourceYearMax: row.source_year_max,
                    maxCarryAge: year - row.source_year_min,
                    carriedCount: row.carried_count,
                    provisionalCount: row.provisional_count,
                    constituentCount: row.constituent_count,
                    sourceCode: row.source_code,
                    sourceUrl: row.source_url,
                    sourceSha256: row.source_sha256,
                    publicationStatus: row.publication_status,
                    sourceLocator: publicPopulationLocator(row.source_locator),
                    loadRunId: row.load_run_id,
                    inputSha256: row.input_sha256,
                  },
          };
        })
      )
    );
  } catch (cause) {
    return err(databaseError('Published annual population is unavailable', cause));
  }
}

export const makeCuratedAnnualPopulationPort = (
  db: Kysely<ProdDatabase>
): AnnualPopulationPort => ({
  withSnapshot: async (fn) => {
    try {
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          await sql`set local statement_timeout='30s'`.execute(trx);
          await sql`set local transaction_timeout='35s'`.execute(trx);
          return fn({ trx, cells: (ids, years) => readCuratedPopulation(trx, ids, years) });
        });
    } catch (cause) {
      return err(databaseError('Annual population snapshot failed', cause));
    }
  },
});
