/**
 * Legal module — the CACHEABLE TLDF render routes.
 *
 *   GET /api/v1/legal/documents/:documentId/render
 *   GET /api/v1/legal/documents/:documentId/render/chunks/:chunkIndex
 *
 * WHY REST (parliament-transcript precedent): a rendered act is large,
 * immutable per generation, and fetched by non-GraphQL callers (the SSR
 * loader, a citation link, a crawler). Those want `ETag` / `If-None-Match` /
 * `Cache-Control`, which a POSTed GraphQL query cannot express. GraphQL
 * carries only the AVAILABILITY (`LegalDocument.render`); the body travels
 * here.
 *
 * ONE RESPONSE = ONE HONEST UNIT. The base route returns the complete logical
 * artifact for a single-chunk document, or the physical MANIFEST for a
 * chunked one — never a partial `blocks[]` that could pass for the whole
 * document, and no `?full=1` escape hatch. Chunk groups are fetched one at a
 * time by index; the manifest declares the extent up front.
 *
 * GENERATION-IDENTITY ETag — deliberately NOT a payload hash. The tag is
 * `W/"<run_id>-<text_sha256[:16]>-<compiler_version>"`, read from
 * `document_generations`: the generation row and the payload rows are bound
 * structurally (composite FK + jsonb CHECKs) and replaced in one transaction,
 * so the identity IS a validator for the bytes — hashing multi-MB payloads
 * per request would buy nothing. Weak (`W/`) because the same generation may
 * serialize with byte-level differences across encodings/serializer versions
 * while remaining semantically identical. The tag is shared by the base and
 * every chunk of one generation; that is sound because an ETag is scoped to
 * its URL.
 *
 * TYPED ERRORS. Module-local render errors map here (the kernel HTTP_STATUS
 * has no 403/409 variants): RENDER_RESTRICTED → 403, RENDER_UNAVAILABLE /
 * RENDER_INCONSISTENT → 409, render_not_found → 404; kernel `ApiError`s keep
 * their shared mapping. 4xx responses are cacheable trouble too — they carry
 * `Cache-Control: no-store` so a transient inconsistency is never pinned in a
 * shared cache.
 */

import { httpStatusFor, type ApiError } from '@/modules/shared/index.js';

import {
  RenderChunkParamsSchema,
  RenderErrorSchema,
  RenderParamsSchema,
  RenderQuerySchema,
  RenderResponseSchema,
  type RenderChunkParams,
  type RenderParams,
  type RenderQuery,
} from './schemas.js';
import { getDocumentRenderChunk } from '../../core/usecases.js';

import type { LegalRenderRepo } from '../../core/ports.js';
import type { LegalRenderError, LegalRenderInfo, LegalRenderPayload } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export interface MakeLegalRoutesDeps {
  readonly render: LegalRenderRepo;
  /**
   * Browser TTL for a served artifact. A generation is immutable — recompiles
   * mint a NEW generation identity, which changes the ETag — so the browser
   * TTL is a modest staleness window and the shared-cache TTL (`s-maxage`)
   * can be a day; `stale-while-revalidate` keeps reads instant across it.
   */
  readonly renderCacheTtlSeconds?: number;
}

const DEFAULT_RENDER_TTL_SECONDS = 600;
const SHARED_CACHE_TTL_SECONDS = 86_400;

/** `W/"<run_id>-<text_sha256[:16]>-<compiler_version>"` — generation identity. */
export const legalRenderEtag = (info: LegalRenderInfo): string =>
  `W/"${info.runId}-${info.textSha256.slice(0, 16)}-${info.compilerVersion}"`;

/**
 * RFC 9110 `If-None-Match`: a comma-separated list of entity tags, or `*`.
 * Weak comparison for a GET — the `W/` prefix is stripped on both sides.
 */
export const ifNoneMatchSatisfied = (header: string | undefined, etag: string): boolean => {
  if (header === undefined || header.trim() === '') return false;
  if (header.trim() === '*') return true;
  const normalize = (tag: string): string => tag.trim().replace(/^W\//u, '');
  return header.split(',').some((candidate) => normalize(candidate) === normalize(etag));
};

const isRenderError = (e: LegalRenderError | ApiError): e is LegalRenderError => 'reason' in e;

const RENDER_ERROR_HTTP: Record<LegalRenderError['reason'], { status: number; code: string }> = {
  render_not_found: { status: 404, code: 'NOT_FOUND' },
  render_restricted: { status: 403, code: 'RENDER_RESTRICTED' },
  render_unavailable: { status: 409, code: 'RENDER_UNAVAILABLE' },
  render_inconsistent: { status: 409, code: 'RENDER_INCONSISTENT' },
};

const renderErrorMessage = (error: LegalRenderError): string => {
  switch (error.reason) {
    case 'render_not_found':
      return `no served render for document ${error.documentId}`;
    case 'render_restricted':
      return `document ${error.documentId} text is restricted; its metadata remains public`;
    case 'render_unavailable':
      return `document ${error.documentId} has no servable text (${error.renderStatus})`;
    case 'render_inconsistent':
      return `document ${error.documentId} render rows are inconsistent; refusing a partial reading`;
  }
};

export const makeLegalRoutes = (deps: MakeLegalRoutesDeps): FastifyPluginAsync => {
  const ttl = deps.renderCacheTtlSeconds ?? DEFAULT_RENDER_TTL_SECONDS;
  const cacheControl = `public, max-age=${String(ttl)}, s-maxage=${String(SHARED_CACHE_TTL_SECONDS)}, stale-while-revalidate=${String(SHARED_CACHE_TTL_SECONDS)}`;

  const setCacheHeaders = (reply: FastifyReply, etag: string): void => {
    void reply.header('etag', etag);
    void reply.header('cache-control', cacheControl);
    void reply.header('vary', 'accept-encoding');
  };

  return async (fastify) => {
    // Boundary rejections (bad chunk index, unknown query param) come from
    // Fastify's validator, whose default body does not match the module
    // envelope — without this handler a clean 400 would 500 on response
    // serialization. Encapsulated to this plugin scope.
    fastify.setErrorHandler((error, request, reply) => {
      const fault = error as { validation?: unknown; statusCode?: number; message?: string };
      const message = fault.message ?? 'request failed';
      if (fault.validation !== undefined) {
        return reply.status(400).send({
          ok: false as const,
          error: 'INVALID_INPUT',
          message,
          meta: { requestId: request.id },
        });
      }
      request.log.error({ err: error }, '[legal] render route failed');
      const status = typeof fault.statusCode === 'number' ? fault.statusCode : 500;
      return reply.status(status).send({
        ok: false as const,
        error: status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_INPUT',
        message,
        meta: { requestId: request.id },
      });
    });

    const respond = (
      request: FastifyRequest,
      reply: FastifyReply,
      outcome: Awaited<ReturnType<typeof getDocumentRenderChunk>>
    ): unknown => {
      if (outcome.isErr()) {
        const error = outcome.error;
        // Errors are trouble, not content: never let a shared cache pin one.
        void reply.header('cache-control', 'no-store');
        if (isRenderError(error)) {
          const { status, code } = RENDER_ERROR_HTTP[error.reason];
          return reply.status(status).send({
            ok: false as const,
            error: code,
            message: renderErrorMessage(error),
            ...(error.reason === 'render_unavailable' && { renderStatus: error.renderStatus }),
            ...(error.reason === 'render_inconsistent' && { detail: error.detail }),
            meta: { requestId: request.id },
          });
        }
        const status = httpStatusFor(error);
        if (status >= 500) request.log.error({ err: error }, '[legal] render read failed');
        return reply.status(status).send({
          ok: false as const,
          error: error.type,
          message: error.message,
          meta: { requestId: request.id },
        });
      }

      const payload: LegalRenderPayload = outcome.value;
      const etag = legalRenderEtag(payload.info);
      setCacheHeaders(reply, etag);
      if (ifNoneMatchSatisfied(request.headers['if-none-match'], etag)) {
        return reply.status(304).send();
      }
      return reply.status(200).send({
        ok: true as const,
        data: {
          documentId: payload.info.documentId,
          kind: payload.kind,
          chunkIndex: payload.chunkIndex,
          chunkCount: payload.info.chunkCount ?? 1,
          tldf: payload.tldf,
        },
        meta: {
          requestId: request.id,
          runId: payload.info.runId,
          textSha256: payload.info.textSha256,
          compilerVersion: payload.info.compilerVersion,
          compiledAt: payload.info.compiledAt,
        },
      });
    };

    const responseSchemas = {
      200: RenderResponseSchema,
      400: RenderErrorSchema,
      403: RenderErrorSchema,
      404: RenderErrorSchema,
      409: RenderErrorSchema,
      500: RenderErrorSchema,
    };

    fastify.get<{ Params: RenderParams; Querystring: RenderQuery }>(
      '/documents/:documentId/render',
      {
        // PUBLIC data route: the usecase serves only `render_status='served'`
        // AND `privacy_class='public'` expressions; restricted text answers
        // 403 in the usecase, never here.
        schema: {
          params: RenderParamsSchema,
          querystring: RenderQuerySchema,
          response: responseSchemas,
        },
      },
      async (request, reply) => {
        const outcome = await getDocumentRenderChunk(deps.render, request.params.documentId, 0);
        return respond(request, reply, outcome);
      }
    );

    fastify.get<{ Params: RenderChunkParams; Querystring: RenderQuery }>(
      '/documents/:documentId/render/chunks/:chunkIndex',
      {
        schema: {
          params: RenderChunkParamsSchema,
          querystring: RenderQuerySchema,
          response: responseSchemas,
        },
      },
      async (request, reply) => {
        const outcome = await getDocumentRenderChunk(
          deps.render,
          request.params.documentId,
          request.params.chunkIndex
        );
        return respond(request, reply, outcome);
      }
    );
  };
};
