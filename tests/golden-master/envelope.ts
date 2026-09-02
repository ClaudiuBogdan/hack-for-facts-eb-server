/**
 * GraphQL wire envelope: lossless parsing + shape validation (pure, no I/O).
 *
 * - Numbers are kept as their exact wire tokens (`LosslessNumber`) via the
 *   `JSON.parse` reviver's `context.source` (Node ≥ 21), so `9007199254740992`
 *   and `9007199254740993` stay different and the comparison is exact. Any
 *   non-finite token (e.g. `1e999`, which native parsing turns into Infinity)
 *   is rejected.
 * - A body is only an envelope if it is a JSON object carrying `data`
 *   (object or null) and/or `errors` (array of `{ message }`), and nothing
 *   but `data` / `errors` / `extensions`. Fastify's default 404 body
 *   `{ message, error, statusCode }` is therefore NOT an envelope — a missing
 *   route must surface as a transport defect, never as "both sides agree".
 * - `toPlain()` converts `LosslessNumber`s back to JS numbers for callers that
 *   need plain data (snapshot matcher, `query()` return value).
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Decimal } from 'decimal.js';

// =============================================================================
// Lossless numbers
// =============================================================================

export class LosslessNumber {
  readonly source: string;
  readonly decimal: Decimal;

  constructor(source: string) {
    this.source = source;
    this.decimal = new Decimal(source);
  }

  /** Canonical decimal text (`1.0` and `1` render the same). */
  toString(): string {
    return this.decimal.toFixed();
  }

  /** Reports and fingerprints render numbers as their decimal text. */
  toJSON(): string {
    return this.toString();
  }

  toNumber(): number {
    return Number(this.source);
  }
}

export function isLosslessNumber(value: unknown): value is LosslessNumber {
  return value instanceof LosslessNumber;
}

export type EnvelopeErrorKind = 'non-json' | 'non-finite-number' | 'non-envelope' | 'redirect';

export class EnvelopeError extends Error {
  readonly kind: EnvelopeErrorKind;

  constructor(kind: EnvelopeErrorKind, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.kind = kind;
  }
}

interface ReviverContext {
  source?: string;
}

/**
 * JSON.parse with every numeric token preserved as a `LosslessNumber`.
 * Throws `EnvelopeError('non-json' | 'non-finite-number')`.
 */
export function parseLosslessJson(text: string): unknown {
  const seen = { nonFinite: null as string | null };
  let parsed: unknown;
  try {
    // eslint-disable-next-line no-restricted-syntax -- the lossless reviver IS the safe-parsing utility; the result is validated by the caller
    parsed = JSON.parse(
      text,
      function reviver(_key: string, value: unknown, context?: ReviverContext) {
        if (typeof value !== 'number') return value;
        const source = context?.source;
        if (source === undefined) {
          // Node without reviver context: fall back to the double (documented loss).
          return new LosslessNumber(String(value));
        }
        const lossless = new LosslessNumber(source);
        // A token no double can carry (`1e999` → Infinity natively) or that
        // decimal.js cannot represent is not a number we can compare.
        if (!lossless.decimal.isFinite() || !Number.isFinite(Number(source))) {
          seen.nonFinite ??= source;
        }
        return lossless;
      }
    );
  } catch (error) {
    throw new EnvelopeError('non-json', `body is not JSON: ${(error as Error).message}`);
  }
  if (seen.nonFinite !== null) {
    throw new EnvelopeError('non-finite-number', `non-finite numeric token ${seen.nonFinite}`);
  }
  return parsed;
}

/** Recursively converts `LosslessNumber`s to JS numbers (callers cast the result). */
export function toPlain(value: unknown): unknown {
  if (isLosslessNumber(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(item);
    }
    return out;
  }
  return value;
}

// =============================================================================
// Envelope shape
// =============================================================================

export interface GraphQLErrorShape {
  message: string;
  locations?: { line: number | LosslessNumber; column: number | LosslessNumber }[];
  path?: (string | number | LosslessNumber)[];
  extensions?: Record<string, unknown>;
}

/** The full wire envelope of one GraphQL POST, kept verbatim. */
export interface GraphQLEnvelope<T = unknown> {
  /** HTTP status (Mercurius answers validation errors with 400). `0` = unreachable. */
  status: number;
  /** Final response URL (redirects are refused, so this is the request URL). */
  url?: string;
  data?: T | null;
  errors?: GraphQLErrorShape[];
}

const EnvelopeBodySchema = Type.Object(
  {
    data: Type.Optional(Type.Union([Type.Null(), Type.Object({}, { additionalProperties: true })])),
    errors: Type.Optional(
      Type.Array(Type.Object({ message: Type.String() }, { additionalProperties: true }))
    ),
    extensions: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: false }
);

/**
 * Parses and validates a response body into an envelope. Throws
 * `EnvelopeError('non-envelope')` for anything that is not a GraphQL envelope
 * (including Fastify's 404 body).
 */
export function parseEnvelope<T = unknown>(
  text: string,
  status: number,
  url: string
): GraphQLEnvelope<T> {
  const raw = parseLosslessJson(text);
  if (!Value.Check(EnvelopeBodySchema, raw)) {
    const problems = [...Value.Errors(EnvelopeBodySchema, raw)]
      .slice(0, 3)
      .map((e) => `${e.path === '' ? '$' : e.path}: ${e.message}`)
      .join('; ');
    throw new EnvelopeError(
      'non-envelope',
      `HTTP ${String(status)} body is not a GraphQL envelope (${problems}): ${text.slice(0, 160)}`
    );
  }
  if (raw.data === undefined && raw.errors === undefined) {
    throw new EnvelopeError(
      'non-envelope',
      `HTTP ${String(status)} body carries neither "data" nor "errors": ${text.slice(0, 160)}`
    );
  }
  return {
    status,
    url,
    ...(raw.data !== undefined && { data: raw.data as T | null }),
    ...(raw.errors !== undefined && { errors: raw.errors }),
  };
}
