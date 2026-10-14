/**
 * Elections REST: the GET metadata reads under `/api/v1/elections`, over the
 * SAME usecases GraphQL and MCP call (no SQL, projection or rule of its own).
 *
 *   GET /editions          reportedYears, reportedFamilies, eventKeys, page, pageSize
 *   GET /editions/lookup   electionKey
 *   GET /contests          electionKey (required), reportedOffices, scopeTypes, reportedRounds, page, pageSize
 *   GET /contests/lookup   contestKey
 *
 * Keys travel as query parameters, never path segments: they are opaque source
 * keys of up to 512 characters and the standalone router caps a path parameter
 * at 100. A repeated filter parameter is a list (no CSV splitting) and becomes
 * that spec field's `in`, so all three surfaces validate one FilterInput. The
 * query is decoded from Fastify's parsed object before any coercion: unknown
 * or repeated scalar parameters are refused.
 *
 * Envelopes (foundation §5.2/§14.11): `{ ok:true, data, meta?, requestId }` and
 * `{ ok:false, error, message, field?, resource?, requestId }`; a 5xx carries a
 * fixed message, and a framework 4xx (an inherited 429) keeps its status and
 * headers. An absent and a non-public edition or contest answer the same
 * 404. Every reply is `Cache-Control: no-store` (no freshness contract yet).
 */

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

import { electionCatalogFilterSpec, electionContestsFilterSpec } from '../../core/filters.js';
import {
  getElectionContest,
  getElectionEdition,
  listElectionContests,
  listElectionEditions,
  type ElectionsDeps,
} from '../../core/usecases.js';

import type { ElectionPage } from '../../core/types.js';
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
  editions: { ...filterParams(electionCatalogFilterSpec), ...PAGE_PARAMS },
  edition: { electionKey: 'string' },
  contests: { electionKey: 'string', ...filterParams(electionContestsFilterSpec), ...PAGE_PARAMS },
  contest: { contestKey: 'string' },
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

    fastify.get('/editions', async (request, reply) => {
      const decoded = decodeQuery(request.query, PARAMS.editions);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const filter = filterOf(electionCatalogFilterSpec, decoded.value, 'election catalog');
      if (filter.isErr()) return sendError(request, reply, filter.error);
      const result = await listElectionEditions(deps, {
        filter: filter.value,
        ...pageOf(decoded.value),
      });
      return sendPage(request, reply, result, 'source_editions');
    });

    fastify.get('/editions/lookup', async (request, reply) => {
      const key = decodeQuery(request.query, PARAMS.edition).andThen((decoded) =>
        requiredKey(decoded, 'electionKey')
      );
      if (key.isErr()) return sendError(request, reply, key.error);
      return sendItem(request, reply, await getElectionEdition(deps, key.value), 'edition');
    });

    fastify.get('/contests', async (request, reply) => {
      const decoded = decodeQuery(request.query, PARAMS.contests);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const electionKey = requiredKey(decoded.value, 'electionKey');
      if (electionKey.isErr()) return sendError(request, reply, electionKey.error);
      const filter = filterOf(electionContestsFilterSpec, decoded.value, 'election contest');
      if (filter.isErr()) return sendError(request, reply, filter.error);
      const result = await listElectionContests(deps, {
        electionKey: electionKey.value,
        filter: filter.value,
        ...pageOf(decoded.value),
      });
      return sendPage(request, reply, result, 'source_contests');
    });

    fastify.get('/contests/lookup', async (request, reply) => {
      const key = decodeQuery(request.query, PARAMS.contest).andThen((decoded) =>
        requiredKey(decoded, 'contestKey')
      );
      if (key.isErr()) return sendError(request, reply, key.error);
      return sendItem(request, reply, await getElectionContest(deps, key.value), 'contest');
    });
  };
