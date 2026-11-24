/**
 * Legislation analytics REST (design §11): the page's cacheable reads.
 *
 *   GET /api/v1/legal/analytics/:view    view = head | summary | breakdown | series | grid | links | acts
 *
 * Filters, the same on every view: population (flow|stock), from, to, type
 * (repeatable), issuer (a lineage), family, felul (a group, a kind,
 * `uncertain` or `unplaced`), versions (0-3). Per view: lens and limit
 * (breakdown), lens and top (series), lens and by (grid), order, limit and
 * cursor (acts). A repeated parameter is a list only for `type`; an unknown
 * or misplaced parameter is refused (400), never ignored. The same usecase
 * answers GraphQL `legalAnalytics` and MCP `query_legal_analytics`.
 *
 * Caching. The validator is the layer id and the canonical arguments:
 * `W/"legal-analytics-<layer>-<sha256(key)[:20]>"`, known before any view
 * statement runs, so `If-None-Match` is answered with 304 from the head
 * alone. A layer is immutable once published, so a validated answer stays
 * true for its layer; the URL carries no layer, so the shared-cache window is
 * short and a new layer is picked up within it. Errors are `no-store`. The
 * views that name acts (acts, links) are read afresh every time: `no-store`,
 * no validator, never 304. A busy refusal (503) carries Retry-After.
 */

import { createHash } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import { httpStatusFor, invalidInput, type ApiError } from '@/modules/shared/index.js';

import { ifNoneMatchSatisfied } from './routes.js';
import {
  ANALYTICS_BUSY,
  answerLegalAnalytics,
  NAMING_VIEWS,
  prepareLegalAnalytics,
  type LegalAnalyticsDeps,
} from '../../core/analytics/usecases.js';

import type { LegalAnalyticsArgs } from '../../core/analytics/types.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/** Browser freshness, then the shared-cache window (how long a new layer may wait behind a proxy). */
export const LEGAL_ANALYTICS_MAX_AGE_SECONDS = 300;
export const LEGAL_ANALYTICS_SHARED_MAX_AGE_SECONDS = 300;
const STALE_WHILE_REVALIDATE_SECONDS = 60;
const CACHE_CONTROL = `public, max-age=${String(LEGAL_ANALYTICS_MAX_AGE_SECONDS)}, s-maxage=${String(LEGAL_ANALYTICS_SHARED_MAX_AGE_SECONDS)}, stale-while-revalidate=${String(STALE_WHILE_REVALIDATE_SECONDS)}`;
const INTERNAL_MESSAGE = 'legislation analytics read failed; quote the requestId to report it';

type Kind = 'int' | 'string' | 'stringList';
const PARAMS: Readonly<Record<keyof LegalAnalyticsArgs, Kind>> = {
  population: 'string',
  from: 'int',
  to: 'int',
  type: 'stringList',
  issuer: 'string',
  family: 'string',
  felul: 'string',
  versions: 'int',
  lens: 'string',
  by: 'string',
  limit: 'int',
  top: 'int',
  order: 'string',
  cursor: 'string',
};
const INT_TEXT = /^-?(?:0|[1-9][0-9]{0,8})$/u;
const MAX_VALUES = 25;

/** Decode Fastify's parsed query into the usecase's arguments; an unknown parameter is refused. */
export const decodeAnalyticsQuery = (raw: unknown): Result<LegalAnalyticsArgs, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  if (typeof raw !== 'object' || Array.isArray(raw))
    return err(invalidInput('malformed query string', 'query'));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(PARAMS, key) ? PARAMS[key as keyof LegalAnalyticsArgs] : undefined;
    if (kind === undefined) return err(invalidInput('unsupported query parameter', 'query'));
    const texts: unknown[] = Array.isArray(value) ? value : [value];
    if (!texts.every((t): t is string => typeof t === 'string') || texts.length > MAX_VALUES)
      return err(invalidInput(`malformed ${key}`, key));
    if (kind === 'stringList') {
      out[key] = texts;
      continue;
    }
    if (texts.length !== 1) return err(invalidInput(`${key} may appear only once`, key));
    const text = texts[0] ?? '';
    if (kind === 'string') {
      out[key] = text;
      continue;
    }
    if (!INT_TEXT.test(text)) return err(invalidInput(`${key} must be an integer`, key));
    out[key] = Number(text);
  }
  return ok(out as LegalAnalyticsArgs);
};

/** The validator of an answer: its layer id and canonical arguments. */
export const legalAnalyticsEtag = (layerId: string, cacheKey: string): string =>
  `W/"legal-analytics-${layerId}-${createHash('sha256').update(cacheKey).digest('hex').slice(0, 20)}"`;

export const makeLegalAnalyticsRoutes =
  (deps: LegalAnalyticsDeps): FastifyPluginAsync =>
  (fastify) => {
    // Every error reply of this scope, the framework's own included (a 429, an unhandled 500): never stored, no
    // validator.
    fastify.addHook('onSend', (_request, reply, payload, done) => {
      if (reply.statusCode >= 400) {
        void reply.header('cache-control', 'no-store');
        reply.removeHeader('etag');
      }
      done(null, payload);
    });

    const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
      const status = httpStatusFor(error);
      void reply.header('cache-control', 'no-store');
      if (error.type === 'ServiceUnavailable' && error.message === ANALYTICS_BUSY)
        void reply.header('retry-after', '2');
      if (status >= 500 && error.type !== 'ServiceUnavailable' && error.type !== 'Timeout') {
        request.log.error({ err: error }, '[legal-analytics] REST read failed');
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
        ...('field' in error && { field: error.field }),
        requestId: request.id,
      });
    };

    fastify.get<{ Params: { view: string } }>('/:view', async (request, reply) => {
      const args = decodeAnalyticsQuery(request.query);
      if (args.isErr()) return sendError(request, reply, args.error);
      const prepared = await prepareLegalAnalytics(deps, request.params.view, args.value);
      if (prepared.isErr()) return sendError(request, reply, prepared.error);
      // Views that name acts are read afresh every time (the privacy gate is read in the view's own
      // transaction): no-store, no validator, never 304.
      const names = NAMING_VIEWS.has(request.params.view);
      const early = legalAnalyticsEtag(prepared.value.head.layer.layerId, prepared.value.cacheKey);
      if (!names && ifNoneMatchSatisfied(request.headers['if-none-match'], early)) {
        return reply
          .status(304)
          .header('etag', early)
          .header('cache-control', CACHE_CONTROL)
          .send();
      }
      const answer = await answerLegalAnalytics(
        deps,
        prepared.value,
        request.params.view,
        args.value
      );
      if (answer.isErr()) return sendError(request, reply, answer.error);
      const body = {
        ok: true as const,
        data: answer.value.data,
        meta: { view: answer.value.view, layer: answer.value.layer, args: answer.value.args },
      };
      if (names) return reply.status(200).header('cache-control', 'no-store').send(body);
      // A retried answer (a newer layer appeared meanwhile) carries its own validator.
      return reply
        .status(200)
        .header('etag', legalAnalyticsEtag(answer.value.layer.layerId, answer.value.cacheKey))
        .header('cache-control', CACHE_CONTROL)
        .send(body);
    });
    return Promise.resolve();
  };
