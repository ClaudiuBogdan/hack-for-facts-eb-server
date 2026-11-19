/**
 * Direct acquisitions, release 1 — REST under `/api/v1/procurement/da`, over
 * the SAME usecases GraphQL and MCP call (no SQL or rule of its own).
 *
 *   GET /status             { enabled, dataAsOf }
 *   GET /purchases          filter params, sort, page, pageSize
 *   GET /purchases/lookup   purchaseId
 *   GET /totals             filter params, groupBy, page, pageSize
 *
 * Filter params: buyerFiscalCode, supplierFiscalCode, cpvDivision,
 * finalizationFrom, finalizationTo, outcomes (repeatable), counted
 * (true|false), code, nativeId. Unknown or repeated scalar parameters are
 * refused. Envelopes: `{ ok:true, data, meta?, requestId }` and
 * `{ ok:false, error, message, field?, resource?, requestId }`; a 5xx carries a
 * fixed message. With the release disabled every data route answers 503
 * ServiceUnavailable. `Cache-Control: no-store`.
 */

import { err, ok, type Result } from 'neverthrow';

import { httpStatusFor, invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  daPurchaseTotals,
  daReleaseStatus,
  getDaPurchase,
  listDaPurchases,
  type DaReleaseDeps,
} from '../../core/da-release-usecases.js';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const INTERNAL_MESSAGE = 'direct acquisitions read failed; quote the requestId to report it';

type ParamKind = 'string' | 'stringList' | 'int' | 'boolean';
type Decoded = Readonly<Record<string, string | number | boolean | readonly string[]>>;

const FILTER_PARAMS: Readonly<Record<string, ParamKind>> = {
  buyerFiscalCode: 'string',
  supplierFiscalCode: 'string',
  cpvDivision: 'string',
  finalizationFrom: 'string',
  finalizationTo: 'string',
  outcomes: 'stringList',
  counted: 'boolean',
  code: 'string',
  nativeId: 'string',
};
const PAGE_PARAMS: Readonly<Record<string, ParamKind>> = { page: 'int', pageSize: 'int' };

const PARAMS = {
  status: {},
  purchases: { ...FILTER_PARAMS, sort: 'string', ...PAGE_PARAMS },
  purchase: { purchaseId: 'string' },
  totals: { ...FILTER_PARAMS, groupBy: 'string', ...PAGE_PARAMS },
} satisfies Record<string, Readonly<Record<string, ParamKind>>>;

const INT_TEXT = /^(?:0|[1-9][0-9]{0,8})$/u;

/** Decode the parsed query against its table; an unknown parameter is refused, never echoed. */
const decode = (
  raw: unknown,
  table: Readonly<Record<string, ParamKind>>
): Result<Decoded, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw))
    return err(invalidInput('malformed query string', 'query'));
  const out: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(table, key) ? table[key] : undefined;
    if (kind === undefined) return err(invalidInput('unsupported query parameter', 'query'));
    const texts: unknown[] = Array.isArray(value) ? value : [value];
    if (!texts.every((text): text is string => typeof text === 'string'))
      return err(invalidInput(`malformed ${key}`, key));
    if (kind === 'stringList') {
      out[key] = texts;
      continue;
    }
    if (texts.length !== 1) return err(invalidInput(`${key} may appear only once`, key));
    const text = texts[0] ?? '';
    if (kind === 'string') out[key] = text;
    else if (kind === 'int') {
      if (!INT_TEXT.test(text)) return err(invalidInput(`${key} must be an integer`, key));
      out[key] = Number(text);
    } else {
      if (text !== 'true' && text !== 'false')
        return err(invalidInput(`${key} must be true or false`, key));
      out[key] = text === 'true';
    }
  }
  return ok(out);
};

const filterOf = (decoded: Decoded): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(FILTER_PARAMS)
      .filter((key) => decoded[key] !== undefined)
      .map((key) => [key, decoded[key]])
  );

const pageOf = (decoded: Decoded) => ({
  page: typeof decoded['page'] === 'number' ? decoded['page'] : 1,
  pageSize: typeof decoded['pageSize'] === 'number' ? decoded['pageSize'] : 20,
});

export const makeDaReleaseRestPlugin =
  (deps: DaReleaseDeps): FastifyPluginAsync =>
  (fastify) => {
    fastify.addHook('onSend', async (_request, reply, payload) => {
      void reply.header('cache-control', 'no-store');
      return payload;
    });

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
      request.log.error({ err: error }, '[procurement-da] REST route failed');
      return reply.status(500).send({
        ok: false as const,
        error: 'Database',
        message: INTERNAL_MESSAGE,
        requestId: request.id,
      });
    });

    const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
      const status = httpStatusFor(error);
      if (status >= 500 && status !== 503) {
        request.log.error({ err: error }, '[procurement-da] REST read failed');
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

    fastify.get('/status', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.status);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      return reply
        .status(200)
        .send({ ok: true as const, data: await daReleaseStatus(deps), requestId: request.id });
    });

    fastify.get('/purchases', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.purchases);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await listDaPurchases(deps, {
        sort: typeof decoded.value['sort'] === 'string' ? decoded.value['sort'] : null,
        filter: filterOf(decoded.value),
        ...pageOf(decoded.value),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      const {
        items,
        page,
        pageSize,
        total,
        totalCapped,
        hasMore,
        dataAsOf,
        countedValueBasis,
        disclosureKey,
      } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data: items,
        meta: {
          page: { page, pageSize, total },
          totalCapped,
          hasMore,
          dataAsOf,
          countedValueBasis,
          disclosureKey,
        },
        requestId: request.id,
      });
    });

    fastify.get('/purchases/lookup', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.purchase);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const purchaseId = decoded.value['purchaseId'];
      if (typeof purchaseId !== 'string')
        return sendError(request, reply, invalidInput('purchaseId is required', 'purchaseId'));
      const result = await getDaPurchase(deps, purchaseId);
      if (result.isErr()) return sendError(request, reply, result.error);
      const { dataAsOf, countedValueBasis, disclosureKey, ...data } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data,
        meta: { dataAsOf, countedValueBasis, disclosureKey },
        requestId: request.id,
      });
    });

    fastify.get('/totals', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.totals);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const groupBy = decoded.value['groupBy'];
      const result = await daPurchaseTotals(deps, {
        filter: filterOf(decoded.value),
        groupBy: typeof groupBy === 'string' ? groupBy : null,
        ...pageOf(decoded.value),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      const {
        dataAsOf,
        countedValueBasis,
        disclosureKey,
        page,
        pageSize,
        groupCount,
        hasMore,
        ...data
      } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data,
        meta: {
          page: { page, pageSize, total: groupCount },
          hasMore,
          dataAsOf,
          countedValueBasis,
          disclosureKey,
        },
        requestId: request.id,
      });
    });
    return Promise.resolve();
  };
