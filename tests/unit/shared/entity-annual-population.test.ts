import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { annualPopulationResolvers } from '@/modules/shared/shell/population/population-graphql.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { AnnualPopulationPort } from '@/modules/shared/index.js';

describe('entity annual population', () => {
  it.each([true, false])(
    'reads only an eligible executive anchor (%s) in the population snapshot',
    async (eligible) => {
      const queries: CapturedQuery[] = [];
      const db = makeCapturingDb(queries, {
        respond: () => (eligible ? [{ territory_id: 1138 }] : []),
      });
      const reads: unknown[] = [];
      const port: AnnualPopulationPort = {
        withSnapshot: async (fn) =>
          fn({
            trx: db,
            cells: async (ids, years) => {
              reads.push({ ids, years });
              return ok([{ territoryId: 1138, year: 2021, population: '259084', metadata: null }]);
            },
          }),
      };
      const result = await annualPopulationResolvers(port).Entity.annualPopulation(
        { cui: '4505359' },
        { year: 2021 }
      );
      expect(queries[0]?.parameters).toEqual(['4505359']);
      expect(queries[0]?.sql).toContain('e.is_territorial_executive');
      expect(queries[0]?.sql).toContain("t.privacy_class='public'");
      expect(queries[0]?.sql).toContain("o.privacy_class<>'public'");
      if (eligible) {
        expect(reads).toEqual([{ ids: [1138], years: [2021] }]);
        expect(result?.population).toBe('259084');
      } else {
        expect(reads).toEqual([]);
        expect(result).toBeNull();
      }
    }
  );
});
