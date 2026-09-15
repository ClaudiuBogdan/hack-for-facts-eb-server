import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { readMapAnnualPopulation } from '@/modules/shared/shell/population/map-annual-population.js';
import { annualPopulationResolvers } from '@/modules/shared/shell/population/population-graphql.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { AnnualPopulationPort } from '@/modules/shared/index.js';

function fixture(
  rows: { id: number; code: string | null; privacy_class: string; matches: string }[]
) {
  const queries: CapturedQuery[] = [];
  const reads: unknown[] = [];
  const port: AnnualPopulationPort = {
    withSnapshot: async (fn) =>
      fn({
        trx: makeCapturingDb(queries, { respond: () => rows }),
        cells: async (ids, years) => {
          reads.push({ ids, years });
          return ok(
            ids.map((id) => ({
              territoryId: id,
              year: years[0]!,
              population: id === 1 ? '264698' : null,
              metadata: null,
            }))
          );
        },
      }),
  };
  return { port, queries, reads };
}
describe('map annual population batch', () => {
  it.each(['UAT', 'County'] as const)(
    'batches public %s cells with stable keys and null gaps',
    async (granularity) => {
      const f = fixture([
        {
          id: 1,
          code: granularity === 'UAT' ? '179141' : 'B',
          privacy_class: 'public',
          matches: '1',
        },
        {
          id: 2,
          code: granularity === 'UAT' ? '179150' : 'CJ',
          privacy_class: 'public',
          matches: '1',
        },
        { id: 3, code: '999', privacy_class: 'restricted', matches: '1' },
      ]);
      const values = (await readMapAnnualPopulation(f.port, 2025, granularity))._unsafeUnwrap();
      expect(f.reads).toEqual([{ ids: [1, 2], years: [2025] }]);
      expect(values.map((v) => v.population)).toEqual(['264698', null]);
      expect(values[0]?.territoryCode).toBe(granularity === 'UAT' ? '179141' : 'B');
      expect(f.queries[0]?.sql).toContain('count(*) over');
      if (granularity === 'UAT') expect(f.queries[0]?.sql).toContain('179132');
    }
  );
  it('refuses ambiguous keys and does not read any population', async () => {
    const f = fixture([{ id: 1, code: 'B', privacy_class: 'public', matches: '2' }]);
    expect((await readMapAnnualPopulation(f.port, 2025, 'County')).isErr()).toBe(true);
    expect(f.reads).toEqual([]);
  });
  it('rejects invalid years without opening a snapshot', async () => {
    const f = fixture([]);
    expect((await readMapAnnualPopulation(f.port, 0, 'UAT')).isErr()).toBe(true);
    expect(f.queries).toEqual([]);
  });
  it('propagates publication failures without exposing database details', async () => {
    const port: AnnualPopulationPort = {
      withSnapshot: async () => err({ type: 'ServiceUnavailable', message: 'private db detail' }),
    };
    await expect(
      annualPopulationResolvers(port).Query.mapAnnualPopulation(null, {
        year: 2025,
        granularity: 'UAT',
      })
    ).rejects.toThrow('Map annual population is unavailable');
  });
});
