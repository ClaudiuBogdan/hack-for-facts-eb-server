/**
 * Authentication Module Public API
 *
 * Exports types, use cases, adapters, and middleware for authentication.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { AuthSession, AnonymousSession, AuthContext, UserId } from './core/types.js';

export type { AuthError } from './core/errors.js';

export type { AuthProvider, SessionExtractor } from './core/ports.js';

export type { AuthenticatedMercuriusContext } from './shell/middleware/graphql-context.js';

export type { MCPRequest } from './shell/extractors/mcp-extractor.js';

export type {
  MCPAuthService,
  MCPToolHandler,
  AuthenticatedMCPToolHandler,
  AuthenticatedMCPContext,
} from './shell/middleware/mcp-auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export { ANONYMOUS_SESSION, AUTH_HEADER, BEARER_PREFIX } from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Type Constructors & Guards
// ─────────────────────────────────────────────────────────────────────────────

export { toUserId, isAuthenticated, isAnonymous } from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

export {
  createInvalidTokenError,
  createTokenExpiredError,
  createTokenSignatureError,
  createAuthenticationRequiredError,
  createAuthProviderError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error Mappings
// ─────────────────────────────────────────────────────────────────────────────

export { AUTH_ERROR_HTTP_STATUS, AUTH_ERROR_GQL_CODE } from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  authenticate,
  type AuthenticateDeps,
  type AuthenticateInput,
} from './core/usecases/authenticate.js';

export { requireAuth } from './core/usecases/require-auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────────

// JWT Adapter (recommended for Clerk and other JWT providers)
export {
  makeJWTAdapter,
  type MakeJWTAdapterOptions,
  type JWTVerifyFn,
  type ImportSPKIFn,
  type JWTKey,
  type JWTPayload,
} from './shell/adapters/jwt-adapter.js';

// Cached Adapter (wraps any provider with LRU cache)
export {
  makeCachedAuthProvider,
  makeCachedAuthProviderWithStats,
  type MakeCachedAuthProviderOptions,
  type CachedAuthProviderWithStats,
  type CacheStats,
} from './shell/adapters/cached-adapter.js';

// Legacy Clerk Adapter (uses @clerk/backend SDK)
export {
  makeClerkAdapter,
  type MakeClerkAdapterOptions,
  type ClerkVerifyTokenFn,
} from './shell/adapters/clerk-adapter.js';

// In-Memory Adapter (for testing)
export {
  makeInMemoryAuthProvider,
  createTestToken,
  createTestAuthProvider,
  type MakeInMemoryAuthProviderOptions,
} from './shell/adapters/in-memory-adapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Extractors
// ─────────────────────────────────────────────────────────────────────────────

export {
  httpSessionExtractor,
  makeHttpSessionExtractor,
} from './shell/extractors/http-extractor.js';

export { mcpSessionExtractor, makeMCPSessionExtractor } from './shell/extractors/mcp-extractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Middleware (Fastify REST)
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeAuthMiddleware,
  requireAuthHandler,
  type MakeAuthMiddlewareDeps,
} from './shell/middleware/fastify-auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Middleware (GraphQL)
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeGraphQLContext,
  AuthGraphQLError,
  requireAuthOrThrow,
  withAuth,
  type MakeGraphQLContextDeps,
} from './shell/middleware/graphql-context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Middleware (MCP)
// ─────────────────────────────────────────────────────────────────────────────

export { makeMCPAuthService, type MakeMCPAuthServiceDeps } from './shell/middleware/mcp-auth.js';
