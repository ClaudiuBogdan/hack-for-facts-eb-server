/**
 * Parliament module — the CACHEABLE full-transcript REST route.
 *
 *   GET /api/v1/parliament/stenograms/:sessionKey/transcript
 *
 * WHY REST AT ALL. A full sitting transcript is the one parliament payload that is
 * large, immutable in practice, and fetched by things that are not GraphQL clients
 * (an SSR loader, a citation link, a crawler, a reader view). Those want HTTP
 * caching semantics — `ETag` / `If-None-Match` / `Cache-Control` — which a POSTed
 * GraphQL query cannot express.
 *
 * IT IS THE SAME ANSWER, NOT A SECOND ONE. The handler calls
 * `getParliamentStenogramSession` — the very usecase the GraphQL root and the MCP
 * read tool call — so the session and the ordered blocks are identical across the
 * three surfaces, and the module/core boundary is not bypassed: this file never
 * touches the repo, the Kysely instance, or `parliament.*`.
 *
 * ONE RESPONSE = ONE WHOLE TRANSCRIPT. The endpoint takes no pagination: the usecase
 * pages the repository internally (`STENOGRAM_TRANSCRIPT_CHUNK` blocks per query) and
 * refuses — with an error, never a truncation — if it cannot assemble the complete
 * reading. Offering `offset`/`limit` here would mean the obvious call returned a first
 * page that looked exactly like the whole sitting. A caller that genuinely wants a
 * slice uses the GraphQL `parliamentStenogramSession(offset:, limit:)` root.
 *
 * DETERMINISTIC ETag. The tag is a SHA-256 over a canonical serialization of the
 * response *data* (a fixed field order, built by `canonicalTranscriptPayload`), so:
 *  - two processes / two replicas produce the SAME tag for the same rows (no
 *    per-process salt, no timestamp, no `Date.now()`, no request id in the hash);
 *  - a change to any served field — a re-parse that alters a block, a privacy flip
 *    that removes one, a new neighbouring sitting — changes the tag;
 *  - `meta.requestId` is deliberately EXCLUDED from the hash: it differs per request
 *    and would make every response a cache miss.
 * There is exactly one representation per sitting now, so the tag is a function of the
 * sitting's served content alone.
 *
 * COMPRESSION. Real compression is registered app-wide (`@fastify/compress` in
 * `registerRedesignSurface`), which is the right layer: it is an `onSend` transform
 * that applies to every JSON response, negotiates `Accept-Encoding`, and leaves the
 * ETag a representation-level validator valid for every encoding. This route therefore
 * returns a plain serializable object and never writes a pre-compressed buffer or a
 * manual `Content-Encoding` — hand-rolling gzip here would fight that layer and break
 * the 304 path. `Vary: Accept-Encoding` is still set explicitly so a cache in front of
 * the app keys correctly even if the compressor is ever disabled.
 *
 * TYPED ERRORS, PRESERVED. `NOT_FOUND` (404) vs `TRANSCRIPT_UNAVAILABLE` (409 for a
 * SOURCE_ONLY / no-public-block sitting, 503 when the canonical projection is not
 * deployed) vs `SEARCH_UNAVAILABLE` (503) vs the kernel codes all come from the
 * module's single error mapper, so REST, GraphQL and MCP report the same fact with
 * the same name.
 */

import { createHash } from 'node:crypto';

import {
  TranscriptErrorSchema,
  TranscriptParamsSchema,
  TranscriptQuerySchema,
  TranscriptResponseSchema,
  type TranscriptParams,
  type TranscriptQuery,
} from './schemas.js';
import {
  parliamentStenogramErrorCode,
  parliamentStenogramHttpStatus,
  type ParliamentStenogramTranscript,
} from '../../core/types.js';
import {
  getParliamentStenogramTranscript,
  type ParliamentStenogramUsecaseDeps,
} from '../../core/usecases.js';

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface MakeParliamentRoutesDeps extends ParliamentStenogramUsecaseDeps {
  /**
   * `Cache-Control: public, max-age=<ttl>` for a served transcript. A canonical
   * transcript changes only when the capture is re-parsed, so a long TTL is correct;
   * the ETag makes a revalidation cheap even after it expires.
   */
  readonly transcriptCacheTtlSeconds?: number;
}

const DEFAULT_TRANSCRIPT_TTL_SECONDS = 3_600;

/**
 * The exact bytes the ETag is computed over: the served DATA, in a FIXED key order
 * (never `JSON.stringify` over an object whose key order depends on how it was built).
 * Kept next to the hash so the two can never drift apart.
 *
 * No slice is folded in any more — this endpoint has one representation per sitting
 * (the complete transcript), so the tag is a function of the sitting's served content
 * alone. `canonicalDigest` rides along as a cheap, loader-provided integrity anchor:
 * a re-parse changes it even in the rare case where the privacy-filtered projection
 * of the blocks happens to be unchanged. `navigation` is included because it is part
 * of the served representation — a new neighbouring sitting changes what a client
 * renders.
 */
const canonicalTranscriptPayload = (transcript: ParliamentStenogramTranscript): string => {
  const s = transcript.session;
  const ref = (
    r: { sessionKey: string; sessionDate: string | null; title: string | null } | null
  ) => (r === null ? null : [r.sessionKey, r.sessionDate, r.title]);
  return JSON.stringify([
    'parliament.stenogram.transcript.v2',
    transcript.totalSegments,
    s.canonicalDigest,
    s.captureDigest,
    [ref(transcript.navigation.previous), ref(transcript.navigation.next)],
    [
      s.sessionKey,
      s.chamber,
      s.sessionDate,
      s.sessionDateSource,
      s.title,
      s.sourceSystem,
      s.availability,
      s.sourceUrl,
      s.sourceUrlKind,
      s.sittingKey,
      s.presidingText,
      s.startTimeText,
      s.endTimeText,
      s.segmentCount,
      s.speechCount,
      s.speakerCount,
      s.sourceUpdatedAt,
    ],
    transcript.segments.map((g) => [
      g.segmentKey,
      g.sessionKey,
      g.position,
      g.kind,
      g.text,
      g.textChars,
      g.speakerName,
      g.speakerRef,
      g.mandateKey,
      g.speechKey,
      g.agendaRef,
      g.sourceUrl,
      g.sourceUrlKind,
    ]),
  ]);
};

/** A strong ETag over the canonical payload. Quoted per RFC 9110. */
export const transcriptEtag = (transcript: ParliamentStenogramTranscript): string =>
  `"${createHash('sha256').update(canonicalTranscriptPayload(transcript)).digest('base64url')}"`;

/**
 * RFC 9110 `If-None-Match`: a comma-separated list of entity tags, or `*`. Weak
 * validators (`W/"…"`) compare equal to the strong tag for a GET, so the `W/` prefix
 * is stripped before comparing rather than treated as a mismatch.
 */
export const ifNoneMatchSatisfied = (header: string | undefined, etag: string): boolean => {
  if (header === undefined || header.trim() === '') return false;
  if (header.trim() === '*') return true;
  const normalize = (tag: string): string => tag.trim().replace(/^W\//u, '');
  return header.split(',').some((candidate) => normalize(candidate) === normalize(etag));
};

export const makeParliamentRoutes = (deps: MakeParliamentRoutesDeps): FastifyPluginAsync => {
  const ttl = deps.transcriptCacheTtlSeconds ?? DEFAULT_TRANSCRIPT_TTL_SECONDS;
  const cacheControl = `public, max-age=${String(ttl)}, stale-while-revalidate=${String(ttl)}`;

  /** Headers common to 200 and 304 — a 304 MUST repeat the validators (RFC 9110 §15.4.5). */
  const setCacheHeaders = (reply: FastifyReply, etag: string): void => {
    void reply.header('etag', etag);
    void reply.header('cache-control', cacheControl);
    // The response is negotiated per encoding by whatever compressor sits in front.
    void reply.header('vary', 'accept-encoding');
  };

  return async (fastify) => {
    // Boundary rejections (an out-of-range `limit`, an unknown query param) are
    // produced by Fastify's schema validator, whose default body does NOT match the
    // module envelope — declaring a 400 response schema without this would turn a
    // clean 400 into a 500 serialization failure. Encapsulated to this plugin scope,
    // so it cannot change how the host app reports anything else.
    fastify.setErrorHandler((error, request, reply) => {
      // Narrow the framework error the way the share/ins routes do (Fastify types the
      // handler's error loosely under this project's strict settings).
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
      // Anything else is unexpected: report it in the same envelope rather than
      // leaking a framework error shape, and log it as a server fault.
      request.log.error({ err: error }, '[parliament] transcript route failed');
      const status = typeof fault.statusCode === 'number' ? fault.statusCode : 500;
      return reply.status(status).send({
        ok: false as const,
        error: status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_INPUT',
        message,
        meta: { requestId: request.id },
      });
    });

    fastify.get<{ Params: TranscriptParams; Querystring: TranscriptQuery }>(
      '/stenograms/:sessionKey/transcript',
      {
        // A PUBLIC data route (§14.11): the transcript of a plenary sitting is a
        // public act, and every row the usecase can return is `privacy_class='public'`
        // — restricted sessions/blocks are filtered in the repo, not here. No auth
        // config is attached because the redesign surface registers no auth
        // preHandler; if a host app ever adds one, this route must stay exempt.
        schema: {
          params: TranscriptParamsSchema,
          querystring: TranscriptQuerySchema,
          response: {
            200: TranscriptResponseSchema,
            400: TranscriptErrorSchema,
            404: TranscriptErrorSchema,
            409: TranscriptErrorSchema,
            500: TranscriptErrorSchema,
            503: TranscriptErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const { sessionKey } = request.params;

        // The COMPLETE transcript: one response = one whole sitting. The usecase pages
        // the repository internally, so this stays bounded per query without exposing
        // a page size that could truncate the answer.
        const result = await getParliamentStenogramTranscript(deps, sessionKey);

        if (result.isErr()) {
          const error = result.error;
          const status = parliamentStenogramHttpStatus(error);
          if (status >= 500) {
            request.log.error({ err: error }, '[parliament] transcript read failed');
          }
          return reply.status(status).send({
            ok: false as const,
            error: parliamentStenogramErrorCode(error),
            message: error.message,
            ...(error.type === 'TranscriptUnavailable' && {
              reason: error.reason,
              sessionKey: error.sessionKey,
              // The sitting itself, when we hold it — this is what keeps
              // TRANSCRIPT_UNAVAILABLE actionable and distinct from NOT_FOUND.
              session: error.session,
            }),
            meta: { requestId: request.id },
          });
        }

        const transcript = result.value;
        const etag = transcriptEtag(transcript);
        setCacheHeaders(reply, etag);

        // Conditional GET: the client already holds this exact representation.
        // 304 carries no body and repeats the validators.
        if (ifNoneMatchSatisfied(request.headers['if-none-match'], etag)) {
          return reply.status(304).send();
        }

        return reply.status(200).send({
          ok: true as const,
          data: {
            session: transcript.session,
            segments: transcript.segments,
            navigation: transcript.navigation,
          },
          meta: {
            requestId: request.id,
            totalSegments: transcript.totalSegments,
            // The usecase refuses to return a short read (it errors instead), so this
            // literal is a claim the response can actually keep.
            complete: true as const,
            asOf: transcript.session.sourceUpdatedAt,
            canonicalDigest: transcript.session.canonicalDigest,
          },
        });
      }
    );
  };
};
