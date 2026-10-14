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

import { electionCatalogFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';
import {
  getElectionContest,
  getElectionEdition,
  listElectionContests,
  listElectionEditions,
  type ElectionsDeps,
} from '../../core/usecases.js';

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});
const catalogFilterSchema = toTypeBox(electionCatalogFilterSpec);
const contestsFilterSchema = toTypeBox(electionContestsFilterSpec);

const HELD_NOTE =
  'Identity, source selection and source opening are HELD; results and mandates are UNAVAILABLE. Never present a row as a winner, a final or certified result, or complete coverage.';

const pageInput = {
  filter: z.record(z.string(), z.unknown()).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
};

const pageArgs = (args: Record<string, unknown>) => ({
  page: typeof args['page'] === 'number' ? args['page'] : 1,
  pageSize: typeof args['pageSize'] === 'number' ? args['pageSize'] : 20,
});

/** No `link`: the client has no live Elections route yet. Same usecases as GraphQL and REST. */
export const makeElectionsMcpTools = (deps: ElectionsDeps): readonly KernelMcpTool[] => [
  {
    name: 'list_election_editions',
    description: `Romanian election data SOURCE EDITIONS (one row per loaded source edition, not per election: editions of one event overlap and are not additive). Resolves reported years/families/event keys to electionKey values. Filters: reportedYears.in, reportedFamilies.in, eventKeys.in. Reported labels are matched exactly as stored and can be wrong (European Parliament editions are stored with family parliamentary). electionKey order, pageSize up to 100. ${HELD_NOTE}`,
    strictInput: true,
    inputShape: pageInput,
    async handler(args) {
      const kind = 'election_editions';
      const filter = args['filter'] ?? {};
      if (!Value.Check(catalogFilterSchema, filter))
        return failure(kind, { type: 'InvalidInput', message: 'Invalid election catalog filter.' });
      const { page, pageSize } = pageArgs(args);
      const result = await listElectionEditions(deps, {
        filter: filter as FilterInput,
        page,
        pageSize,
      });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { filter, page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore, totalCounts: 'source_editions' },
        summary: `${String(total)} source edition(s) match (not distinct elections); page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
  {
    name: 'get_election_edition',
    description: `One election data source edition by electionKey, with its reported (unverified) labels and readiness. Null when absent or not public. ${HELD_NOTE}`,
    strictInput: true,
    inputShape: { electionKey: z.string().min(1).max(512) },
    async handler(args) {
      const kind = 'election_edition';
      const electionKey = typeof args['electionKey'] === 'string' ? args['electionKey'] : '';
      const result = await getElectionEdition(deps, electionKey);
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: { electionKey },
        item: result.value,
        summary:
          result.value === null
            ? `No public source edition ${electionKey}.`
            : `Source edition ${electionKey}: reported ${result.value.reportedFamily} ${String(result.value.reportedYear ?? 'year unknown')}; identity held.`,
      };
    },
  },
  {
    name: 'list_election_contests',
    description: `Contests of one election source edition (contest metadata only; no votes, turnout, winners or mandates). Filters: reportedOffices.in, scopeTypes.in, reportedRounds.in. sourceScopeKey is the source's scope, not a verified territory. contestKey order, pageSize up to 100. ${HELD_NOTE}`,
    strictInput: true,
    inputShape: { electionKey: z.string().min(1).max(512), ...pageInput },
    async handler(args) {
      const kind = 'election_contests';
      const filter = args['filter'] ?? {};
      if (!Value.Check(contestsFilterSchema, filter))
        return failure(kind, { type: 'InvalidInput', message: 'Invalid election contest filter.' });
      const electionKey = typeof args['electionKey'] === 'string' ? args['electionKey'] : '';
      const { page, pageSize } = pageArgs(args);
      const result = await listElectionContests(deps, {
        electionKey,
        filter: filter as FilterInput,
        page,
        pageSize,
      });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, hasMore } = result.value;
      return {
        ok: true,
        kind,
        query: { electionKey, filter, page, pageSize },
        items,
        meta: { page, pageSize, total, hasMore, totalCounts: 'source_contests' },
        summary: `${String(total)} source contest(s) in ${electionKey} match; page ${String(page)} shows ${String(items.length)}. Results are unavailable.`,
      };
    },
  },
  {
    name: 'get_election_contest',
    description: `One election source contest by contestKey (metadata only; results unavailable). Null when absent or not public. ${HELD_NOTE}`,
    strictInput: true,
    inputShape: { contestKey: z.string().min(1).max(512) },
    async handler(args) {
      const kind = 'election_contest';
      const contestKey = typeof args['contestKey'] === 'string' ? args['contestKey'] : '';
      const result = await getElectionContest(deps, contestKey);
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: { contestKey },
        item: result.value,
        summary:
          result.value === null
            ? `No public source contest ${contestKey}.`
            : `Source contest ${contestKey}: reported ${result.value.reportedOffice}, scope ${result.value.scopeType} ${result.value.sourceScopeKey}; results unavailable.`,
      };
    },
  },
];
