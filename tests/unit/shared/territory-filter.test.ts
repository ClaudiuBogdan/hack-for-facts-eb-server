/**
 * Kernel cui→territory filter builder (no live DB). Verifies that
 * `buildTerritoryCuiPredicate` compiles geographic filter VALUES into a
 * parameterized `cui IN (SELECT pe.cui FROM core.public_entities pe …)` semijoin:
 *   - every user value is a bound parameter (never concatenated);
 *   - the `core.territories` join is emitted only when a territories-only dimension
 *     (region/county/siruta/population) is requested — pruned for `isUat`-only;
 *   - inclusion vs exclusion compile to `IN (…)` vs `NOT (… IN (…))`;
 *   - an empty include array compiles to `false` (match-nothing), never widening;
 *   - no geographic dimension → `undefined` (the caller omits the predicate).
 */

import { describe, expect, it } from 'vitest';

import {
  buildTerritoryCuiPredicate,
  hasTerritoryFilter,
} from '@/modules/shared/shell/filters/territory.js';

import { compileCondition } from './helpers.js';

const CUI_COL = { alias: 'ces', column: 'cui' } as const;

describe('buildTerritoryCuiPredicate — semijoin shape', () => {
  it('region IN compiles to a parameterized cui semijoin with the territories join', () => {
    const pred = buildTerritoryCuiPredicate(CUI_COL, { region: ['Vest', 'Centru'] });
    expect(pred).not.toBeUndefined();
    const { sql, parameters } = compileCondition(pred!);
    expect(sql).toContain('"ces"."cui" in (select pe.cui from core.public_entities pe');
    expect(sql).toContain(
      'join core.territories t on t.territorial_siruta_code = pe.territorial_siruta_code'
    );
    expect(sql).toContain('t.region in ($1, $2)');
    expect(parameters).toEqual(['Vest', 'Centru']);
  });

  it('siruta matches the canonical territorial_siruta_code join key', () => {
    const { sql, parameters } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { siruta: ['120726'] })!
    );
    expect(sql).toContain('t.territorial_siruta_code in ($1)');
    expect(parameters).toEqual(['120726']);
  });

  it('isUat-only prunes the territories join (the column lives on public_entities)', () => {
    const { sql, parameters } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { isUat: false })!
    );
    expect(sql).toContain('from core.public_entities pe where');
    expect(sql).not.toContain('core.territories');
    expect(sql).toContain('pe.is_uat = $1');
    expect(parameters).toEqual([false]);
  });

  it('population range compiles to inclusive >= / <= bounds', () => {
    const { sql, parameters } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { populationMin: 10000, populationMax: 50000 })!
    );
    expect(sql).toContain('join core.territories t');
    expect(sql).toMatch(/t\.population >= \$1 and t\.population <= \$2/iu);
    expect(parameters).toEqual([10000, 50000]);
  });

  it('exclusion negates membership (NOT (… IN (…)))', () => {
    const { sql, parameters } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { excludeRegion: ['Bucuresti-Ilfov'] })!
    );
    expect(sql).toContain('not (t.region in ($1))');
    expect(parameters).toEqual(['Bucuresti-Ilfov']);
  });

  it('multiple dimensions AND together inside the subquery', () => {
    const { sql, parameters } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { region: ['Vest'], isUat: true, populationMin: 5000 })!
    );
    expect(sql).toContain('t.region in ($1)');
    expect(sql).toContain('pe.is_uat = $2');
    expect(sql).toContain('t.population >= $3');
    expect(parameters).toEqual(['Vest', true, 5000]);
  });

  it('an empty include array alongside a set dimension compiles to false (match-nothing, never widens)', () => {
    // `{ region: [], isUat: true }`: region empty doesn't add the join, but it must
    // still force match-nothing rather than silently degrade to just the isUat filter.
    const { sql } = compileCondition(
      buildTerritoryCuiPredicate(CUI_COL, { region: [], isUat: true })!
    );
    expect(sql).toContain('false');
    expect(sql).toContain('pe.is_uat = $1');
  });

  it('no geographic dimension → undefined, but empty inclusion alone still compiles to false', () => {
    expect(buildTerritoryCuiPredicate(CUI_COL, {})).toBeUndefined();
    const { sql } = compileCondition(buildTerritoryCuiPredicate(CUI_COL, { region: [] })!);
    expect(sql).toContain('where false');
  });

  it('rejects an unsafe cui column identifier (spec invariant — throws)', () => {
    expect(() =>
      buildTerritoryCuiPredicate({ alias: 'ces', column: 'cui; drop' }, { region: ['Vest'] })
    ).toThrow();
  });
});

describe('hasTerritoryFilter', () => {
  it('is true only when a geographic dimension is set', () => {
    expect(hasTerritoryFilter({})).toBe(false);
    expect(hasTerritoryFilter({ region: [] })).toBe(true);
    expect(hasTerritoryFilter({ region: ['Vest'] })).toBe(true);
    expect(hasTerritoryFilter({ isUat: true })).toBe(true);
    expect(hasTerritoryFilter({ populationMax: 1000 })).toBe(true);
  });
});
