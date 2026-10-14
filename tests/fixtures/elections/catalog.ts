/**
 * An in-memory Elections repository over small dimension "tables" that mirror
 * the production shape. Edition keys, years, rounds, the stored family and
 * authority labels and the office labels follow the 2026-10-02 production
 * snapshot (every stored authority is `BEC/AEP/ROAEP`; European Parliament
 * editions are stored as `parliamentary`). Names, event keys, contest keys,
 * scope keys, the dated and undated editions and every restricted row are
 * illustrative: that snapshot holds no event or contest keys, and every stored
 * edition date was null. It applies the SQL repository's semantics: public
 * rows only, event links only to public events, `in` filters, key order, exact
 * totals and offset pages. `leak: true` breaks the privacy predicate on purpose
 * so tests can prove the usecases fail closed.
 *
 * The county source reports are a separate table of what the SQL carrier read
 * returns (the qualified carrier's cells only, grouped by source label with
 * the same integrity counts), kept apart from the catalog rows so the catalog
 * totals stay those of the snapshot. Each positive report has the file's full
 * shape (12 statement cells, 234 labels with both cells); the values are
 * illustrative, chosen for the zero and precision cases.
 */
import { ok } from 'neverthrow';

import type { ElectionsRepository } from '@/modules/elections/core/ports.js';
import type {
  CountySourceCompetitorRecord,
  CountySourceReportRecord,
  ElectionContestRecord,
  ElectionEditionRecord,
  ElectionRecordPage,
} from '@/modules/elections/core/types.js';
import type { FilterInput } from '@/modules/shared/index.js';

/** Appears only in restricted rows; no response may ever contain it. */
export const RESTRICTED_SENTINEL = 'RESTRICTED-SENTINEL';

interface EventRow {
  readonly eventKey: string;
  readonly privacyClass: string;
}

const EVENTS: Record<string, EventRow> = {
  local2024: { eventKey: 'ro:local:2024', privacyClass: 'public' },
  local2014: { eventKey: 'ro:local:2014', privacyClass: 'public' },
  european2009: { eventKey: 'ro:european:2009', privacyClass: 'public' },
  hidden: { eventKey: `ro:${RESTRICTED_SENTINEL}:event`, privacyClass: 'restricted' },
};

interface EditionRow {
  readonly electionKey: string;
  readonly privacyClass: string;
  readonly name: string;
  readonly family: string;
  readonly year: number | null;
  readonly round: string | null;
  readonly date: string | null;
  readonly authority: string;
  readonly event: EventRow | null;
}

const edition = (overrides: Partial<EditionRow> & Pick<EditionRow, 'electionKey'>): EditionRow => ({
  privacyClass: 'public',
  name: overrides.electionKey,
  family: 'local',
  year: 2024,
  round: null,
  date: null,
  authority: 'BEC/AEP/ROAEP',
  event: null,
  ...overrides,
});

/** Deliberately unordered: the repository, not the fixture, owns the order. */
export const EDITION_ROWS: readonly EditionRow[] = [
  edition({
    electionKey: 'roaep-election-databases-local-2024',
    name: 'Alegeri locale 2024 (ROAEP)',
    event: EVENTS['local2024'] ?? null,
  }),
  edition({
    electionKey: 'bec-local-2024',
    name: 'Alegeri locale 2024',
    round: 'tur1',
    event: EVENTS['local2024'] ?? null,
  }),
  // Labelled 2014 although the official package is the 2016 edition: the
  // reported year is served as reported, never corrected or verified.
  edition({
    electionKey: 'aep-local-2014-t1',
    name: 'Alegeri locale 2014 tur 1',
    year: 2014,
    round: 'tur1',
    event: EVENTS['local2014'] ?? null,
  }),
  // Stored with family `parliamentary` (the loader's correction to `european`
  // is not read): the reported family is served and matched as stored.
  edition({
    electionKey: 'bec-european-2009',
    name: 'Alegeri europarlamentare 2009',
    family: 'parliamentary',
    year: 2009,
    date: '2009-06-07',
    event: EVENTS['european2009'] ?? null,
  }),
  edition({
    electionKey: 'bec-referendum-undated',
    name: 'Referendum (an necunoscut)',
    family: 'referendum',
    year: null,
  }),
  edition({
    electionKey: 'bec-local-2024-hidden-event',
    name: 'Alegeri locale 2024 (eveniment restrictionat)',
    event: EVENTS['hidden'] ?? null,
  }),
  edition({
    electionKey: `restricted-${RESTRICTED_SENTINEL}`,
    privacyClass: 'restricted',
    name: RESTRICTED_SENTINEL,
    event: EVENTS['local2024'] ?? null,
  }),
];

interface ContestRow {
  readonly contestKey: string;
  readonly privacyClass: string;
  readonly electionKey: string;
  readonly office: string;
  readonly chamber: string | null;
  readonly roundLabel: string | null;
  readonly scopeType: string;
  readonly scopeKey: string;
  readonly scopeLabel: string | null;
  readonly constituencyCode: string | null;
  readonly constituencyName: string | null;
  readonly event: EventRow | null;
}

const contest = (
  electionKey: string,
  office: string,
  scopeType: string,
  scopeKey: string,
  overrides: Partial<ContestRow> = {}
): ContestRow => ({
  contestKey: `contest:${electionKey}:${office}:${scopeType}:${scopeKey}`,
  privacyClass: 'public',
  electionKey,
  office,
  chamber: null,
  roundLabel: 'tur1',
  scopeType,
  scopeKey,
  scopeLabel: null,
  constituencyCode: null,
  constituencyName: null,
  event: EVENTS['local2024'] ?? null,
  ...overrides,
});

export const CONTEST_ROWS: readonly ContestRow[] = [
  contest('bec-local-2024', 'mayor', 'siruta', '179132', { scopeLabel: 'SECTOR 1' }),
  contest('bec-local-2024', 'county_council', 'county', '1', { scopeLabel: 'ALBA' }),
  contest('bec-local-2024', 'local_council', 'siruta', '1017', { scopeLabel: 'ALBA IULIA' }),
  contest('bec-local-2024', 'mayor', 'siruta', '1017', { scopeLabel: 'ALBA IULIA' }),
  // The same office and scope in another round: a distinct contest row.
  contest('bec-local-2024', 'mayor', 'siruta', '1017', {
    contestKey: 'contest:bec-local-2024:mayor:siruta:1017:tur2',
    roundLabel: 'tur2',
    event: null,
  }),
  // A second, source-specific county council label inside the same edition.
  contest('bec-local-2024', 'consiliu-judetean', 'county', '2', {
    scopeLabel: 'ARAD',
    event: EVENTS['hidden'] ?? null,
  }),
  contest('bec-local-2024', 'mayor', 'siruta', RESTRICTED_SENTINEL, {
    privacyClass: 'restricted',
    scopeLabel: RESTRICTED_SENTINEL,
  }),
  // A general-mayor observation at a sector location, mapped by the source to
  // an ordinary mayor contest: served as reported, scope unverified.
  contest('aep-local-2014-t1', 'mayor', 'siruta', '179141', { event: EVENTS['local2014'] ?? null }),
  contest(`restricted-${RESTRICTED_SENTINEL}`, 'mayor', 'siruta', '1017', {
    scopeLabel: RESTRICTED_SENTINEL,
  }),
];

/** `in` values of one filter field, or undefined when the field is absent. */
const inValues = (filter: FilterInput, field: string): readonly unknown[] | undefined => {
  const ops = filter[field] as Record<string, unknown> | undefined;
  const values = ops?.['in'];
  return Array.isArray(values) ? (values as readonly unknown[]) : undefined;
};

const matches = (filter: FilterInput, field: string, value: unknown): boolean => {
  const values = inValues(filter, field);
  return values === undefined || values.includes(value);
};

/** `collate "C"` order: code-unit comparison, which equals byte order for these keys. */
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The SQL `left join … and ev.privacy_class = 'public'`. */
const publicEvent = (event: EventRow | null): EventRow | null =>
  event !== null && event.privacyClass === 'public' ? event : null;

const editionRecord = (row: EditionRow): ElectionEditionRecord => {
  const event = publicEvent(row.event);
  return {
    electionKey: row.electionKey,
    privacyClass: row.privacyClass,
    name: row.name,
    family: row.family,
    year: row.year,
    round: row.round,
    date: row.date,
    authority: row.authority,
    eventKey: event?.eventKey ?? null,
    eventPrivacyClass: event?.privacyClass ?? null,
  };
};

const contestRecord = (row: ContestRow, parent: EditionRow): ElectionContestRecord => {
  const event = publicEvent(row.event);
  return {
    contestKey: row.contestKey,
    privacyClass: row.privacyClass,
    electionKey: row.electionKey,
    electionPrivacyClass: parent.privacyClass,
    office: row.office,
    chamber: row.chamber,
    roundLabel: row.roundLabel,
    scopeType: row.scopeType,
    scopeKey: row.scopeKey,
    scopeLabel: row.scopeLabel,
    constituencyCode: row.constituencyCode,
    constituencyName: row.constituencyName,
    eventKey: event?.eventKey ?? null,
    eventPrivacyClass: event?.privacyClass ?? null,
  };
};

const pageOf = <T>(rows: readonly T[], page: number, pageSize: number): ElectionRecordPage<T> => ({
  items: rows.slice((page - 1) * pageSize, page * pageSize),
  total: rows.length,
});

/**
 * One competitor id's cells. A label may repeat across ids, as it can in the
 * SQL; the fake groups by label exactly as the repository does. An omitted
 * column is no cell; `null` is a cell stored without a number.
 */
export interface CountySourceCompetitorCells {
  readonly sourceLabel: string;
  readonly privacyClass: string;
  readonly voturi?: string | null;
  readonly mandate?: string | null;
}

/** One contest's qualified-carrier cells, competitors deliberately unordered. */
export interface CountySourceFixture {
  readonly contest: CountySourceReportRecord['contest'];
  readonly statement: CountySourceReportRecord['statement'];
  readonly competitors: readonly CountySourceCompetitorCells[];
}

export const competitor = (
  sourceLabel: string,
  voturi: string | null,
  mandate: string | null,
  privacyClass = 'public'
): CountySourceCompetitorCells => ({ sourceLabel, privacyClass, voturi, mandate });

/** The file's 234 labels: the named ones, then zero-valued synthetic labels. */
export const completeCompetitors = (
  named: readonly CountySourceCompetitorCells[]
): CountySourceCompetitorCells[] => [
  ...named,
  ...Array.from({ length: 234 - named.length }, (_unused, index) =>
    competitor(`SINTETIC ${String(index + 1).padStart(3, '0')}`, '0', '0')
  ),
];

/** All 12 admitted statement cells: a above 2^53, zeros kept. */
export const completeStatement = (
  values: Readonly<Record<string, string>> = {}
): CountySourceReportRecord['statement'] =>
  ['a', 'a1', 'a2', 'a3', 'a4', 'b', 'b1', 'b2', 'b3', 'b4', 'c', 'd'].map((metricCode) => ({
    metricCode,
    value: values[metricCode] ?? '0',
  }));

export const countyContest = (
  scopeKey: string,
  scopeLabel: string,
  privacyClass = 'public'
): CountySourceReportRecord['contest'] => ({
  contestKey: `contest:aep-local-2020:mayor:county:${scopeKey}`,
  privacyClass,
  electionKey: 'aep-local-2020',
  electionPrivacyClass: 'public',
  office: 'mayor',
  scopeType: 'county',
  scopeKey,
  scopeLabel,
});

export const COUNTY_SOURCE_REPORTS: readonly CountySourceFixture[] = [
  {
    contest: countyContest('1', 'ALBA'),
    // Unordered on purpose; a above 2^53 and zeros among the values.
    statement: [
      ...completeStatement({
        a: '9007199254740993',
        a3: '5',
        a4: '7',
        b: '100',
        b1: '50',
        b4: '3',
        c: '60',
      }),
    ].reverse(),
    competitors: [
      ...completeCompetitors([
        competitor('PARTIDUL NAȚIONAL LIBERAL', '40', '2'),
        competitor('Candidat Independent', '20', '0'),
        competitor('"ALIANȚA ELECTORALĂ X"', '0', '0'),
      ]),
      // A 235th label the SQL never returns (not public).
      competitor(RESTRICTED_SENTINEL, '1', '1', 'restricted'),
    ].reverse(),
  },
  {
    contest: countyContest('42', 'MUNICIPIUL BUCUREŞTI'),
    statement: completeStatement({ c: '657159' }),
    competitors: completeCompetitors([competitor('PARTIDUL NAȚIONAL LIBERAL', '1', '1')]),
  },
  {
    contest: countyContest(RESTRICTED_SENTINEL, RESTRICTED_SENTINEL, 'restricted'),
    statement: completeStatement(),
    competitors: completeCompetitors([competitor(RESTRICTED_SENTINEL, '1', '1')]),
  },
];

const COUNT_CELL = /^(?:0|[1-9][0-9]*)$/u;

/** The repository's label grouping: cells per column, the smallest text value, the greatest class. */
const groupByLabel = (cells: readonly CountySourceCompetitorCells[]) => {
  const groups = new Map<string, CountySourceCompetitorCells[]>();
  for (const cell of cells)
    groups.set(cell.sourceLabel, [...(groups.get(cell.sourceLabel) ?? []), cell]);
  const least = (values: readonly (string | null | undefined)[]) =>
    values.filter((v): v is string => typeof v === 'string').sort(byKey)[0] ?? null;
  return [...groups.entries()]
    .sort(([a], [b]) => byKey(a, b))
    .map(([sourceLabel, rows]) => {
      const numbers = rows.flatMap((r) => [r.voturi, r.mandate]).filter((v) => v !== undefined);
      return {
        record: {
          sourceLabel,
          privacyClass:
            rows
              .map((r) => r.privacyClass)
              .sort(byKey)
              .at(-1) ?? 'public',
          voturiCells: rows.filter((r) => r.voturi !== undefined).length,
          voturi: least(rows.map((r) => r.voturi)),
          mandateCells: rows.filter((r) => r.mandate !== undefined).length,
          mandate: least(rows.map((r) => r.mandate)),
        } satisfies CountySourceCompetitorRecord,
        nullCells: numbers.filter((v) => v === null).length,
        nonIntegerCells: numbers.filter((v) => typeof v === 'string' && !COUNT_CELL.test(v)).length,
      };
    });
};

export interface FakeElectionsRepo extends ElectionsRepository {
  /** Every repository call, in order (method name only). */
  readonly calls: string[];
}

export const makeFakeElectionsRepo = (
  options: {
    readonly leak?: boolean;
    readonly editions?: readonly EditionRow[];
    readonly contests?: readonly ContestRow[];
    readonly reports?: readonly CountySourceFixture[];
  } = {}
): FakeElectionsRepo => {
  const calls: string[] = [];
  const visible = (privacyClass: string) => options.leak === true || privacyClass === 'public';
  const editions = (options.editions ?? EDITION_ROWS).filter((row) => visible(row.privacyClass));
  const contestRows = options.contests ?? CONTEST_ROWS;
  const parentOf = (row: ContestRow) => editions.find((e) => e.electionKey === row.electionKey);
  return {
    calls,
    listEditions(request) {
      calls.push('listEditions');
      const rows = editions
        .map(editionRecord)
        .filter(
          (r) =>
            matches(request.filter, 'reportedYears', r.year) &&
            matches(request.filter, 'reportedFamilies', r.family) &&
            matches(request.filter, 'eventKeys', r.eventKey)
        )
        .sort((a, b) => byKey(a.electionKey, b.electionKey));
      return Promise.resolve(ok(pageOf(rows, request.page, request.pageSize)));
    },
    editionByKey(electionKey) {
      calls.push('editionByKey');
      const row = editions.find((e) => e.electionKey === electionKey);
      return Promise.resolve(ok(row === undefined ? null : editionRecord(row)));
    },
    listContests(request) {
      calls.push('listContests');
      const parent = editions.find((e) => e.electionKey === request.electionKey);
      if (parent === undefined) return Promise.resolve(ok(null));
      const rows = contestRows
        .filter((row) => row.electionKey === parent.electionKey && visible(row.privacyClass))
        .map((row) => contestRecord(row, parent))
        .filter(
          (r) =>
            matches(request.filter, 'reportedOffices', r.office) &&
            matches(request.filter, 'scopeTypes', r.scopeType) &&
            matches(request.filter, 'reportedRounds', r.roundLabel)
        )
        .sort((a, b) => byKey(a.contestKey, b.contestKey));
      return Promise.resolve(ok(pageOf(rows, request.page, request.pageSize)));
    },
    contestByKey(contestKey) {
      calls.push('contestByKey');
      const row = contestRows.find((c) => c.contestKey === contestKey && visible(c.privacyClass));
      const parent = row === undefined ? undefined : parentOf(row);
      return Promise.resolve(
        ok(row === undefined || parent === undefined ? null : contestRecord(row, parent))
      );
    },
    countySourceReport(request) {
      calls.push('countySourceReport');
      const report = (options.reports ?? COUNTY_SOURCE_REPORTS).find(
        (r) =>
          r.contest.contestKey === request.contestKey &&
          visible(r.contest.privacyClass) &&
          visible(r.contest.electionPrivacyClass)
      );
      if (report === undefined) return Promise.resolve(ok(null));
      const groups = groupByLabel(report.competitors.filter((c) => visible(c.privacyClass)));
      const labels = groups.map((group) => group.record);
      return Promise.resolve(
        ok({
          contest: report.contest,
          statement: report.statement,
          competitors: pageOf(labels, request.page, request.pageSize),
          integrity: {
            completeLabels: labels.filter((l) => l.voturiCells === 1 && l.mandateCells === 1)
              .length,
            duplicatedLabels: labels.filter((l) => l.voturiCells > 1 || l.mandateCells > 1).length,
            labelsWithNullCell: groups.filter((g) => g.nullCells > 0).length,
            labelsWithNonIntegerCell: groups.filter((g) => g.nonIntegerCells > 0).length,
          },
        })
      );
    },
  };
};
