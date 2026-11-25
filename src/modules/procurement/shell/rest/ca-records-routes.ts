/**
 * Contract awards (PROC-KB0Z step 1): REST under
 * `/api/v1/procurement/contract-awards`, over the SAME usecases GraphQL calls.
 *
 *   GET /buyer-summary    buyerFiscalCode, from, to
 *   GET /records          buyerFiscalCode, from, to, sort, page, pageSize
 *   GET /winner-summary   winnerFiscalCode, from, to
 *   GET /winner-records   winnerFiscalCode, from, to, sort, page, pageSize
 *   GET /records/lookup   recordId
 *
 * A winner code not shown, or neither in the D6 gate nor registry-named, is 404
 * with resource `contractAwardWinner`, the same whether or not it won anything.
 *
 * Unknown or repeated parameters are refused. Envelopes as the DA release:
 * `{ ok:true, data, meta, requestId }` and `{ ok:false, error, message, field?,
 * resource?, requestId }`; a 5xx carries a fixed message. A record before the
 * floor is 404 with resource `contractAwardOutsideWindow`. Disabled: 503 on
 * every route. `Cache-Control: no-store`.
 */

import {
  httpStatusFor,
  invalidInput,
  retryAfterSecondsOf,
  type ApiError,
} from '@/modules/shared/index.js';

import { decode, type Decoded, type ParamKind } from './da-release-routes.js';
import {
  caBuyerSummary,
  caWinnerSummary,
  getCaRecord,
  listCaBuyerRecords,
  listCaWinnerRecords,
  type CaRecordPage,
  type CaRecordsDeps,
} from '../../core/ca-records-usecases.js';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const INTERNAL_MESSAGE = 'contract awards read failed; quote the requestId to report it';

const WINDOW_PARAMS: Readonly<Record<string, ParamKind>> = {
  buyerFiscalCode: 'string',
  from: 'string',
  to: 'string',
};

const WINNER_WINDOW_PARAMS: Readonly<Record<string, ParamKind>> = {
  winnerFiscalCode: 'string',
  from: 'string',
  to: 'string',
};

const PAGE_PARAMS: Readonly<Record<string, ParamKind>> = {
  sort: 'string',
  page: 'int',
  pageSize: 'int',
};

const PARAMS = {
  summary: WINDOW_PARAMS,
  records: { ...WINDOW_PARAMS, ...PAGE_PARAMS },
  winnerSummary: WINNER_WINDOW_PARAMS,
  winnerRecords: { ...WINNER_WINDOW_PARAMS, ...PAGE_PARAMS },
  record: { recordId: 'string' },
} satisfies Record<string, Readonly<Record<string, ParamKind>>>;

const text = (decoded: Decoded, key: string): string | null => {
  const value = decoded[key];
  return typeof value === 'string' ? value : null;
};

const int = (decoded: Decoded, key: string, fallback: number): number => {
  const value = decoded[key];
  return typeof value === 'number' ? value : fallback;
};

export const makeCaRecordsRestPlugin =
  (deps: CaRecordsDeps): FastifyPluginAsync =>
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
      request.log.error({ err: error }, '[procurement-ca] REST route failed');
      return reply.status(500).send({
        ok: false as const,
        error: 'Database',
        message: INTERNAL_MESSAGE,
        requestId: request.id,
      });
    });

    const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
      const status = httpStatusFor(error);
      const retryAfter = retryAfterSecondsOf(error);
      if (retryAfter !== undefined) void reply.header('retry-after', String(retryAfter));
      if (status >= 500 && status !== 503) {
        request.log.error({ err: error }, '[procurement-ca] REST read failed');
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

    fastify.get('/buyer-summary', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.summary);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await caBuyerSummary(deps, {
        buyerFiscalCode: text(decoded.value, 'buyerFiscalCode'),
        from: text(decoded.value, 'from'),
        to: text(decoded.value, 'to'),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      const { dataAsOf, disclosureKey, window, ...data } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data,
        meta: { dataAsOf, disclosureKey, window },
        requestId: request.id,
      });
    });

    const sendPage = (request: FastifyRequest, reply: FastifyReply, result: CaRecordPage) => {
      const {
        items,
        page,
        pageSize,
        total,
        hasMore,
        depthLimited,
        dataAsOf,
        disclosureKey,
        window,
      } = result;
      return reply.status(200).send({
        ok: true as const,
        data: items,
        meta: {
          page: { page, pageSize, total },
          hasMore,
          depthLimited,
          dataAsOf,
          disclosureKey,
          window,
        },
        requestId: request.id,
      });
    };

    fastify.get('/records', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.records);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await listCaBuyerRecords(deps, {
        buyerFiscalCode: text(decoded.value, 'buyerFiscalCode'),
        from: text(decoded.value, 'from'),
        to: text(decoded.value, 'to'),
        sort: text(decoded.value, 'sort'),
        page: int(decoded.value, 'page', 1),
        pageSize: int(decoded.value, 'pageSize', 20),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      return sendPage(request, reply, result.value);
    });

    fastify.get('/winner-summary', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.winnerSummary);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await caWinnerSummary(deps, {
        winnerFiscalCode: text(decoded.value, 'winnerFiscalCode'),
        from: text(decoded.value, 'from'),
        to: text(decoded.value, 'to'),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      const { dataAsOf, disclosureKey, window, ...data } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data,
        meta: { dataAsOf, disclosureKey, window },
        requestId: request.id,
      });
    });

    fastify.get('/winner-records', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.winnerRecords);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const result = await listCaWinnerRecords(deps, {
        winnerFiscalCode: text(decoded.value, 'winnerFiscalCode'),
        from: text(decoded.value, 'from'),
        to: text(decoded.value, 'to'),
        sort: text(decoded.value, 'sort'),
        page: int(decoded.value, 'page', 1),
        pageSize: int(decoded.value, 'pageSize', 20),
      });
      if (result.isErr()) return sendError(request, reply, result.error);
      return sendPage(request, reply, result.value);
    });

    fastify.get('/records/lookup', async (request, reply) => {
      const decoded = decode(request.query, PARAMS.record);
      if (decoded.isErr()) return sendError(request, reply, decoded.error);
      const recordId = text(decoded.value, 'recordId');
      if (recordId === null)
        return sendError(request, reply, invalidInput('recordId is required', 'recordId'));
      const result = await getCaRecord(deps, recordId);
      if (result.isErr()) return sendError(request, reply, result.error);
      const { dataAsOf, disclosureKey, reanchored, ...data } = result.value;
      return reply.status(200).send({
        ok: true as const,
        data,
        meta: { dataAsOf, disclosureKey, reanchored },
        requestId: request.id,
      });
    });
    return Promise.resolve();
  };
