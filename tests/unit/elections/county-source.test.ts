/**
 * The county source report usecase over in-memory records, under the
 * complete-source contract: input bounds before any read; a complete report
 * with every cell in legend order, zero and integer precision kept, the
 * Bucharest note and exact label paging; the whole report held (null) when any
 * statement cell or competitor pair cannot be served, never a smaller source;
 * and a fixed refusal for anything a broken predicate or load could produce
 * (non-public rows, another source, an unadmitted column, duplicated or
 * non-integer cells, on or off the requested page).
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  BUCHAREST_SCOPE_NOTE,
  COUNTY_SOURCE_CITATION,
  COUNTY_SOURCE_NOTICE,
  COUNTY_SOURCE_STATEMENT,
} from '@/modules/elections/core/county-source.js';
import { getCountySourceReport } from '@/modules/elections/core/usecases.js';

import {
  completeCompetitors,
  completeStatement,
  competitor,
  COUNTY_SOURCE_REPORTS,
  countyContest,
  makeFakeElectionsRepo,
  RESTRICTED_SENTINEL,
  type CountySourceFixture,
} from '../../fixtures/elections/catalog.js';

import type {
  CountySourceReportRecord,
  ElectionCountySourceReport,
} from '@/modules/elections/core/types.js';
import type { ElectionsRepository } from '@/modules/elections/index.js';

const ALBA = 'contest:aep-local-2020:mayor:county:1';
const BUCURESTI = 'contest:aep-local-2020:mayor:county:42';
const RESTRICTED = `contest:aep-local-2020:mayor:county:${RESTRICTED_SENTINEL}`;

const read = (
  contestKey: string,
  repo: ElectionsRepository = makeFakeElectionsRepo(),
  page = 1,
  pageSize = 20
) => getCountySourceReport({ repo }, { contestKey, page, pageSize });

const served = async (contestKey: string): Promise<ElectionCountySourceReport> => {
  const report = (await read(contestKey))._unsafeUnwrap();
  if (report === null) throw new Error(`no report for ${contestKey}`);
  return report;
};

/** A one-contest fake over the given ALBA cells (the repository's label grouping applies). */
const albaWith = (
  overrides: Partial<Pick<CountySourceFixture, 'statement' | 'competitors'>>
): ElectionsRepository =>
  makeFakeElectionsRepo({
    reports: [
      {
        contest: countyContest('1', 'ALBA'),
        statement: completeStatement(),
        competitors: completeCompetitors([]),
        ...overrides,
      },
    ],
  });

/** The record the fake answers for ALBA, page 1 of 20: a complete source. */
const albaRecord = async (): Promise<CountySourceReportRecord> => {
  const record = (
    await makeFakeElectionsRepo().countySourceReport({ contestKey: ALBA, page: 1, pageSize: 20 })
  )._unsafeUnwrap();
  if (record === null) throw new Error('fixture missing');
  return record;
};

/** A repository answering one record exactly as given (what a broken SQL read could return). */
const answering = (record: CountySourceReportRecord): ElectionsRepository => ({
  ...makeFakeElectionsRepo(),
  countySourceReport: () => Promise.resolve(ok(record)),
});

describe('county source report: a complete source is served whole', () => {
  it('serves all 12 admitted statement cells in legend order, keeping zero and precision', async () => {
    const report = await served(ALBA);
    expect(report.statement.map((cell) => cell.sourceCode)).toEqual(
      COUNTY_SOURCE_STATEMENT.map((cell) => cell.code)
    );
    expect(report.statement.map((cell) => cell.sourceLabel)).toEqual(
      COUNTY_SOURCE_STATEMENT.map((cell) => cell.label)
    );
    const value = (code: string) =>
      report.statement.find((cell) => cell.sourceCode === code)?.value;
    expect(value('a')).toBe('9007199254740993');
    expect(value('a1')).toBe('0');
    expect(value('a4')).toBe('7');
    expect(value('d')).toBe('0');
    expect(report.statement.every((cell) => typeof cell.value === 'string')).toBe(true);
    expect(report.statement.some((cell) => ['e', 'f'].includes(cell.sourceCode))).toBe(false);
  });

  it('serves source labels in C order with both cells, over the exact 234-label total', async () => {
    const report = await served(ALBA);
    expect(report.competitors).toMatchObject({ page: 1, pageSize: 20, total: 234, hasMore: true });
    expect(report.competitors.items.slice(0, 4)).toEqual([
      { sourceLabel: '"ALIANȚA ELECTORALĂ X"', voturi: '0', mandate: '0' },
      { sourceLabel: 'Candidat Independent', voturi: '20', mandate: '0' },
      { sourceLabel: 'PARTIDUL NAȚIONAL LIBERAL', voturi: '40', mandate: '2' },
      { sourceLabel: 'SINTETIC 001', voturi: '0', mandate: '0' },
    ]);
    expect(JSON.stringify(report)).not.toContain(RESTRICTED_SENTINEL);
  });

  it('carries the notice and citation, and no derived, finality, winner or seat field', async () => {
    const report = await served(ALBA);
    expect(report).toMatchObject({
      contestKey: ALBA,
      electionKey: 'aep-local-2020',
      reportedOffice: 'mayor',
      scopeType: 'county',
      sourceScopeKey: '1',
      scopeLabel: 'ALBA',
      notice: COUNTY_SOURCE_NOTICE,
      scopeNote: null,
      source: COUNTY_SOURCE_CITATION,
    });
    expect(Object.keys(report).sort()).toEqual([
      'competitors',
      'contestKey',
      'electionKey',
      'notice',
      'reportedOffice',
      'scopeLabel',
      'scopeNote',
      'scopeType',
      'source',
      'sourceScopeKey',
      'statement',
    ]);
    expect(Object.keys(report.competitors.items[0] ?? {}).sort()).toEqual([
      'mandate',
      'sourceLabel',
      'voturi',
    ]);
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null)
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
    };
    walk(report);
    // The notice names these to disclaim them; no FIELD may carry one.
    expect(
      keys.filter((key) =>
        /winner|elected|seat|final|turnout|percent|share|sector|canonical|total(?!$)/iu.test(key)
      )
    ).toEqual([]);
  });

  it('notes the Municipiul București circumscription, and only it', async () => {
    const report = await served(BUCURESTI);
    expect(report.scopeNote).toBe(BUCHAREST_SCOPE_NOTE);
    expect(report.scopeLabel).toBe('MUNICIPIUL BUCUREŞTI');
    expect(report.statement.find((cell) => cell.sourceCode === 'c')?.value).toBe('657159');
  });

  it('pages source labels with an exact total, including a page past the end', async () => {
    const repo = makeFakeElectionsRepo();
    const shape = async (page: number, pageSize: number) => {
      const value = (await read(ALBA, repo, page, pageSize))._unsafeUnwrap();
      return {
        first: value?.competitors.items[0]?.sourceLabel,
        count: value?.competitors.items.length,
        total: value?.competitors.total,
        hasMore: value?.competitors.hasMore,
      };
    };
    expect(await shape(1, 2)).toEqual({
      first: '"ALIANȚA ELECTORALĂ X"',
      count: 2,
      total: 234,
      hasMore: true,
    });
    expect(await shape(3, 100)).toEqual({
      first: 'SINTETIC 198',
      count: 34,
      total: 234,
      hasMore: false,
    });
    expect(await shape(4, 100)).toEqual({ first: undefined, count: 0, total: 234, hasMore: false });
  });
});

describe('county source report: anything less than the complete source is held whole', () => {
  it('answers null for an absent or restricted contest', async () => {
    expect((await read('contest:absent'))._unsafeUnwrap()).toBeNull();
    expect((await read(RESTRICTED))._unsafeUnwrap()).toBeNull();
  });

  it.each([
    // a4 withheld (an unreviewed map) and b4 withheld (a private map): the SQL returns no cell.
    ['a withheld a4', { statement: completeStatement().filter((c) => c.metricCode !== 'a4') }],
    ['a withheld b4', { statement: completeStatement().filter((c) => c.metricCode !== 'b4') }],
    ['no statement cell at all', { statement: [] }],
    [
      'a statement cell stored without a number',
      {
        statement: completeStatement().map((c) =>
          c.metricCode === 'c' ? { metricCode: 'c', value: null } : c
        ),
      },
    ],
    // The pair missing entirely: 233 labels must not look like a smaller original source.
    ['an entirely missing competitor pair', { competitors: completeCompetitors([]).slice(1) }],
    [
      'a missing mandate cell',
      {
        competitors: [
          competitor('Candidat Independent', '20', null),
          ...completeCompetitors([]).slice(1),
        ].map((c) =>
          c.mandate === null
            ? { sourceLabel: c.sourceLabel, privacyClass: 'public', voturi: c.voturi }
            : c
        ),
      },
    ],
    [
      'a missing voturi cell',
      {
        competitors: [
          { sourceLabel: 'Candidat Independent', privacyClass: 'public', mandate: '0' },
          ...completeCompetitors([]).slice(1),
        ],
      },
    ],
    [
      'a competitor cell stored without a number',
      {
        competitors: [
          competitor('Candidat Independent', null, '0'),
          ...completeCompetitors([]).slice(1),
        ],
      },
    ],
    [
      'a withheld (restricted) label among the 234',
      {
        competitors: [
          competitor('Candidat Independent', '20', '0', 'restricted'),
          ...completeCompetitors([]).slice(1),
        ],
      },
    ],
    ['no competitor at all', { competitors: [] }],
  ])('holds the report on %s, whatever the page', async (_label, overrides) => {
    const repo = albaWith(
      overrides as Partial<Pick<CountySourceFixture, 'statement' | 'competitors'>>
    );
    for (const page of [1, 3, 99])
      expect((await read(ALBA, repo, page, 100))._unsafeUnwrap()).toBeNull();
  });

  it('holds a source with more labels than the file has', async () => {
    const repo = albaWith({
      competitors: [...completeCompetitors([]), competitor('ZZ EXTRA', '0', '0')],
    });
    expect((await read(ALBA, repo))._unsafeUnwrap()).toBeNull();
  });
});

describe('county source report: input bounds before any read', () => {
  it.each([
    ['an empty key', '', 1, 20, 'contestKey'],
    ['an over-long key', 'k'.repeat(513), 1, 20, 'contestKey'],
    ['a control character', 'contest\u0000', 1, 20, 'contestKey'],
    ['page 0', ALBA, 0, 20, 'page'],
    ['pageSize 0', ALBA, 1, 0, 'pageSize'],
    ['pageSize over 100', ALBA, 1, 101, 'pageSize'],
    ['an unsafe offset', ALBA, Number.MAX_SAFE_INTEGER, 100, 'page'],
  ])('rejects %s', async (_label, contestKey, page, pageSize, field) => {
    const repo = makeFakeElectionsRepo();
    const result = await getCountySourceReport({ repo }, { contestKey, page, pageSize });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    expect(repo.calls).toEqual([]);
  });
});

describe('county source report: a broken predicate or load refuses the whole response', () => {
  it('refuses a source label carried twice (two competitor ids), on every page', async () => {
    // The duplicate sorts last, so pages 1-2 of 100 never show it.
    const repo = albaWith({
      competitors: [...completeCompetitors([]), competitor('SINTETIC 234', '0', null)],
    });
    for (const page of [1, 2, 3])
      expect((await read(ALBA, repo, page, 100))._unsafeUnwrapErr().type).toBe('Database');
  });

  it('refuses a corrupt cell off the requested page', async () => {
    const competitors = completeCompetitors([]).map((c) =>
      c.sourceLabel === 'SINTETIC 234' ? competitor('SINTETIC 234', '0.0', '0') : c
    );
    const repo = albaWith({ competitors });
    expect((await read(ALBA, repo, 1, 2))._unsafeUnwrapErr().type).toBe('Database');
  });

  it('refuses a fault before holding an incomplete report', async () => {
    const repo = albaWith({
      statement: completeStatement().filter((c) => c.metricCode !== 'a4'),
      competitors: [...completeCompetitors([]), competitor('SINTETIC 001', '1', '1')],
    });
    expect((await read(ALBA, repo))._unsafeUnwrapErr().type).toBe('Database');
  });

  it.each([
    [
      'a restricted contest',
      (r: CountySourceReportRecord) => ({
        ...r,
        contest: { ...r.contest, privacyClass: 'restricted' },
      }),
    ],
    [
      'a restricted edition',
      (r: CountySourceReportRecord) => ({
        ...r,
        contest: { ...r.contest, electionPrivacyClass: 'restricted' },
      }),
    ],
    [
      'another edition',
      (r: CountySourceReportRecord) => ({
        ...r,
        contest: { ...r.contest, electionKey: 'bec-local-2020' },
      }),
    ],
    [
      'another office',
      (r: CountySourceReportRecord) => ({
        ...r,
        contest: { ...r.contest, office: 'local_council' },
      }),
    ],
    [
      'another scope',
      (r: CountySourceReportRecord) => ({ ...r, contest: { ...r.contest, scopeType: 'siruta' } }),
    ],
    [
      'an excluded column (e)',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: [...r.statement, { metricCode: 'e', value: '10' }],
      }),
    ],
    [
      'an unadmitted column',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: [...r.statement, { metricCode: 'county_nce', value: '1' }],
      }),
    ],
    [
      'a duplicated statement cell',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: [...r.statement, { metricCode: 'c', value: '61' }],
      }),
    ],
    [
      'a fractional statement cell',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: r.statement.map((c) => (c.metricCode === 'c' ? { ...c, value: '60.5' } : c)),
      }),
    ],
    [
      'a scaled integer cell',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: r.statement.map((c) => (c.metricCode === 'c' ? { ...c, value: '60.0' } : c)),
      }),
    ],
    [
      'a negative cell',
      (r: CountySourceReportRecord) => ({
        ...r,
        statement: r.statement.map((c) => (c.metricCode === 'c' ? { ...c, value: '-1' } : c)),
      }),
    ],
    [
      'a restricted label on the page',
      (r: CountySourceReportRecord) => ({
        ...r,
        competitors: {
          ...r.competitors,
          items: r.competitors.items.map((c, i) =>
            i === 0 ? { ...c, privacyClass: 'restricted' } : c
          ),
        },
      }),
    ],
    [
      'a duplicated label cell on the page',
      (r: CountySourceReportRecord) => ({
        ...r,
        competitors: {
          ...r.competitors,
          items: r.competitors.items.map((c, i) => (i === 0 ? { ...c, voturiCells: 2 } : c)),
        },
      }),
    ],
    [
      'a padded label cell on the page',
      (r: CountySourceReportRecord) => ({
        ...r,
        competitors: {
          ...r.competitors,
          items: r.competitors.items.map((c, i) => (i === 0 ? { ...c, voturi: ' 40' } : c)),
        },
      }),
    ],
    [
      'duplicated labels off the page',
      (r: CountySourceReportRecord) => ({
        ...r,
        integrity: { ...r.integrity, duplicatedLabels: 1 },
      }),
    ],
    [
      'a non-integer cell off the page',
      (r: CountySourceReportRecord) => ({
        ...r,
        integrity: { ...r.integrity, labelsWithNonIntegerCell: 1 },
      }),
    ],
    [
      'an inexact label total',
      (r: CountySourceReportRecord) => ({ ...r, competitors: { ...r.competitors, total: -1 } }),
    ],
    [
      'a page contradicting its integrity counts',
      (r: CountySourceReportRecord) => ({
        ...r,
        competitors: {
          ...r.competitors,
          items: r.competitors.items.map((c, i) => (i === 0 ? { ...c, mandate: null } : c)),
        },
      }),
    ],
  ])('refuses %s', async (_label, mutate) => {
    const result = await read(ALBA, answering(mutate(await albaRecord())));
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });

  it('refuses the leaked restricted rows of a broken privacy predicate', async () => {
    const leaking = makeFakeElectionsRepo({ leak: true });
    expect((await read(RESTRICTED, leaking))._unsafeUnwrapErr().type).toBe('Database');
    expect((await read(ALBA, leaking))._unsafeUnwrapErr().type).toBe('Database');
  });

  it('keeps the fixture a complete source', () => {
    const alba = COUNTY_SOURCE_REPORTS.find((r) => r.contest.contestKey === ALBA);
    expect(alba?.statement).toHaveLength(12);
    expect(alba?.competitors.filter((c) => c.privacyClass === 'public')).toHaveLength(234);
  });
});
