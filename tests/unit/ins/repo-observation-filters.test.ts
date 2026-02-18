import { Kysely, PostgresDialect } from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeInsRepo } from '@/modules/ins/shell/repo/ins-repo.js';

import type { InsObservationFilter } from '@/modules/ins/core/types.js';

const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // compile-only; queries are never executed
  }),
});

function compileFilteredQuery(filter: InsObservationFilter): {
  sql: string;
  parameters: readonly unknown[];
} {
  const repo = makeInsRepo(db as never) as unknown as {
    applyObservationFilters: (
      query: unknown,
      input: InsObservationFilter | undefined
    ) => {
      isErr: () => boolean;
      error?: { message: string };
      value?: {
        select: (column: string) => {
          compile: () => { sql: string; parameters: readonly unknown[] };
        };
      };
    };
  };

  const baseQuery = db
    .selectFrom('statistics as s')
    .innerJoin('time_periods as tp', 'tp.id', 's.time_period_id')
    .leftJoin('territories as t', 't.id', 's.territory_id')
    .leftJoin('units_of_measure as u', 'u.id', 's.unit_id');

  const result = repo.applyObservationFilters(baseQuery, filter);
  if (result.isErr()) {
    throw new Error(result.error?.message ?? 'Expected filter to compile');
  }
  if (result.value === undefined) {
    throw new Error('Expected compiled query to be available');
  }

  return result.value.select('s.id').compile();
}

describe('INS repo observation filters', () => {
  it('uses type-aware matching when both classification type and value filters are set', () => {
    const compiled = compileFilteredQuery({
      classification_type_codes: ['AGE_GROUP', 'SEX'],
      classification_value_codes: ['TOTAL'],
    });

    const typeEqualityMatches = compiled.sql.match(/"ct"\."code"\s*=\s*\$\d+/g) ?? [];

    expect(typeEqualityMatches.length).toBe(2);
    expect(compiled.parameters).toContain('AGE_GROUP');
    expect(compiled.parameters).toContain('SEX');
    expect(compiled.parameters).toContain('TOTAL');
    expect(compiled.sql.toLowerCase()).not.toContain('"ct"."code" in');
  });

  it('keeps value-only filtering behavior when only classification values are provided', () => {
    const compiled = compileFilteredQuery({
      classification_value_codes: ['TOTAL', 'F'],
    });

    expect(compiled.sql.toLowerCase()).toContain('"cv"."code" in');
    expect(compiled.sql.toLowerCase()).not.toContain('"ct"."code" =');
  });

  it('keeps type-only filtering behavior when only classification types are provided', () => {
    const compiled = compileFilteredQuery({
      classification_type_codes: ['AGE_GROUP', 'SEX'],
    });

    expect(compiled.sql.toLowerCase()).toContain('"ct"."code" in');
    expect(compiled.sql.toLowerCase()).not.toContain('"ct"."code" =');
    expect(compiled.sql.toLowerCase()).not.toContain('"cv"."code" in');
  });
});
