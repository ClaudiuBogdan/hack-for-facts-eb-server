/**
 * An in-memory Elections repository over the port: one published local event
 * with two contests (a mayoralty and a county council with a UAT breakdown),
 * an office aggregate, and coverage. It pages and filters like the SQL
 * repository (C key order, exact totals) and records each call, so surface
 * tests can prove a refusal happened before any read.
 */
import { ok } from 'neverthrow';

import { offsetFor } from '@/modules/shared/index.js';

import type {
  ElectionCompetitorRecord,
  ElectionContestRaceRecord,
  ElectionEventRecord,
  ElectionPlaceRecord,
  ElectionRecordPage,
  ElectionResultRecord,
  ElectionScopeFiguresRecord,
  ElectionTallyRecord,
  ElectionTurnoutRecord,
} from '@/modules/elections/core/types.js';
import type { ElectionsRepository } from '@/modules/elections/index.js';

export const EVENT = 'ro:local:2024';
export const OCCURRENCE = 'ro:local:2024:2024-06-09';
export const MAYOR = `${OCCURRENCE}:mayor:uat:1017`;
export const COUNCIL = `${OCCURRENCE}:county_council:county:AB`;

const PARTY_A: ElectionCompetitorRecord = {
  competitorKey: 'partidul-a',
  kind: 'party',
  actorKey: 'partidul-a',
  label: 'PARTIDUL A',
  reportedLabels: ['PARTIDUL A'],
};
const PARTY_B: ElectionCompetitorRecord = {
  competitorKey: 'partidul-b',
  kind: 'party',
  actorKey: 'partidul-b',
  label: 'PARTIDUL B',
  reportedLabels: ['PARTIDUL B'],
};
const COMPETITORS = [PARTY_A, PARTY_B];

const ALBA_IULIA: ElectionPlaceRecord = {
  placeKey: 'uat:1017',
  name: 'MUNICIPIUL ALBA IULIA',
  countyCode: 'AB',
  countyName: 'ALBA',
};
const ALBAC: ElectionPlaceRecord = {
  placeKey: 'uat:1026',
  name: 'ALBAC',
  countyCode: 'AB',
  countyName: 'ALBA',
};
const ALBA: ElectionPlaceRecord = {
  placeKey: 'county:AB',
  name: 'ALBA',
  countyCode: 'AB',
  countyName: 'ALBA',
};

const quality = {
  construction: 'summed_leaves',
  sourceLevel: 'pv_lines',
  finality: 'final',
  geographicCompleteness: 'complete',
  includesDiaspora: null,
  status: 'UNCHECKED',
  issues: [] as string[],
};

const votes = (competitor: ElectionCompetitorRecord, value: string): ElectionTallyRecord => ({
  ...quality,
  competitor,
  reportedLabel: competitor.label,
  measure: 'votes',
  allocationPhase: 'none',
  countedPopulation: 'all',
  value,
});

const turnout = (measure: string, value: string): ElectionTurnoutRecord => ({
  ...quality,
  measure,
  value,
});

const figures = (
  place: ElectionPlaceRecord,
  a: string,
  b: string,
  valid: string | null
): ElectionScopeFiguresRecord => ({
  place,
  tallies: [votes(PARTY_A, a), votes(PARTY_B, b)],
  turnout:
    valid === null
      ? []
      : [turnout('registered', '2000'), turnout('voted', '1000'), turnout('valid', valid)],
});

const contest = (
  contestKey: string,
  office: string,
  jurisdiction: ElectionPlaceRecord,
  scope: ElectionScopeFiguresRecord
): ElectionContestRaceRecord => ({
  contestKey,
  occurrenceKey: OCCURRENCE,
  eventKey: EVENT,
  office,
  status: 'held',
  replacedBy: null,
  jurisdiction,
  votes: scope.tallies,
  valid: scope.turnout.find((figure) => figure.measure === 'valid') ?? null,
});

const MAYOR_FIGURES = figures(ALBA_IULIA, '600', '350', '950');
const COUNCIL_FIGURES = figures(ALBA, '2000', '1000', '3000');
const COUNCIL_CHILDREN = [
  figures(ALBA_IULIA, '1200', '600', '1800'),
  figures(ALBAC, '800', '400', null),
];
const AGGREGATE = figures(ALBA, '600', '350', '950');

const CONTESTS = [
  contest(COUNCIL, 'county_council', ALBA, COUNCIL_FIGURES),
  contest(MAYOR, 'mayor', ALBA_IULIA, MAYOR_FIGURES),
];

export const EVENT_RECORD: ElectionEventRecord = {
  eventKey: EVENT,
  publicationId: '2',
  activatedAt: '2026-10-20T17:45:00.000Z',
  occurrences: [
    {
      occurrenceKey: OCCURRENCE,
      eventKey: EVENT,
      ballotDate: '2024-06-09',
      round: 'r1',
      kind: 'general',
      status: 'held',
      offices: [
        { office: 'county_council', contests: 1 },
        { office: 'mayor', contests: 1 },
      ],
    },
  ],
};

const pageOf = <T>(items: readonly T[], request: { page: number; pageSize: number }) => {
  const start = offsetFor(request);
  const page: ElectionRecordPage<T> = {
    items: items.slice(start, start + request.pageSize),
    total: items.length,
  };
  return page;
};

export type FakeElectionsRepo = ElectionsRepository & { readonly calls: string[] };

export const makeFakeElectionsRepo = (): FakeElectionsRepo => {
  const calls: string[] = [];
  return {
    calls,
    listEvents: (request) => {
      calls.push('listEvents');
      return Promise.resolve(ok(pageOf([EVENT_RECORD], request)));
    },
    eventByKey: (eventKey) => {
      calls.push('eventByKey');
      return Promise.resolve(ok(eventKey === EVENT ? EVENT_RECORD : null));
    },
    listContests: (request) => {
      calls.push('listContests');
      if (request.occurrenceKey !== OCCURRENCE) return Promise.resolve(ok(null));
      const offices = request.filter['offices']?.['in'] as string[] | undefined;
      const matched = CONTESTS.filter(
        (item) => offices === undefined || offices.includes(item.office)
      );
      return Promise.resolve(ok(pageOf(matched, request)));
    },
    contestByKey: (contestKey) => {
      calls.push('contestByKey');
      return Promise.resolve(ok(CONTESTS.find((item) => item.contestKey === contestKey) ?? null));
    },
    result: (request) => {
      calls.push('result');
      if (request.occurrenceKey !== OCCURRENCE) return Promise.resolve(ok(null));
      const found = CONTESTS.find((item) => item.contestKey === request.contestKey);
      if (request.contestKey !== null && found?.office !== request.office)
        return Promise.resolve(ok(null));
      const scope =
        found === undefined
          ? request.office === 'mayor' && request.scopeKey === 'county:AB'
            ? AGGREGATE
            : undefined
          : [
              found.contestKey === MAYOR ? MAYOR_FIGURES : COUNCIL_FIGURES,
              ...COUNCIL_CHILDREN,
            ].find((item) => item.place.placeKey === request.scopeKey);
      if (scope === undefined) return Promise.resolve(ok(null));
      const record: ElectionResultRecord = {
        occurrenceKey: OCCURRENCE,
        eventKey: EVENT,
        office: request.office,
        contest:
          found === undefined
            ? null
            : {
                contestKey: found.contestKey,
                occurrenceKey: found.occurrenceKey,
                eventKey: found.eventKey,
                office: found.office,
                status: found.status,
                replacedBy: found.replacedBy,
                jurisdiction: found.jurisdiction,
              },
        ...scope,
        coverage: [
          {
            measure: 'votes',
            allocationPhase: 'none',
            scopeKey: null,
            state: 'usable',
            issues: [],
          },
        ],
      };
      return Promise.resolve(ok(record));
    },
    listResultScopes: (request) => {
      calls.push('listResultScopes');
      if (request.occurrenceKey !== OCCURRENCE) return Promise.resolve(ok(null));
      if (request.contestKey === COUNCIL && request.office === 'county_council')
        return Promise.resolve(
          ok(pageOf(request.scopeType === 'uat' ? COUNCIL_CHILDREN : [], request))
        );
      if (request.contestKey === null && request.office === 'mayor')
        return Promise.resolve(
          ok(pageOf(request.scopeType === 'county' ? [AGGREGATE] : [], request))
        );
      return Promise.resolve(ok(null));
    },
    listCompetitors: (request) => {
      calls.push('listCompetitors');
      if (request.eventKey !== EVENT) return Promise.resolve(ok(null));
      const kinds = request.filter['kinds']?.['in'] as string[] | undefined;
      const matched = COMPETITORS.filter(
        (item) => kinds === undefined || kinds.includes(item.kind)
      );
      return Promise.resolve(ok(pageOf(matched, request)));
    },
  };
};
