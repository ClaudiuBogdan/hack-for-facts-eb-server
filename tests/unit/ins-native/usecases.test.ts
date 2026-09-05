import { describe, expect, it } from 'vitest';

import {
  classificationPins,
  listLatestValues,
  listObservations,
  periodPredicates,
  resolveTerritoryNodes,
  uatDashboard,
} from '@/modules/ins-native/core/usecases.js';

import { AB, DIMENSIONS, makeFakeRepo } from './fake-repo.js';

const values = (page: { nodes: readonly { value: string | null }[] }): string[] =>
  page.nodes.map((n) => n.value ?? '');

describe('territory selector resolution', () => {
  it('mixed-level territoryCodes resolve in one list (LAU code == SIRUTA)', async () => {
    const repo = makeFakeRepo();
    const nodes = (
      await resolveTerritoryNodes(repo, { territoryCodes: ['RO', 'CJ', '54975'] })
    )._unsafeUnwrap();
    expect(nodes !== null && 'levels' in nodes ? nodes : (nodes ?? []).map((n) => n.code)).toEqual([
      'RO',
      'CJ',
      '54975',
    ]);
  });

  it('sirutaCodes and territoryCodes intersect; levels narrow', async () => {
    const repo = makeFakeRepo();
    const both = await resolveTerritoryNodes(repo, {
      sirutaCodes: ['54975'],
      territoryCodes: ['CJ'],
    });
    expect(both._unsafeUnwrap()).toEqual([]);
    // Levels alone are a level PREDICATE (every node of the level), never a capped node list.
    const lvl = await resolveTerritoryNodes(repo, { territoryLevels: ['NUTS3'] });
    expect(lvl._unsafeUnwrap()).toEqual({ levels: ['NUTS3'] });
  });
});

describe('classification pins', () => {
  it('TOTAL alone pins every classification dimension that has a TOTAL', async () => {
    const repo = makeFakeRepo();
    const pins = await classificationPins(repo, 'POPTEST', DIMENSIONS['POPTEST'] ?? [], {
      classificationValueCodes: ['TOTAL'],
    });
    expect([...pins._unsafeUnwrap().pins.entries()]).toEqual([
      [1, [1]],
      [2, [105]],
      [3, [3064]],
      [4, [112]],
    ]);
    expect(pins._unsafeUnwrap().unpinnable).toEqual([]);
  });

  it('with type codes, TOTAL applies only to the listed dimensions and member codes only inside them', async () => {
    const repo = makeFakeRepo();
    const pins = await classificationPins(repo, 'POPTEST', DIMENSIONS['POPTEST'] ?? [], {
      classificationTypeCodes: ['D0', 'D1'],
      classificationValueCodes: ['TOTAL', '106'],
    });
    expect([...pins._unsafeUnwrap().pins.entries()]).toEqual([
      [1, [1]],
      [2, [105, 106]],
    ]);
  });

  it('a legacy slug is not a member code, and a member of another dataset is refused', async () => {
    const repo = makeFakeRepo();
    const slug = await classificationPins(repo, 'POPTEST', DIMENSIONS['POPTEST'] ?? [], {
      classificationValueCodes: ['1634_ANI'],
    });
    expect(slug.isErr() && slug.error.type === 'InvalidInput').toBe(true);
    const foreign = await classificationPins(repo, 'POPTEST', DIMENSIONS['POPTEST'] ?? [], {
      classificationValueCodes: ['8002'],
    });
    expect(
      foreign.isErr() &&
        foreign.error.type === 'InvalidInput' &&
        foreign.error.field === 'classificationValueCodes'
    ).toBe(true);
    const badType = await classificationPins(repo, 'POPTEST', DIMENSIONS['POPTEST'] ?? [], {
      classificationTypeCodes: ['SEX'],
    });
    expect(
      badType.isErr() &&
        badType.error.type === 'InvalidInput' &&
        badType.error.field === 'classificationTypeCodes'
    ).toBe(true);
  });
});

describe('TOTAL on a dimension without a TOTAL member (D1b)', () => {
  it('reports the dimension as unpinnable, and insObservations answers an empty page, never every member', async () => {
    const repo = makeFakeRepo();
    const pins = await classificationPins(repo, 'EMPTYTEST', DIMENSIONS['EMPTYTEST'] ?? [], {
      classificationValueCodes: ['TOTAL'],
    });
    expect(pins._unsafeUnwrap().unpinnable).toEqual([0]);
    const page = await listObservations(repo, 'EMPTYTEST', { classificationValueCodes: ['TOTAL'] });
    expect(page._unsafeUnwrap().nodes).toEqual([]);
    expect(repo.factQueries).toHaveLength(0);
  });

  it('an unpinned whole-dataset read is refused, not run', async () => {
    const repo = makeFakeRepo();
    const res = await listObservations(repo, 'POPTEST', {});
    expect(res.isErr() && res.error.type === 'InvalidInput').toBe(true);
    expect(repo.factQueries).toHaveLength(0);
  });

  it('territoryLevels alone compiles to a level predicate on the territorial dimension', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', {
      territoryLevels: ['NUTS3'],
      classificationValueCodes: ['TOTAL'],
      classificationTypeCodes: ['D0', 'D1'],
    });
    expect(new Set(values(page._unsafeUnwrap()).map((v) => v.split('-')[0]))).toEqual(
      new Set(['CJ', 'AB'])
    );
    const group = repo.factQueries[0]?.pinGroups[0];
    expect(group?.has(3)).toBe(false);
    expect(group?.has(4)).toBe(false);
    expect(repo.factQueries[0]?.geoScope).toEqual({ kind: 'modern', levels: ['NUTS3'] });
  });

  it('territoryLevels: [LAU] reads every locality row (the county slot stays unconstrained)', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(
      repo,
      'POPTEST',
      {
        territoryLevels: ['LAU'],
        classificationValueCodes: ['TOTAL'],
        classificationTypeCodes: ['D0', 'D1'],
      },
      100
    );
    expect(new Set(values(page._unsafeUnwrap()).map((v) => v.split('-')[0]))).toEqual(
      new Set(['CLJ', 'ALB'])
    );
    expect(repo.factQueries[0]?.pinGroups[0]?.has(3)).toBe(false);
  });

  it('a classification pin on a level-predicated slot narrows it, never replaces it', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(
      repo,
      'POPTEST',
      {
        territoryLevels: ['NUTS3'],
        classificationTypeCodes: ['D2'],
        classificationValueCodes: ['3064'],
      },
      100
    );
    expect(page._unsafeUnwrap().nodes).toEqual([]); // the national TOTAL is not a NUTS3 member
    expect(repo.factQueries[0]?.pinGroups[0]?.get(3)).toEqual([3064]);
    expect(repo.factQueries[0]?.geoScope).toEqual({ kind: 'modern', levels: ['NUTS3'] });
  });

  it('an offset beyond the end reports an unknown total, not the offset', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }, 10, 100);
    expect(page._unsafeUnwrap().nodes).toEqual([]);
    expect(page._unsafeUnwrap().totalCount).toBeNull();
  });
});

describe('period predicates', () => {
  it('tokens are EXACT periods (never the span between them); interval bounds are parsed; bad tokens are InvalidInput', () => {
    expect(periodPredicates({ tokens: ['2016', '2025'] })._unsafeUnwrap()).toEqual({
      periodRanges: [
        { start: '2016-01-01', end: '2016-12-31' },
        { start: '2025-01-01', end: '2025-12-31' },
      ],
      periodicities: ['ANNUAL'],
    });
    expect(
      periodPredicates({
        periodicity: 'QUARTERLY',
        start: '2020-Q2',
        end: '2020-Q3',
      })._unsafeUnwrap()
    ).toEqual({
      periodicities: ['QUARTERLY'],
      periodStart: '2020-04-01',
      periodEnd: '2020-09-30',
    });
    expect(periodPredicates({ tokens: ['20x'] }).isErr()).toBe(true);
    // mixed granularities in one dates list cannot mean one thing
    expect(periodPredicates({ tokens: ['2020', '2020-06'] }).isErr()).toBe(true);
    expect(periodPredicates({ periodicity: 'ANNUAL', tokens: ['2020-06'] }).isErr()).toBe(true);
  });
});

describe('insObservations', () => {
  it('the landing comparison: three territories of mixed level, TOTAL on the classifications, newest first', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', {
      territoryCodes: ['RO', 'CJ', '54975'],
      classificationValueCodes: ['TOTAL'],
      classificationTypeCodes: ['D0', 'D1'],
    });
    const got = values(page._unsafeUnwrap());
    expect(got).toEqual([
      'RO-1-105-2021',
      'CJ-1-105-2021',
      'CLJ-1-105-2021',
      'RO-1-105-2020',
      'CJ-1-105-2020',
      'CLJ-1-105-2020',
      'RO-1-105-2019',
      'CJ-1-105-2019',
      'CLJ-1-105-2019',
    ]);
    // One fact query intersects classifications with complete published tuples.
    expect(repo.factQueries).toHaveLength(1);
    expect(repo.factQueries[0]?.pinGroups).toHaveLength(1);
    expect(page._unsafeUnwrap().totalCount).toBe(9);
  });

  it('a LAU history via sirutaCodes + LAU level, with a period window', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', {
      sirutaCodes: ['54975'],
      territoryLevels: ['LAU'],
      classificationValueCodes: ['TOTAL'],
      period: { periodicity: 'ANNUAL', start: '2020', end: '2021' },
    });
    expect(values(page._unsafeUnwrap())).toEqual(['CLJ-1-105-2021', 'CLJ-1-105-2020']);
  });

  it('unpinned classification dimensions return every member row (the client pins them; the server never guesses)', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }, 100);
    expect(page._unsafeUnwrap().nodes).toHaveLength(27); // 3 age × 3 sex × 3 years
  });

  it('limit + 1 paging: totalCount is unknown (null) while more rows exist, exact on the last page', async () => {
    const repo = makeFakeRepo();
    const first = await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }, 10, 0);
    expect(first._unsafeUnwrap().hasNextPage).toBe(true);
    expect(first._unsafeUnwrap().totalCount).toBeNull();
    const last = await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }, 10, 20);
    expect(last._unsafeUnwrap().hasNextPage).toBe(false);
    expect(last._unsafeUnwrap().hasPreviousPage).toBe(true);
    expect(last._unsafeUnwrap().totalCount).toBe(27);
  });

  it('unknown territory codes and an unknown dataset are empty pages (aliased batches survive); unit codes are validated', async () => {
    const repo = makeFakeRepo();
    const none = await listObservations(repo, 'POPTEST', { territoryCodes: ['ZZ'] });
    expect(none._unsafeUnwrap().nodes).toEqual([]);
    const missing = await listObservations(repo, 'NOPE', {});
    expect(missing._unsafeUnwrap()).toEqual({
      nodes: [],
      totalCount: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    const unit = await listObservations(repo, 'CNTTEST', {
      territoryCodes: ['CJ'],
      unitCodes: ['9999'],
    });
    expect(
      unit.isErr() && unit.error.type === 'InvalidInput' && unit.error.field === 'unitCodes'
    ).toBe(true);
    const eur = await listObservations(repo, 'CNTTEST', {
      territoryCodes: ['CJ'],
      unitCodes: ['9508'],
    });
    expect(values(eur._unsafeUnwrap())).toEqual(['CJ-9508-2020', 'CJ-9508-2019']);
  });
});

describe('default series and latest values (decision D2: no arbitrary row)', () => {
  it('insLatestDatasetValues batches every resolvable series into one read and answers NO_DATA for the rest', async () => {
    const repo = makeFakeRepo();
    const res = await listLatestValues(
      repo,
      { territoryCode: 'CJ', territoryLevel: 'NUTS3' },
      ['POPTEST', 'CNTTEST', 'EMPTYTEST', 'NOPE'],
      ['TOTAL']
    );
    const out = res._unsafeUnwrap();
    expect(out.map((v) => [v.dataset.code, v.matchStrategy, v.observation?.value ?? null])).toEqual(
      [
        ['POPTEST', 'TOTAL_FALLBACK', 'CJ-1-105-2021'],
        ['CNTTEST', 'NO_DATA', null],
        ['EMPTYTEST', 'NO_DATA', null],
      ]
    );
    expect(repo.seriesReads).toEqual([[JSON.stringify(['POPTEST', 25])]]);
  });

  it('the national entity selects the exact national source tuple', async () => {
    const repo = makeFakeRepo();
    const res = await listLatestValues(repo, { territoryCode: 'RO', territoryLevel: 'NATIONAL' }, [
      'POPTEST',
    ]);
    expect(res._unsafeUnwrap()[0]?.observation?.value).toBe('RO-1-105-2021');
  });

  it('an unknown entity is InvalidInput, never an empty success', async () => {
    const repo = makeFakeRepo();
    const res = await listLatestValues(repo, { sirutaCode: '999999' }, ['POPTEST']);
    expect(res.isErr() && res.error.type === 'InvalidInput' && res.error.field === 'entity').toBe(
      true
    );
  });
});

describe('default source identity outcomes', () => {
  it('normalizes and deduplicates dataset inputs in first-request order', async () => {
    const repo = makeFakeRepo();
    const rows = (
      await listLatestValues(repo, { territoryCode: 'RO' }, [' poptest ', 'CNTTEST', 'POPTEST'])
    )._unsafeUnwrap();
    expect(rows.map((row) => row.dataset.code)).toEqual(['POPTEST', 'CNTTEST']);
    expect(repo.seriesReads[0]).toHaveLength(1);
  });
  it('reports ambiguity without choosing the newest source or suppressing healthy datasets', async () => {
    const baseline = (
      await listLatestValues(makeFakeRepo(), { territoryCode: 'RO' }, ['POPTEST'])
    )._unsafeUnwrap()[0]!.observation!;
    const alternative = {
      ...baseline,
      geography: {
        ...baseline.geography!,
        pairs: [
          [2, 9999],
          [3, 9998],
        ] as const,
      },
      period: { ...baseline.period, periodStart: '2018-01-01', periodEnd: '2018-12-31' },
    };
    const repo = makeFakeRepo({ extraDefaultObservations: [alternative] });
    const result = (
      await listLatestValues(repo, { territoryCode: 'RO' }, ['POPTEST', 'CNTTEST', 'EMPTYTEST'])
    )._unsafeUnwrap();
    expect(result.map((row) => row.matchStrategy)).toEqual([
      'AMBIGUOUS_GEOGRAPHY',
      'NO_DATA',
      'NO_DATA',
    ]);
    expect(result[0]?.observation).toBeNull();
    expect(result[0]?.witnesses).toHaveLength(2);
  });
  it('ignores empty optional selectors but rejects conflicting nonempty selectors', async () => {
    for (const entity of [
      { sirutaCode: '54975', territoryCode: '' },
      { sirutaCode: '', territoryCode: '54975' },
    ]) {
      expect(
        (await listLatestValues(makeFakeRepo(), entity, ['POPTEST']))._unsafeUnwrap()[0]
          ?.observation?.territory?.code
      ).toBe('54975');
    }
    expect(
      (
        await listLatestValues(makeFakeRepo(), { sirutaCode: '54975', territoryCode: 'CJ' }, [
          'POPTEST',
        ])
      )._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
  });
  it('retains ambiguous dashboards and lets a requested period disambiguate', async () => {
    const baseline = (
      await listLatestValues(makeFakeRepo(), { sirutaCode: '54975' }, ['POPTEST'])
    )._unsafeUnwrap()[0]!.observation!;
    const alternative = {
      ...baseline,
      geography: {
        ...baseline.geography!,
        pairs: [
          [2, 9999],
          [3, 9998],
        ] as const,
      },
      period: { ...baseline.period, periodStart: '2018-01-01', periodEnd: '2018-12-31' },
    };
    const repo = makeFakeRepo({ extraDefaultObservations: [alternative] });
    const ambiguous = (await uatDashboard(repo, '54975', undefined, undefined))._unsafeUnwrap()[0];
    expect(ambiguous).toMatchObject({
      status: 'AMBIGUOUS_GEOGRAPHY',
      observations: [],
      truncated: false,
    });
    expect(ambiguous?.witnesses).toHaveLength(2);
    const narrowed = (
      await uatDashboard(repo, '54975', undefined, { tokens: ['2021'] })
    )._unsafeUnwrap()[0];
    expect(narrowed?.status).toBe('SERIES');
    expect(narrowed?.observations).toHaveLength(1);
  });
});

describe('insUatDashboard', () => {
  it('returns the LAU-bound datasets with their default series, newest first, without a global cap', async () => {
    const repo = makeFakeRepo();
    const res = await uatDashboard(repo, '54975', undefined, undefined);
    const groups = res._unsafeUnwrap();
    expect(groups.map((g) => g.dataset.code)).toEqual(['POPTEST']);
    expect(groups[0]?.observations.map((o) => o.value)).toEqual([
      'CLJ-1-105-2021',
      'CLJ-1-105-2020',
      'CLJ-1-105-2019',
    ]);
    expect(groups[0]?.truncated).toBe(false);
  });

  it('a period token filters the rows; a county SIRUTA is refused', async () => {
    const repo = makeFakeRepo();
    const res = await uatDashboard(repo, '54975', undefined, { tokens: ['2020'] });
    expect(res._unsafeUnwrap()[0]?.observations.map((o) => o.value)).toEqual(['CLJ-1-105-2020']);
    const bad = await uatDashboard(repo, 'CJ', undefined, undefined);
    expect(bad.isErr()).toBe(true);
  });
});

describe('the AB/Alba Iulia pair proves pins are exact, not cross-multiplied', () => {
  it('requesting Alba Iulia and Cluj county never returns Alba county or Cluj-Napoca rows', async () => {
    const repo = makeFakeRepo();
    const page = await listObservations(repo, 'POPTEST', {
      territoryCodes: ['1017', 'CJ'],
      classificationValueCodes: ['TOTAL'],
    });
    const got = values(page._unsafeUnwrap());
    expect(got.every((v) => v.startsWith('ALB-') || v.startsWith('CJ-'))).toBe(true);
    expect(got).toHaveLength(6);
    expect(AB.code).toBe('AB');
  });
});
