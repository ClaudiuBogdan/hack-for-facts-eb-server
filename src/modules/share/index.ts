/**
 * Share Module - Public API
 *
 * Provides URL shortening functionality for creating shareable links.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ShortLink,
  UrlMetadata,
  ShareConfig,
  CreateShortLinkInput,
  Hasher,
} from './core/types.js';

export {
  // Constants
  MAX_URL_LENGTH,
  CODE_LENGTH,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_CACHE_TTL_SECONDS,
  CODE_PATTERN,
  // Type guards
  isValidCode,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ShareError,
  DatabaseError,
  UrlNotAllowedError,
  InvalidInputError,
  RateLimitExceededError,
  HashCollisionError,
  ShortLinkNotFoundError,
} from './core/errors.js';

export {
  // Error constructors
  createDatabaseError,
  createUrlNotAllowedError,
  createInvalidInputError,
  createRateLimitExceededError,
  createHashCollisionError,
  createShortLinkNotFoundError,
  // HTTP status mapping
  SHARE_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports (Repository Interfaces)
// ─────────────────────────────────────────────────────────────────────────────

export type { ShortLinkRepository, ShortLinkCache } from './core/ports.js';

export { noopCache } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core URL Utilities
// ─────────────────────────────────────────────────────────────────────────────

export {
  buildCanonicalMetadata,
  isSameMetadata,
  generateCode,
  isApprovedUrl,
} from './core/url-utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  createShortLink,
  type CreateShortLinkDeps,
  type CreateShortLinkInput as CreateShortLinkUseCaseInput,
  type CreateShortLinkResult,
} from './core/usecases/create-short-link.js';

export {
  resolveShortLink,
  type ResolveShortLinkDeps,
  type ResolveShortLinkInput,
  type ResolveShortLinkResult,
} from './core/usecases/resolve-short-link.js';

export {
  makeShareLink,
  type MakeShareLinkDeps,
  type MakeShareLinkInput,
  type ShareLinkLogger,
} from './core/usecases/make-share-link.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

export { makeShortLinkRepo, type ShortLinkRepoOptions } from './shell/repo/short-link-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Cache Implementation
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeRedisShortLinkCache,
  type RedisShortLinkCacheOptions,
  type RedisClient,
} from './shell/cache/redis-cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Crypto (Hasher)
// ─────────────────────────────────────────────────────────────────────────────

export { cryptoHasher } from './shell/crypto/hasher.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Routes
// ─────────────────────────────────────────────────────────────────────────────

export { makeShareRoutes, type MakeShareRoutesDeps } from './shell/rest/routes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Schemas (TypeBox)
// ─────────────────────────────────────────────────────────────────────────────

export {
  CreateShortLinkBodySchema,
  ResolveShortLinkParamsSchema,
  CreateShortLinkResponseSchema,
  ResolveShortLinkResponseSchema,
  ErrorResponseSchema,
  type CreateShortLinkBody,
  type ResolveShortLinkParams,
  type ErrorResponse,
} from './shell/rest/schemas.js';
