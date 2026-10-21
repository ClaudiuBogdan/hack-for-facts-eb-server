import { Value } from '@sinclair/typebox/value';
import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  toTypeBox,
  type ApiError,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { electionCompetitorsFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';
import { ELECTION_PLACE_TYPES, type ElectionPlaceType } from '../../core/types.js';
import {
  getElectionEvent,
  getElectionResult,
  listElectionCompetitors,
  listElectionContests,
  listElectionEvents,
  listElectionResultScopes,
  type ElectionsDeps,
} from '../../core/usecases.js';

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});
const contestsFilterSchema = toTypeBox(electionContestsFilterSpec);
const competitorsFilterSchema = toTypeBox(electionCompetitorsFilterSpec);

const FIGURES_NOTE =
  'Values are integers as strings; 0 means the source printed 0 and a missing figure has no row. Each figure carries status (VERIFIED equals a separately published figure; UNCHECKED has no counterpart; SUSPECT is a known defect), completeness and issues: report them. A race leader is not a winner and votes are not mandates; mandate phases (man_1, man_2, final) are never summed.';

const key = z.string().min(1).max(512);
const pageInput = {
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
};

const pageArgs = (args: Record<string, unknown>) => ({
  page: typeof args['page'] === 'number' ? args['page'] : 1,
  pageSize: typeof args['pageSize'] === 'number' ? args['pageSize'] : 20,
});

const text = (args: Record<string, unknown>, name: string): string =>
  typeof args[name] === 'string' ? args[name] : '';

const optionalText = (args: Record<string, unknown>, name: string): string | null =>
  typeof args[name] === 'string' ? args[name] : null;

/** No `link`: the client has no live Elections route yet. Same usecases as GraphQL and REST. */
export const makeElectionsMcpTools = (deps: ElectionsDeps): readonly KernelMcpTool[] => [
  {
    name: 'list_election_events',
    description:
      'Romanian election events with published, audited figures (e.g. ro:local:2024, ro:parliamentary:2020), each with its occurrences (ballot days: round, kind, status) and the offices and contest counts of each. Start here to find occurrenceKey values. eventKey order, pageSize up to 100.',
    strictInput: true,
    inputShape: pageInput,
    async handler(args) {
      const kind = 'election_events';
      const { page, pageSize } = pageArgs(args);
      const result = await listElectionEvents(deps, { page, pageSize });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore },
        summary: `${String(total)} event(s) with published figures; page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
  {
    name: 'get_election_event',
    description:
      'One election event by eventKey with its occurrences (ballot days) and the offices and contest counts of each. Null when not published.',
    strictInput: true,
    inputShape: { eventKey: key },
    async handler(args) {
      const kind = 'election_event';
      const eventKey = text(args, 'eventKey');
      const result = await getElectionEvent(deps, eventKey);
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: { eventKey },
        item: result.value,
        summary:
          result.value === null
            ? `No published figures for event ${eventKey}.`
            : `Event ${eventKey}: ${String(result.value.occurrences.length)} occurrence(s).`,
      };
    },
  },
  {
    name: 'list_election_contests',
    description: `Contests of one occurrence, each with its race (leader, runner-up, margin) at its jurisdiction. Filters: offices.in, statuses.in, jurisdictionTypes.in (uat, county, diaspora, national), countyCodes.in (e.g. CJ, B). contestKey order, pageSize up to 100. ${FIGURES_NOTE}`,
    strictInput: true,
    inputShape: {
      occurrenceKey: key,
      filter: z.record(z.string(), z.unknown()).optional(),
      ...pageInput,
    },
    async handler(args) {
      const kind = 'election_contests';
      const filter = args['filter'] ?? {};
      if (!Value.Check(contestsFilterSchema, filter))
        return failure(kind, { type: 'InvalidInput', message: 'Invalid election contest filter.' });
      const occurrenceKey = text(args, 'occurrenceKey');
      const { page, pageSize } = pageArgs(args);
      const result = await listElectionContests(deps, {
        occurrenceKey,
        filter: filter as FilterInput,
        page,
        pageSize,
      });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { occurrenceKey, filter, page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore },
        summary: `${String(total)} contest(s) in ${occurrenceKey} match; page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
  {
    name: 'get_election_result',
    description: `Every figure of one place for an office on an occurrence: votes and mandates per competitor with shares of valid votes, turnout, participation and coverage. With contestKey, the contest's figures at scopeKey (its jurisdiction or a breakdown place); without, the office aggregate (e.g. county:CJ or national). Null when the place has no figures. ${FIGURES_NOTE}`,
    strictInput: true,
    inputShape: {
      occurrenceKey: key,
      office: z.string().min(1).max(64),
      scopeKey: key,
      contestKey: key.optional(),
    },
    async handler(args) {
      const kind = 'election_result';
      const request = {
        occurrenceKey: text(args, 'occurrenceKey'),
        office: text(args, 'office'),
        scopeKey: text(args, 'scopeKey'),
        contestKey: optionalText(args, 'contestKey'),
      };
      const result = await getElectionResult(deps, request);
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: request,
        item: result.value,
        summary:
          result.value === null
            ? `No figures for ${request.office} at ${request.scopeKey}.`
            : `${request.office} at ${request.scopeKey}: ${String(result.value.tallies.length)} tally row(s), ${String(result.value.turnout.length)} turnout figure(s).`,
      };
    },
  },
  {
    name: 'list_election_result_scopes',
    description: `The places of one type (uat, county, diaspora, national) with figures for an office on an occurrence, each with its figures: a contest's breakdown (contestKey) or the office aggregate's places. scopeKey order, pageSize up to 100. ${FIGURES_NOTE}`,
    strictInput: true,
    inputShape: {
      occurrenceKey: key,
      office: z.string().min(1).max(64),
      scopeType: z.enum(ELECTION_PLACE_TYPES),
      contestKey: key.optional(),
      ...pageInput,
    },
    async handler(args) {
      const kind = 'election_result_scopes';
      const { page, pageSize } = pageArgs(args);
      const request = {
        occurrenceKey: text(args, 'occurrenceKey'),
        office: text(args, 'office'),
        scopeType: text(args, 'scopeType') as ElectionPlaceType,
        contestKey: optionalText(args, 'contestKey'),
      };
      const result = await listElectionResultScopes(deps, { ...request, page, pageSize });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { ...request, page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore },
        summary: `${String(total)} place(s) with figures; page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
  {
    name: 'list_election_competitors',
    description:
      'Competitors (parties, minority organisations, lists, independents) of one published event, with the labels the sources printed. Filter: kinds.in. competitorKey order, pageSize up to 100.',
    strictInput: true,
    inputShape: {
      eventKey: key,
      filter: z.record(z.string(), z.unknown()).optional(),
      ...pageInput,
    },
    async handler(args) {
      const kind = 'election_competitors';
      const filter = args['filter'] ?? {};
      if (!Value.Check(competitorsFilterSchema, filter))
        return failure(kind, {
          type: 'InvalidInput',
          message: 'Invalid election competitor filter.',
        });
      const eventKey = text(args, 'eventKey');
      const { page, pageSize } = pageArgs(args);
      const result = await listElectionCompetitors(deps, {
        eventKey,
        filter: filter as FilterInput,
        page,
        pageSize,
      });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { eventKey, filter, page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore },
        summary: `${String(total)} competitor(s) in ${eventKey}; page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
];
