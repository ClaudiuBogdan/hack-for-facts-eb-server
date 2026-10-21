/**
 * Elections REST: the GET reads under `/api/v1/elections`, over the SAME
 * usecases GraphQL and MCP call (no SQL, projection or rule of its own).
 *
 *   GET /events               page, pageSize
 *   GET /events/lookup        eventKey
 *   GET /contests             occurrenceKey (required), offices, statuses, jurisdictionTypes,
 *                             countyCodes, page, pageSize
 *   GET /contests/lookup      contestKey
 *   GET /results/lookup       occurrenceKey, office, scopeKey (required), contestKey
 *   GET /results              occurrenceKey, office, scopeType (required), contestKey, page, pageSize
 *   GET /competitors          eventKey (required), kinds, page, pageSize
 *
 * Keys travel as query parameters, never path segments: they are opaque keys
 * of up to 512 characters and the standalone router caps a path parameter at
 * 100. A repeated filter parameter is a list (no CSV splitting) and becomes
 * that spec field's `in`, so all three surfaces validate one FilterInput. The
 * query is decoded from Fastify's parsed object before any coercion: unknown
 * or repeated scalar parameters are refused.
 *
 * Envelopes (foundation §5.2/§14.11): `{ ok:true, data, meta?, requestId }` and
 * `{ ok:false, error, message, field?, resource?, requestId }`; a 5xx carries a
 * fixed message, and a framework 4xx (an inherited 429) keeps its status and
 * headers. Every reply is `Cache-Control: no-store` (no freshness contract yet).
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  httpStatusFor,
  invalidInput,
  notFound,
  toTypeBox,
  type ApiError,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { electionCompetitorsFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';
import {
  ELECTION_COMPETITOR_KINDS,
  ELECTION_PLACE_TYPES,
  ELECTION_STATUSES,
  type ElectionPage,
  type ElectionPlaceType,
} from '../../core/types.js';
import {
  getElectionContest,
  getElectionEvent,
  getElectionResult,
  listElectionCompetitors,
  listElectionContests,
  listElectionEvents,
  listElectionResultScopes,
  type ElectionsDeps,
} from '../../core/usecases.js';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/** The fixed 5xx message: no cause, SQL or driver text reaches a client. */
const INTERNAL_MESSAGE = 'elections read failed; quote the requestId to report it';

type ParamKind = 'int' | 'string' | 'intList' | 'stringList';
type ParamTable = Readonly<Record<string, ParamKind>>;
type Decoded = Readonly<Record<string, number | string | readonly (number | string)[]>>;

const INT_TEXT = /^-?(?:0|[1-9][0-9]*)$/u;
const PAGE_PARAMS: ParamTable = { page: 'int', pageSize: 'int' };

/** One list parameter per spec field: an int field decodes to integers, any other to strings. */
const filterParams = (spec: CollectionFilterSpec): ParamTable =>
  Object.fromEntries(
    spec.fields.map((field) => [field.name, field.type === 'int' ? 'intList' : 'stringList'])
  );

const PARAMS = {
  events: { ...PAGE_PARAMS },
  event: { eventKey: 'string' },
  contests: {
    occurrenceKey: 'string',
    ...filterParams(electionContestsFilterSpec),
    ...PAGE_PARAMS,
  },
  contest: { contestKey: 'string' },
  result: { occurrenceKey: 'string', office: 'string', scopeKey: 'string', contestKey: 'string' },
  results: {
    occurrenceKey: 'string',
    office: 'string',
    scopeType: 'string',
    contestKey: 'string',
    ...PAGE_PARAMS,
  },
  competitors: {
    eventKey: 'string',
    ...filterParams(electionCompetitorsFilterSpec),
    ...PAGE_PARAMS,
  },
} satisfies Record<string, ParamTable>;

const decodeInt = (key: string, text: string): Result<number, ApiError> => {
  const value = INT_TEXT.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(value)
    ? ok(value)
    : err(invalidInput(`${key} must be an integer`, key));
};

/** Decode the parsed query against its table. An unknown parameter is refused, never echoed. */
const decodeQuery = (raw: unknown, table: ParamTable): Result<Decoded, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw))
    return err(invalidInput('malformed query string', 'query'));
  const out: Record<string, number | string | (number | string)[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(table, key) ? table[key] : undefined;
    if (kind === undefined) return err(invalidInput('unsupported query parameter', 'query'));
    const texts: unknown[] = Array.isArray(value) ? value : [value];
    if (!texts.every((text): text is string => typeof text === 'string'))
      return err(invalidInput(`malformed ${key}`, key));
    if ((kind === 'int' || kind === 'string') && texts.length !== 1)
      return err(invalidInput(`${key} may appear only once`, key));
    if (kind === 'string' || kind === 'stringList') {
      out[key] = kind === 'string' ? (texts[0] ?? '') : texts;
      continue;
    }
    const numbers: number[] = [];
    for (const text of texts) {
      const parsed = decodeInt(key, text);
      if (parsed.isErr()) return err(parsed.error);
      numbers.push(parsed.value);
    }
    out[key] = kind === 'int' ? (numbers[0] ?? 0) : numbers;
  }
  return ok(out);
};

/** The decoded lists of a spec's fields as the shared `{ field: { in } }` filter. */
const filterOf = (
  spec: CollectionFilterSpec,
  decoded: Decoded,
  label: string
): Result<FilterInput, ApiError> => {
  const filter: Record<string, { in: Decoded[string] }> = {};
  for (const field of spec.fields) {
    const values = decoded[field.name];
    if (values !== undefined) filter[field.name] = { in: values };
  }
  return Value.Check(toTypeBox(spec), filter)
    ? ok(filter as FilterInput)
    : err(invalidInput(`Invalid ${label} filter.`));
};

const pageOf = (decoded: Decoded) => ({
  page: typeof decoded['page'] === 'number' ? decoded['page'] : 1,
  pageSize: typeof decoded['pageSize'] === 'number' ? decoded['pageSize'] : 20,
});

const requiredKey = (decoded: Decoded, key: string): Result<string, ApiError> => {
  const value = decoded[key];
  return typeof value === 'string' ? ok(value) : err(invalidInput(`${key} is required`, key));
};

const Key = Type.String({ minLength: 1, maxLength: 512 });
const Office = Type.String({ minLength: 1, maxLength: 64 });
const Page = {
  page: Type.Optional(Type.Integer()),
  pageSize: Type.Optional(Type.Integer()),
};
const oneOf = (values: readonly string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const listOf = (item: TSchema) => Type.Optional(Type.Array(item, { maxItems: 100 }));
const strict = { additionalProperties: false };

/** The decoded query of every route, checked at the route boundary (foundation §6.1). */
const QUERY = {
  events: Type.Object({ ...Page }, strict),
  event: Type.Object({ eventKey: Key }, strict),
  contests: Type.Object(
    {
      occurrenceKey: Key,
      offices: listOf(Office),
      statuses: listOf(oneOf(ELECTION_STATUSES)),
      jurisdictionTypes: listOf(oneOf(ELECTION_PLACE_TYPES)),
      countyCodes: listOf(Type.String({ pattern: '^[A-Z]{1,2}$' })),
      ...Page,
    },
    strict
  ),
  contest: Type.Object({ contestKey: Key }, strict),
  result: Type.Object(
    { occurrenceKey: Key, office: Office, scopeKey: Key, contestKey: Type.Optional(Key) },
    strict
  ),
  results: Type.Object(
    {
      occurrenceKey: Key,
      office: Office,
      scopeType: oneOf(ELECTION_PLACE_TYPES),
      contestKey: Type.Optional(Key),
      ...Page,
    },
    strict
  ),
  competitors: Type.Object(
    { eventKey: Key, kinds: listOf(oneOf(ELECTION_COMPETITOR_KINDS)), ...Page },
    strict
  ),
} satisfies Record<keyof typeof PARAMS, TSchema>;

/** Decode a route's query, then check it against the route's schema; the field names the first fault. */
const decode = (raw: unknown, route: keyof typeof PARAMS): Result<Decoded, ApiError> =>
  decodeQuery(raw, PARAMS[route]).andThen((decoded) => {
    const fault = Value.Errors(QUERY[route], decoded).First();
    if (fault === undefined) return ok(decoded);
    const field = fault.path.split('/')[1] ?? 'query';
    return err(invalidInput(`Invalid ${field}.`, field));
  });

const optionalKey = (decoded: Decoded, key: string): string | null => {
  const value = decoded[key];
  return typeof value === 'string' ? value : null;
};

export const makeElectionsRestPlugin =
  (deps: ElectionsDeps): FastifyPluginAsync =>
  async (fastify) => {
    fastify.addHook('onSend', async (_request, reply, payload) => {
      void reply.header('cache-control', 'no-store');
      return payload;
    });

    // Anything thrown inside this scope still gets the module envelope. A framework
    // 4xx (the inherited rate limit's 429, a malformed request) keeps its status and
    // the headers already set on the reply (Retry-After), with a fixed message;
    // anything else is an unexpected fault and a fixed 500.
    fastify.setErrorHandler((error, request, reply) => {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) {
        return reply.status(status).send({
          ok: false as const,
          error: status === 429 ? 'RateLimited' : 'RequestRejected',
          message: status === 429 ? 'rate limit exceeded; retry later' : 'request rejected',
          requestId: request.id,
        });
      }
      request.log.error({ err: error }, '[elections] REST route failed');
      return reply.status(500).send({
        ok: false as const,
        error: 'Database',
        message: INTERNAL_MESSAGE,
        requestId: request.id,
      });
    });

    const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
      const status = httpStatusFor(error);
      if (status >= 500) {
        request.log.error({ err: error }, '[elections] REST read failed');
        return reply.status(status).send({
          ok: false as const,
          error: error.type,
          message: INTERNAL_MESSAGE,
          requestId: request.id,
        });
      }
      return reply.status(status).send({
        ok: false as const,
        error: error.type,
        message: error.message,
        ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
        ...(error.type === 'NotFound' &&
          error.resource !== undefined && { resource: error.resource }),
        requestId: request.id,
      });
    };

    const sendPage = <T>(
      request: FastifyRequest,
      reply: FastifyReply,
      result: Result<ElectionPage<T>, ApiError>,
      totalCounts: string
    ) => {
      if (result.isErr()) return sendError(request, reply, result.error);
      const { items, page, pageSize, total, hasMore } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data: items,
        meta: { page: { page, pageSize, total }, hasMore, totalCounts },
        requestId: request.id,
      });
    };

    /** A valid but absent (or non-public) row is a 404. */
    const sendItem = <T>(
      request: FastifyRequest,
      reply: FastifyReply,
      result: Result<T | null, ApiError>,
      resource: string
    ) => {
      if (result.isErr()) return sendError(request, reply, result.error);
      if (result.value === null)
        return sendError(request, reply, notFound(`Election ${resource} not found.`, resource));
      return reply
        .status(200)
        .send({ ok: true as const, data: result.value, requestId: request.id });
    };

    fastify.get('/events', async (request, reply) => {
      const decoded = decode(request.query, 'events');
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await listElectionEvents(deps, pageOf(decoded.value));
      return sendPage(request, reply, result, 'events');
    });

    fastify.get('/events/lookup', async (request, reply) => {
      const key = decode(request.query, 'event').andThen((decoded) =>
        requiredKey(decoded, 'eventKey')
      );
      if (key.isErr()) return sendError(request, reply, key.error);
      return sendItem(request, reply, await getElectionEvent(deps, key.value), 'event');
    });

    fastify.get('/contests', async (request, reply) => {
      const decoded = decode(request.query, 'contests');
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const occurrenceKey = requiredKey(decoded.value, 'occurrenceKey');
      if (occurrenceKey.isErr()) return sendError(request, reply, occurrenceKey.error);
      const filter = filterOf(electionContestsFilterSpec, decoded.value, 'election contest');
      if (filter.isErr()) return sendError(request, reply, filter.error);
      const result = await listElectionContests(deps, {
        occurrenceKey: occurrenceKey.value,
        filter: filter.value,
        ...pageOf(decoded.value),
      });
      return sendPage(request, reply, result, 'contests');
    });

    fastify.get('/contests/lookup', async (request, reply) => {
      const key = decode(request.query, 'contest').andThen((decoded) =>
        requiredKey(decoded, 'contestKey')
      );
      if (key.isErr()) return sendError(request, reply, key.error);
      return sendItem(request, reply, await getElectionContest(deps, key.value), 'contest');
    });

    fastify.get('/results/lookup', async (request, reply) => {
      const decoded = decode(request.query, 'result');
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const keys = requiredKey(decoded.value, 'occurrenceKey').andThen((occurrenceKey) =>
        requiredKey(decoded.value, 'office').andThen((office) =>
          requiredKey(decoded.value, 'scopeKey').map((scopeKey) => ({
            occurrenceKey,
            office,
            scopeKey,
          }))
        )
      );
      if (keys.isErr()) return sendError(request, reply, keys.error);
      const result = await getElectionResult(deps, {
        ...keys.value,
        contestKey: optionalKey(decoded.value, 'contestKey'),
      });
      return sendItem(request, reply, result, 'result');
    });

    fastify.get('/results', async (request, reply) => {
      const decoded = decode(request.query, 'results');
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const keys = requiredKey(decoded.value, 'occurrenceKey').andThen((occurrenceKey) =>
        requiredKey(decoded.value, 'office').andThen((office) =>
          requiredKey(decoded.value, 'scopeType').map((scopeType) => ({
            occurrenceKey,
            office,
            scopeType,
          }))
        )
      );
      if (keys.isErr()) return sendError(request, reply, keys.error);
      const result = await listElectionResultScopes(deps, {
        occurrenceKey: keys.value.occurrenceKey,
        office: keys.value.office,
        // The usecase refuses a value outside the place types.
        scopeType: keys.value.scopeType as ElectionPlaceType,
        contestKey: optionalKey(decoded.value, 'contestKey'),
        ...pageOf(decoded.value),
      });
      return sendPage(request, reply, result, 'places');
    });

    fastify.get('/competitors', async (request, reply) => {
      const decoded = decode(request.query, 'competitors');
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const eventKey = requiredKey(decoded.value, 'eventKey');
      if (eventKey.isErr()) return sendError(request, reply, eventKey.error);
      const filter = filterOf(electionCompetitorsFilterSpec, decoded.value, 'election competitor');
      if (filter.isErr()) return sendError(request, reply, filter.error);
      const result = await listElectionCompetitors(deps, {
        eventKey: eventKey.value,
        filter: filter.value,
        ...pageOf(decoded.value),
      });
      return sendPage(request, reply, result, 'competitors');
    });
  };
