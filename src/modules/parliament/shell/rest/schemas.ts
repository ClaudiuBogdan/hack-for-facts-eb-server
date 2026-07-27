/**
 * Parliament module — REST boundary schemas for the canonical full-transcript
 * endpoint (foundation §5.2 envelope + TypeBox at the boundary).
 *
 * The response schemas are declarative only — they document the contract and let
 * Fastify's serializer keep a stable field order, which is what makes the ETag
 * deterministic. `Static<typeof …>` is the handler's input type; nothing here parses
 * untrusted JSON by hand (no raw `JSON.parse`).
 */

import { Type, type Static } from '@sinclair/typebox';

export const TranscriptParamsSchema = Type.Object(
  {
    sessionKey: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "Canonical stenogram session key, e.g. 'cdep:9043' or 'senat:<raw session key>'.",
    }),
  },
  { additionalProperties: false }
);
export type TranscriptParams = Static<typeof TranscriptParamsSchema>;

/**
 * The transcript endpoint takes NO pagination.
 *
 * One successful response IS the complete ordered sitting. Offering `offset`/`limit`
 * here would mean the obvious call — `GET …/transcript` — silently returned a first
 * page of a long sitting while looking exactly like the whole thing, which is the
 * failure a full-transcript endpoint exists to prevent. The usecase pages the
 * repository internally instead, so the read stays bounded per query without the
 * caller having to know that.
 *
 * A schema client that genuinely wants a slice uses the GraphQL
 * `parliamentStenogramSession(offset:, limit:)` root, which is explicitly a slice.
 */
export const TranscriptQuerySchema = Type.Object({}, { additionalProperties: false });
export type TranscriptQuery = Static<typeof TranscriptQuerySchema>;

const StenogramSessionSchema = Type.Object({
  sessionKey: Type.String(),
  chamber: Type.String(),
  sessionDate: Type.Union([Type.String(), Type.Null()]),
  sessionDateSource: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  sourceSystem: Type.String(),
  availability: Type.String(),
  sourceUrl: Type.String(),
  sourceUrlKind: Type.String(),
  sittingKey: Type.Union([Type.String(), Type.Null()]),
  presidingText: Type.Union([Type.String(), Type.Null()]),
  startTimeText: Type.Union([Type.String(), Type.Null()]),
  endTimeText: Type.Union([Type.String(), Type.Null()]),
  segmentCount: Type.Integer(),
  speechCount: Type.Integer(),
  speakerCount: Type.Integer(),
  captureDigest: Type.Union([Type.String(), Type.Null()]),
  canonicalDigest: Type.String(),
  sourceUpdatedAt: Type.Union([Type.String(), Type.Null()]),
});

/** A sitting as a NAVIGATION TARGET: enough to label it and to open its source. */
const StenogramSessionRefSchema = Type.Object({
  sessionKey: Type.String(),
  chamber: Type.String(),
  sessionDate: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  availability: Type.String(),
  sourceUrl: Type.String(),
  sourceUrlKind: Type.String(),
});

const SittingNavigationSchema = Type.Object({
  previous: Type.Union([StenogramSessionRefSchema, Type.Null()]),
  next: Type.Union([StenogramSessionRefSchema, Type.Null()]),
});

const StenogramSegmentSchema = Type.Object({
  segmentKey: Type.String(),
  sessionKey: Type.String(),
  position: Type.Integer(),
  kind: Type.String(),
  text: Type.String(),
  textChars: Type.Integer(),
  speakerName: Type.Union([Type.String(), Type.Null()]),
  speakerRef: Type.Union([Type.String(), Type.Null()]),
  mandateKey: Type.Union([Type.String(), Type.Null()]),
  speechKey: Type.Union([Type.String(), Type.Null()]),
  agendaRef: Type.Union([Type.String(), Type.Null()]),
  sourceUrl: Type.String(),
  sourceUrlKind: Type.String(),
  // Speaker identity (scrapper migration 20260727T140000). All four are null on a
  // database without it, and `speakerResolution` is null on a non-SPEECH block.
  personId: Type.Union([Type.String(), Type.Null()]),
  speakerResolution: Type.Union([Type.String(), Type.Null()]),
  speakerMethod: Type.Union([Type.String(), Type.Null()]),
  speakerConfidence: Type.Union([Type.String(), Type.Null()]),
});

export const TranscriptResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    session: StenogramSessionSchema,
    /** The COMPLETE ordered public reading — never a page of it. */
    segments: Type.Array(StenogramSegmentSchema),
    /** Chamber-scoped chronological neighbours, for the previous/next sitting control. */
    navigation: SittingNavigationSchema,
  }),
  meta: Type.Object({
    requestId: Type.String(),
    /** Always equals `data.segments.length` on this endpoint — it serves the whole sitting. */
    totalSegments: Type.Integer(),
    /** `true` on this endpoint, always: the response is the complete transcript. */
    complete: Type.Literal(true),
    /** Freshness watermark of the underlying capture (§10 `meta.asOf`). */
    asOf: Type.Union([Type.String(), Type.Null()]),
    /** Integrity anchor of the ORDERED reading, straight from the loader. */
    canonicalDigest: Type.String(),
  }),
});

/**
 * Typed error envelope. `error` is the SAME code vocabulary GraphQL puts in
 * `extensions.code` and MCP puts in `error` — `NOT_FOUND`,
 * `TRANSCRIPT_UNAVAILABLE`, `SEARCH_UNAVAILABLE`, `INVALID_INPUT`, … — so a client
 * branches on one set of names across all three surfaces. `reason` is present only
 * for `TRANSCRIPT_UNAVAILABLE` and is the actionable part: `source_only` /
 * `no_public_segments` are permanent properties of the sitting, while
 * `projection_unavailable` is an operational gap worth retrying.
 */
export const TranscriptErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
  reason: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * Present on `TRANSCRIPT_UNAVAILABLE` whenever we hold the sitting — which is
   * exactly what makes this different from `NOT_FOUND`. A SOURCE_ONLY sitting is real:
   * the client renders its title/chamber/date and an "open the official transcript"
   * action from `sourceUrl` + `sourceUrlKind` (so a Senate `lossy_root` link is not
   * presented as an exact deep link), without a second request that would 409 again.
   */
  session: Type.Optional(Type.Union([StenogramSessionRefSchema, Type.Null()])),
  meta: Type.Object({ requestId: Type.String() }),
});
