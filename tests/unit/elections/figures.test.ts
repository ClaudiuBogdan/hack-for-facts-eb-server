import { describe, expect, it } from 'vitest';

import {
  mapTallies,
  mapTurnout,
  percentOf,
  publicIssues,
  raceOf,
  toCoverage,
  toPlace,
  toScopeFigures,
} from '@/modules/elections/core/figures.js';
import { parseEventKey, parsePlaceKey } from '@/modules/elections/core/keys.js';

import type {
  ElectionCompetitorRecord,
  ElectionTallyRecord,
  ElectionTurnoutRecord,
} from '@/modules/elections/core/types.js';

const competitor = (key: string, kind = 'party'): ElectionCompetitorRecord => ({
  competitorKey: key,
  kind,
  actorKey: kind === 'party' ? key : null,
  label: key.toUpperCase(),
  reportedLabels: [key.toUpperCase()],
});

const quality = {
  construction: 'summed_leaves',
  sourceLevel: 'pv_lines',
  finality: 'final',
  geographicCompleteness: 'complete',
  includesDiaspora: null,
  status: 'UNCHECKED',
  issues: [] as string[],
};

const tally = (
  key: string,
  value: string,
  extra: Partial<ElectionTallyRecord> = {}
): ElectionTallyRecord => ({
  ...quality,
  competitor: competitor(key),
  reportedLabel: key,
  measure: 'votes',
  allocationPhase: 'none',
  countedPopulation: 'all',
  value,
  ...extra,
});

const figure = (
  measure: string,
  value: string,
  extra: Partial<ElectionTurnoutRecord> = {}
): ElectionTurnoutRecord => ({ ...quality, measure, value, ...extra });

const place = (placeKey: string) => ({ placeKey, name: null, countyCode: null, countyName: null });

describe('percentOf', () => {
  it.each([
    ['500', '950', '52.63'],
    ['1', '3', '33.33'],
    ['2', '3', '66.67'],
    ['1', '8', '12.50'],
    ['1', '200000', '0.00'],
    ['1', '20000', '0.01'],
    ['0', '7', '0.00'],
    ['7', '7', '100.00'],
    ['9007199254740993', '9007199254740993', '100.00'],
  ])('%s of %s is %s%% (half-up, exact)', (numerator, denominator, percent) => {
    expect(percentOf(numerator, denominator)).toBe(percent);
  });

  it('has no share of zero', () => {
    expect(percentOf('3', '0')).toBeNull();
  });
});

describe('keys', () => {
  it('reads family and year from an event key and refuses others', () => {
    expect(parseEventKey('ro:local:2024')).toEqual({ family: 'local', year: 2024 });
    expect(parseEventKey('ro:referendum:2007:2007-11-25')).toEqual({
      family: 'referendum',
      year: 2007,
    });
    for (const bad of [
      'ro:local',
      'ro:mayoral:2024',
      'local:2024',
      'ro:local:24',
      'ro:local:2024:x',
    ])
      expect(parseEventKey(bad), bad).toBeNull();
  });

  it('reads place keys and refuses others', () => {
    expect(parsePlaceKey('uat:179132')).toEqual({
      placeType: 'uat',
      sirutaCode: '179132',
      countyCode: null,
    });
    expect(parsePlaceKey('county:B')).toEqual({
      placeType: 'county',
      sirutaCode: null,
      countyCode: 'B',
    });
    expect(parsePlaceKey('diaspora')).toMatchObject({ placeType: 'diaspora' });
    for (const bad of [
      'uat:0',
      'uat:01',
      'uat:',
      'county:cj',
      'county:ABC',
      'sector:1',
      'Diaspora',
    ])
      expect(parsePlaceKey(bad), bad).toBeNull();
  });

  it('takes a county code from the key over the territory reference', () => {
    expect(
      toPlace({
        placeKey: 'county:CJ',
        name: 'CLUJ',
        countyCode: 'XX',
        countyName: 'CLUJ',
      })._unsafeUnwrap()
    ).toMatchObject({ countyCode: 'CJ' });
    expect(toPlace(place('elsewhere')).isErr()).toBe(true);
  });
});

describe('tallies and shares', () => {
  const valid = mapTurnout([figure('valid', '950')])._unsafeUnwrap()[0];

  it('orders votes by value then key, then mandate phases, and shares only the votes', () => {
    const mapped = mapTallies(
      [
        tally('b', '300'),
        tally('a', '500', { measure: 'mandates', allocationPhase: 'final' }),
        tally('c', '300'),
        tally('a', '500'),
        tally('a', '3', { measure: 'mandates', allocationPhase: 'man_1' }),
      ],
      valid
    )._unsafeUnwrap();
    expect(
      mapped.map((item) => [item.measure, item.allocationPhase, item.competitor.competitorKey])
    ).toEqual([
      ['votes', 'none', 'a'],
      ['votes', 'none', 'b'],
      ['votes', 'none', 'c'],
      ['mandates', 'man_1', 'a'],
      ['mandates', 'final', 'a'],
    ]);
    expect(mapped[0]?.share).toEqual({
      percent: '52.63',
      numerator: '500',
      denominator: '950',
      basis: 'valid_votes_same_scope',
    });
    expect(mapped[3]?.share).toBeNull();
  });

  it('shares partial votes only against valid votes missing the same places', () => {
    const partial = { geographicCompleteness: 'partial', issues: ['MISSING_SCOPE:uat:1'] };
    const same = mapTurnout([figure('valid', '100', partial)])._unsafeUnwrap()[0];
    const other = mapTurnout([
      figure('valid', '100', {
        geographicCompleteness: 'partial',
        issues: ['MISSING_SCOPE:uat:2'],
      }),
    ])._unsafeUnwrap()[0];
    expect(mapTallies([tally('a', '50', partial)], same)._unsafeUnwrap()[0]?.share?.percent).toBe(
      '50.00'
    );
    expect(mapTallies([tally('a', '50', partial)], other)._unsafeUnwrap()[0]?.share).toBeNull();
    expect(mapTallies([tally('a', '50')], same)._unsafeUnwrap()[0]?.share).toBeNull();
  });

  it('never shares linked-only votes or votes of another diaspora inclusion', () => {
    expect(
      mapTallies([tally('a', '50', { countedPopulation: 'linked_only' })], valid)._unsafeUnwrap()[0]
        ?.share
    ).toBeNull();
    const withDiaspora = mapTurnout([
      figure('valid', '100', { includesDiaspora: true }),
    ])._unsafeUnwrap()[0];
    expect(
      mapTallies([tally('a', '50', { includesDiaspora: false })], withDiaspora)._unsafeUnwrap()[0]
        ?.share
    ).toBeNull();
  });

  it('refuses an unknown vocabulary value, a non-integer value and a duplicated figure', () => {
    expect(mapTallies([tally('a', '1', { status: 'FINAL' })], undefined).isErr()).toBe(true);
    expect(mapTallies([tally('a', '1', { measure: 'seats' })], undefined).isErr()).toBe(true);
    expect(mapTallies([tally('a', '1.5')], undefined).isErr()).toBe(true);
    expect(mapTallies([tally('a', '-1')], undefined).isErr()).toBe(true);
    expect(
      mapTallies([tally('a', '1', { competitor: competitor('a', 'coalition') })], undefined).isErr()
    ).toBe(true);
    expect(mapTallies([tally('a', '1'), tally('a', '2')], undefined).isErr()).toBe(true);
    expect(mapTurnout([figure('valid', '1'), figure('valid', '1')]).isErr()).toBe(true);
    expect(mapTurnout([figure('turnout', '1')]).isErr()).toBe(true);
  });
});

describe('races', () => {
  const valid = mapTurnout([figure('valid', '1000')])._unsafeUnwrap()[0];

  it('ranks the votes and states the margin in votes and points', () => {
    const race = raceOf(
      mapTallies([tally('b', '300'), tally('a', '500'), tally('c', '200')], valid)._unsafeUnwrap()
    );
    expect(race).toMatchObject({
      competitorCount: 3,
      leader: { competitor: { competitorKey: 'a' }, votes: '500' },
      runnerUp: { competitor: { competitorKey: 'b' }, votes: '300' },
      marginVotes: '200',
      marginPoints: '20.00',
      tied: false,
    });
  });

  it('reports a tie without picking a winner, and no margin points without shares', () => {
    const race = raceOf(mapTallies([tally('b', '7'), tally('a', '7')], undefined)._unsafeUnwrap());
    expect(race).toMatchObject({ tied: true, marginVotes: '0', marginPoints: null });
  });

  it('has no runner-up for one competitor and no race without votes', () => {
    expect(raceOf(mapTallies([tally('a', '7')], valid)._unsafeUnwrap())).toMatchObject({
      runnerUp: null,
      marginVotes: null,
      marginPoints: null,
      tied: false,
    });
    expect(
      raceOf(
        mapTallies(
          [tally('a', '7', { measure: 'mandates', allocationPhase: 'final' })],
          valid
        )._unsafeUnwrap()
      )
    ).toBeNull();
  });
});

describe('participation', () => {
  const scope = (placeKey: string, extra: Partial<ElectionTurnoutRecord> = {}) =>
    toScopeFigures(
      {
        place: place(placeKey),
        tallies: [],
        turnout: [figure('registered', '2000', extra), figure('voted', '1000', extra)],
      },
      false
    )._unsafeUnwrap().participation;

  it('is voted over registered for a complete, unflagged place', () => {
    expect(scope('uat:1017')).toEqual({
      percent: '50.00',
      numerator: '1000',
      denominator: '2000',
      basis: 'registered_same_scope',
    });
  });

  it('is never derived for the diaspora, a partial, flagged or suspect figure', () => {
    expect(scope('diaspora')).toBeNull();
    expect(scope('national', { geographicCompleteness: 'partial' })).toBeNull();
    expect(scope('national', { issues: ['POSTAL_REGISTRATIONS_NOT_IN_SOURCE'] })).toBeNull();
    expect(scope('county:CT', { status: 'SUSPECT' })).toBeNull();
  });
});

describe('coverage', () => {
  it('marks place-specific cells and refuses unknown states', () => {
    expect(
      toCoverage([
        { measure: 'votes', allocationPhase: 'none', scopeKey: null, state: 'usable', issues: [] },
        {
          measure: 'votes',
          allocationPhase: 'none',
          scopeKey: 'uat:1',
          state: 'absent',
          issues: ['NOT_IN_SOURCE'],
        },
      ])._unsafeUnwrap()
    ).toEqual([
      {
        measure: 'votes',
        allocationPhase: 'none',
        placeSpecific: false,
        state: 'usable',
        issues: [],
      },
      {
        measure: 'votes',
        allocationPhase: 'none',
        placeSpecific: true,
        state: 'absent',
        issues: ['NOT_IN_SOURCE'],
      },
    ]);
    expect(
      toCoverage([
        { measure: 'votes', allocationPhase: 'none', scopeKey: null, state: 'maybe', issues: [] },
      ]).isErr()
    ).toBe(true);
  });
});

describe('public issues', () => {
  it('keeps codes, keeps a missing place, and drops any other detail', () => {
    expect(
      publicIssues([
        'MISSING_SCOPE:uat:63286',
        'MEASURE_NOT_IN_INPUT:sel:ro:parliamentary:2020:chamber-postal',
        'UAT_UNMAPPED',
        'UAT_UNMAPPED',
      ])._unsafeUnwrap()
    ).toEqual(['MISSING_SCOPE:uat:63286', 'MEASURE_NOT_IN_INPUT', 'UAT_UNMAPPED']);
  });

  it('refuses an unknown code and a missing scope that is not a place', () => {
    expect(publicIssues(['SOMETHING_NEW']).isErr()).toBe(true);
    expect(publicIssues(['MISSING_SCOPE']).isErr()).toBe(true);
    expect(publicIssues(['MISSING_SCOPE:sel:x']).isErr()).toBe(true);
  });

  it('serves figures and coverage with public codes only', () => {
    const figures = mapTurnout([
      figure('blank', '0', { issues: ['MEASURE_NOT_IN_INPUT:sel:postal'] }),
    ])._unsafeUnwrap();
    expect(figures[0]?.issues).toEqual(['MEASURE_NOT_IN_INPUT']);
    expect(
      toCoverage([
        {
          measure: 'votes',
          allocationPhase: 'none',
          scopeKey: null,
          state: 'absent',
          issues: ['NOT_IN_SOURCE:sel:x'],
        },
      ])._unsafeUnwrap()[0]?.issues
    ).toEqual(['NOT_IN_SOURCE']);
  });
});

describe('race eligibility', () => {
  const valid = mapTurnout([figure('valid', '1000')])._unsafeUnwrap()[0];

  it('carries the quality of its tallies', () => {
    const race = raceOf(
      mapTallies(
        [
          tally('a', '500', { status: 'VERIFIED', issues: ['UAT_UNMAPPED'] }),
          tally('b', '300', { status: 'VERIFIED' }),
        ],
        valid
      )._unsafeUnwrap()
    );
    expect(race).toMatchObject({
      status: 'VERIFIED',
      geographicCompleteness: 'complete',
      finality: 'final',
      issues: ['UAT_UNMAPPED'],
    });
    expect(
      raceOf(
        mapTallies(
          [tally('a', '5', { status: 'VERIFIED' }), tally('b', '3', { finality: 'provisional' })],
          valid
        )._unsafeUnwrap()
      )
    ).toMatchObject({ status: 'UNCHECKED', finality: 'unknown' });
  });

  it('is not served between tallies of different coverage, population or diaspora inclusion', () => {
    const partial = { geographicCompleteness: 'partial', issues: ['MISSING_SCOPE:uat:1'] };
    for (const other of [
      partial,
      { countedPopulation: 'linked_only' },
      { includesDiaspora: true },
      { geographicCompleteness: 'partial', issues: ['MISSING_SCOPE:uat:2'] },
    ]) {
      expect(
        raceOf(mapTallies([tally('a', '100'), tally('b', '90', other)], valid)._unsafeUnwrap()),
        JSON.stringify(other)
      ).toBeNull();
    }
    // All partial in the same way: a race, marked partial.
    expect(
      raceOf(
        mapTallies(
          [tally('a', '100', partial), tally('b', '90', partial)],
          undefined
        )._unsafeUnwrap()
      )
    ).toMatchObject({ geographicCompleteness: 'partial', issues: ['MISSING_SCOPE:uat:1'] });
  });

  it('is not served with a suspect vote tally', () => {
    expect(
      raceOf(
        mapTallies(
          [tally('a', '100', { status: 'SUSPECT' }), tally('b', '90')],
          valid
        )._unsafeUnwrap()
      )
    ).toBeNull();
    expect(
      raceOf(
        mapTallies(
          [tally('a', '100'), tally('b', '90', { status: 'SUSPECT' })],
          valid
        )._unsafeUnwrap()
      )
    ).toBeNull();
  });
});
