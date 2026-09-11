/**
 * The budget module's native population readers over the kernel port
 * (codebase plan §WP3, T-13), with no DB:
 *  - `readMapPopulationAnchorSets` — one statement for every scope, the union
 *    CTE pruning ancestors per scope in position order (pinned text);
 *  - `readNativeAnnualScopePopulation` — the anchors of a scope come from the
 *    snapshot's transaction, the cells from the port; a year with any missing
 *    cell is ABSENT (never a partial sum), unavailable anchors and an invalid
 *    cell are ServiceUnavailable, zero-total years are dropped.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { readNativeAnnualScopePopulation } from '@/modules/budget/shell/native/annual-scope-population.js';
import { readMapPopulationAnchorSets } from '@/modules/budget/shell/repo/map-population-anchors.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { AnnualPopulationCell, AnnualPopulationSnapshot } from '@/modules/shared/index.js';

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** The union kernel shared by every anchor read (population-union.ts), flattened. */
const UNION_CTES =
  'selected as ( select distinct id, parent_id, level, territorial_siruta_code, population from matched where id is not null ), ' +
  'walk (origin_id, id, parent_id, level, territorial_siruta_code) as ( select id, id, parent_id, level, territorial_siruta_code from selected ' +
  'union all select w.origin_id, p.id, p.parent_id, p.level, p.territorial_siruta_code from walk w left join core.territories p on p.id = w.parent_id where w.parent_id is not null ) ' +
  'cycle id set is_cycle using visited_path, ' +
  'retained as ( select d.* from selected d where not exists ( select 1 from walk w join selected ancestor on ancestor.id = w.id where w.origin_id = d.id and w.id <> d.id ) ), ' +
  'invalid as ( select 1 from matched where id is null union all select 1 from walk w where w.is_cycle or w.id is null or w.level is null ' +
  "or (w.parent_id is null and not coalesce(( w.level = 'country' " +
  "or (w.level = 'county' and not exists ( select 1 from core.territories root where root.level = 'country' )) " +
  "or (w.level = 'uat' and w.territorial_siruta_code = '179132' and not exists ( select 1 from core.territories root where root.level = 'country' ) " +
  "and not exists ( select 1 from core.territories county where county.level = 'county' and county.county_code = 'B' )) ), false)) ) " +
  'select case when not exists (select 1 from invalid) and count(*) > 0 then array_agg(id order by id) else null end as ids from retained';

describe('readMapPopulationAnchorSets', () => {
  it('prunes every scope in one statement, in scope order, over public territories only', async () => {
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, { respond: () => [{ ids: [1, 2] }, { ids: null }] });
    expect(
      await readMapPopulationAnchorSets(db, [
        [1, 2],
        [3, 4],
      ])
    ).toEqual([[1, 2], null]);
    expect(captured).toHaveLength(1);
    expect(flat(captured[0]?.sql ?? '')).toBe(
      'select retained.ids from jsonb_array_elements($1::jsonb) with ordinality scopes(ids, position) cross join lateral ( ' +
        'with recursive matched as materialized ( select t.id, t.parent_id, t.level, t.territorial_siruta_code, t.population ' +
        'from jsonb_array_elements_text(scopes.ids) requested(id) ' +
        "left join core.territories t on t.id = requested.id::int and t.privacy_class = 'public' ), " +
        UNION_CTES +
        ' ) retained order by scopes.position'
    );
    expect(captured[0]?.parameters).toEqual(['[[1,2],[3,4]]']);
  });

  it('issues no statement without scopes', async () => {
    const captured: CapturedQuery[] = [];
    expect(await readMapPopulationAnchorSets(makeCapturingDb(captured), [])).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe('readNativeAnnualScopePopulation', () => {
  const COUNTRY_ANCHOR =
    "select id from core.territories where level = 'country' and kind = 'country' and nuts_code = 'RO' and territory_key = 'nuts:RO' and parent_id is null and privacy_class = 'public'";

  const snapshot = (
    anchors: readonly unknown[],
    cells: (ids: readonly number[], years: readonly number[]) => readonly AnnualPopulationCell[]
  ) => {
    const captured: CapturedQuery[] = [];
    const calls: { ids: readonly number[]; years: readonly number[] }[] = [];
    const trx = makeCapturingDb(captured, { respond: () => anchors });
    const port: AnnualPopulationSnapshot = {
      trx,
      cells: (ids, years) => {
        calls.push({ ids, years });
        return Promise.resolve(ok(cells(ids, years)));
      },
    };
    return { captured, calls, port };
  };

  it('country scope: the single canonical RO node, summed per year from the port cells', async () => {
    const { captured, calls, port } = snapshot([{ id: 1 }], (ids, years) =>
      ids.flatMap((territoryId) =>
        years.map((year) => ({
          territoryId,
          year,
          population: year === 2016 ? '22273309' : '21849217',
        }))
      )
    );
    const totals = (
      await readNativeAnnualScopePopulation(port, { kind: 'country' }, [2016, 2024])
    )._unsafeUnwrap();
    expect([...totals].map(([year, total]) => [year, total.toFixed(0)])).toEqual([
      [2016, '22273309'],
      [2024, '21849217'],
    ]);
    expect(captured.map((c) => flat(c.sql))).toEqual([COUNTRY_ANCHOR]);
    expect(calls).toEqual([{ ids: [1], years: [2016, 2024] }]);
  });

  it('a union scope reads its anchors through the union kernel and sums every anchor', async () => {
    const { captured, calls, port } = snapshot([{ ids: [7, 8] }], (ids, years) =>
      ids.flatMap((territoryId) =>
        years.map((year) => ({ territoryId, year, population: String(territoryId * 1000) }))
      )
    );
    const totals = (
      await readNativeAnnualScopePopulation(port, { kind: 'territoriesUnion', ids: [8, 7] }, [2023])
    )._unsafeUnwrap();
    expect(totals.get(2023)?.toFixed(0)).toBe('15000');
    expect(flat(captured[0]?.sql ?? '')).toBe(
      'with recursive matched as materialized ( select case when count(*) over (partition by requested.key) = 1 then t.id else null end as id, ' +
        't.parent_id, t.level, t.territorial_siruta_code, t.population ' +
        'from (select distinct key from (values ($1::int), ($2::int)) input(key)) requested ' +
        'left join core.territories t on t.id = requested.key ), ' +
        UNION_CTES
    );
    expect(captured[0]?.parameters).toEqual([8, 7]);
    expect(calls).toEqual([{ ids: [7, 8], years: [2023] }]);
  });

  it('is ServiceUnavailable when the anchors cannot be proven, without reading cells', async () => {
    for (const anchors of [[], [{ id: 1 }, { id: 2 }]]) {
      const { calls, port } = snapshot(anchors, () => []);
      expect(
        (
          await readNativeAnnualScopePopulation(port, { kind: 'country' }, [2024])
        )._unsafeUnwrapErr()
      ).toEqual({
        type: 'ServiceUnavailable',
        message: 'Population anchors are unavailable for the complete selected scope',
      });
      expect(calls).toEqual([]);
    }
    const union = snapshot([{ ids: null }], () => []);
    expect(
      (
        await readNativeAnnualScopePopulation(
          union.port,
          { kind: 'territoriesUnion', ids: [7] },
          [2024]
        )
      ).isErr()
    ).toBe(true);
    expect(union.calls).toEqual([]);
  });

  it('a year with a missing cell is absent, never a partial sum; a zero total is dropped', async () => {
    const { port } = snapshot([{ ids: [7, 8] }], (ids, years) =>
      ids.flatMap((territoryId) =>
        years.map((year) => ({
          territoryId,
          year,
          population:
            year === 2022 && territoryId === 8 ? null : year === 2023 ? '0' : String(territoryId),
        }))
      )
    );
    const totals = (
      await readNativeAnnualScopePopulation(
        port,
        { kind: 'territoriesUnion', ids: [7, 8] },
        [2021, 2022, 2023]
      )
    )._unsafeUnwrap();
    expect([...totals].map(([year, total]) => [year, total.toFixed(0)])).toEqual([[2021, '15']]);
  });

  it('an invalid cell fails the read; a port failure propagates', async () => {
    const invalid = snapshot([{ id: 1 }], (ids, years) =>
      ids.flatMap((territoryId) => years.map((year) => ({ territoryId, year, population: '-1' })))
    );
    expect(
      (
        await readNativeAnnualScopePopulation(invalid.port, { kind: 'country' }, [2024])
      )._unsafeUnwrapErr()
    ).toEqual({ type: 'ServiceUnavailable', message: 'Annual population is invalid' });

    const failing: AnnualPopulationSnapshot = {
      trx: makeCapturingDb([], { respond: () => [{ id: 1 }] }),
      cells: () => Promise.resolve(err({ type: 'Timeout', message: 'ins timed out' })),
    };
    expect(
      (
        await readNativeAnnualScopePopulation(failing, { kind: 'country' }, [2024])
      )._unsafeUnwrapErr()
    ).toEqual({ type: 'Timeout', message: 'ins timed out' });
  });
});
