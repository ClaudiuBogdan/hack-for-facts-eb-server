/**
 * Legal module — REST boundary schemas for the cacheable TLDF render routes
 * (foundation §5.2 envelope + TypeBox at the boundary).
 *
 *   GET /api/v1/legal/documents/:documentId/render
 *   GET /api/v1/legal/documents/:documentId/render/chunks/:chunkIndex
 *
 * The `tldf` field is declared `Type.Any()` ON PURPOSE: the payload is the
 * stored TLDF artifact (envelope / manifest / chunk group), whose contract is
 * owned by the scrapper compiler (`prod-db/tldf-v1.schema.json`), not by this
 * boundary. Re-declaring its object shape here would make Fastify's
 * fast-json-stringify serializer SILENTLY STRIP any field the declaration
 * missed — a corruption the fold-sha gate downstream would catch only after
 * the client already received broken bytes. `Any` serializes verbatim.
 */

import { Type, type Static } from '@sinclair/typebox';

export const RenderParamsSchema = Type.Object(
  {
    documentId: Type.String({
      minLength: 1,
      maxLength: 64,
      description: "Portal document id (act_documents.document_id), e.g. '171282'.",
    }),
  },
  { additionalProperties: false }
);
export type RenderParams = Static<typeof RenderParamsSchema>;

export const RenderChunkParamsSchema = Type.Object(
  {
    documentId: Type.String({ minLength: 1, maxLength: 64 }),
    /** Physical chunk index, 0-based. 0 is the manifest on a chunked document. */
    chunkIndex: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  { additionalProperties: false }
);
export type RenderChunkParams = Static<typeof RenderChunkParamsSchema>;

/** Both render routes take no query parameters. */
export const RenderQuerySchema = Type.Object({}, { additionalProperties: false });
export type RenderQuery = Static<typeof RenderQuerySchema>;

export const RenderResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    documentId: Type.String(),
    /**
     * What `tldf` IS: 'envelope' = the complete logical artifact; 'manifest' =
     * the chunk index of a chunked document (never a partial blocks[]);
     * 'chunk' = one physical group of consecutive top-level blocks.
     */
    kind: Type.Union([Type.Literal('envelope'), Type.Literal('manifest'), Type.Literal('chunk')]),
    chunkIndex: Type.Integer(),
    chunkCount: Type.Integer(),
    /** The stored TLDF payload, byte-faithful (see the module docblock). */
    tldf: Type.Any(),
  }),
  meta: Type.Object({
    requestId: Type.String(),
    /** Generation identity — the same values the ETag is built from. */
    runId: Type.String(),
    textSha256: Type.String(),
    compilerVersion: Type.String(),
    compiledAt: Type.String(),
  }),
});

export const RenderErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
  /** For RENDER_UNAVAILABLE: which non-served state the generation is in. */
  renderStatus: Type.Optional(Type.String()),
  /** For RENDER_INCONSISTENT: which invariant the stored rows violate. */
  detail: Type.Optional(Type.String()),
  meta: Type.Object({ requestId: Type.String() }),
});
