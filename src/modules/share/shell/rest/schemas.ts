/**
 * Share Module REST API - TypeBox Schemas
 *
 * Request/response validation schemas for the REST API.
 */

import { Type, type Static } from '@sinclair/typebox';

import { CODE_LENGTH, MAX_URL_LENGTH } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create short link request body schema.
 */
export const CreateShortLinkBodySchema = Type.Object(
  {
    url: Type.String({
      format: 'uri',
      maxLength: MAX_URL_LENGTH,
      description: 'The URL to shorten. Must be from an approved client domain.',
    }),
  },
  { additionalProperties: false }
);

export type CreateShortLinkBody = Static<typeof CreateShortLinkBodySchema>;

/**
 * Resolve short link URL params schema.
 */
export const ResolveShortLinkParamsSchema = Type.Object(
  {
    code: Type.String({
      minLength: CODE_LENGTH,
      maxLength: CODE_LENGTH,
      pattern: `^[A-Za-z0-9_-]{${String(CODE_LENGTH)}}$`,
      description: 'The 16-character short link code',
    }),
  },
  { additionalProperties: false }
);

export type ResolveShortLinkParams = Static<typeof ResolveShortLinkParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Success response with code.
 */
export const CreateShortLinkResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    code: Type.String({
      minLength: CODE_LENGTH,
      maxLength: CODE_LENGTH,
      description: 'The generated short link code',
    }),
  }),
});

/**
 * Success response with URL.
 */
export const ResolveShortLinkResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({
    url: Type.String({
      format: 'uri',
      description: 'The original URL',
    }),
  }),
});

/**
 * Error response schema.
 */
export const ErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String({ description: 'Error type' }),
  message: Type.Optional(Type.String({ description: 'Human-readable error message' })),
});

export type ErrorResponse = Static<typeof ErrorResponseSchema>;
