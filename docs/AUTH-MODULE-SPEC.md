# Authentication Module Specification

## Version 4.0

---

## 1. Overview

This specification defines the architecture for a **provider-agnostic authentication module** using the **Adapter Pattern**. The module authenticates requests across multiple transport layers (GraphQL, REST, MCP) while maintaining strict isolation from any specific authentication vendor.

### 1.1 Problem Statement

The application needs to:

1. Authenticate users via bearer tokens (JWTs)
2. Extract user ID for associating user-generated data
3. Support multiple transport protocols (GraphQL, REST, MCP)
4. Allow future migration between auth providers (Clerk, Auth0, Firebase, etc.)
5. Maintain testability with in-memory fakes
6. Provide high-performance token verification with caching

### 1.2 Design Constraints

| Constraint                | Requirement                                              |
| :------------------------ | :------------------------------------------------------- |
| **Provider Agnosticism**  | Core domain MUST NOT import any vendor SDK               |
| **Transport Agnosticism** | Same auth logic MUST work across GraphQL, REST, and MCP  |
| **Functional Core**       | Core MUST be pure (no I/O, no side effects)              |
| **Result Types**          | Core MUST return `Result<T, E>` (no thrown exceptions)   |
| **Explicit Dependencies** | All dependencies MUST be injected via function arguments |
| **Testability**           | Core MUST be 100% unit testable with in-memory fakes     |
| **Minimal Data**          | Only user ID is extracted; no user data storage          |
| **No Vendor Lock-in**     | Use standard JWT verification, not vendor SDKs           |

### 1.3 Scope

**In Scope:**

- Token verification via abstract `AuthProvider` interface
- User ID extraction for data association
- **JWT adapter using `jose` library** (primary, recommended)
- Cached adapter wrapper for performance optimization
- Clerk adapter implementation (legacy, uses `@clerk/backend`)
- In-memory adapter for testing
- GraphQL context integration (Mercurius)
- REST middleware integration (Fastify)
- MCP (Model Context Protocol) authentication

**Out of Scope:**

- User registration/signup flows (handled by auth provider)
- User profile storage (we don't store user data)
- Role-based access control (future enhancement)
- Permission system (future enhancement)
- Session management UI

---

## 2. Domain Model

### 2.1 Auth Session

```
┌─────────────────────────────────────────────────────────────────┐
│                       AuthSession                               │
├─────────────────────────────────────────────────────────────────┤
│ userId: UserId          (branded string, from token `sub`)      │
│ expiresAt: Date         (token expiration time)                 │
└─────────────────────────────────────────────────────────────────┘
```

**Invariants:**

- `userId` MUST be non-empty string
- Session is valid iff `now() < expiresAt`

### 2.2 Anonymous Session

```
┌─────────────────────────────────────────────────────────────────┐
│                     AnonymousSession                            │
├─────────────────────────────────────────────────────────────────┤
│ userId: null            (no user identifier)                    │
│ isAnonymous: true       (discriminator field)                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Auth Context

The discriminated union of authenticated and anonymous sessions:

```typescript
type AuthContext = AuthSession | AnonymousSession;
```

**Type Guards:**

- `isAuthenticated(ctx)`: Returns `true` iff `ctx.userId !== null`
- `isAnonymous(ctx)`: Returns `true` iff `ctx.userId === null`

---

## 3. Authentication Flow

### 3.1 Token Extraction

Tokens are extracted from the `Authorization` header using the Bearer scheme:

| Transport | Extraction Method      | Format           |
| :-------- | :--------------------- | :--------------- |
| HTTP      | `Authorization` header | `Bearer <token>` |
| MCP       | `meta.authorization`   | `Bearer <token>` |

**Algorithm: Token Extraction**

```
INPUT: Request with headers
OUTPUT: token (string | null)

1. header = request.headers['authorization']
2. IF header is undefined OR not string:
     RETURN null
3. IF NOT header.startsWith('Bearer '):
     RETURN null
4. token = header.slice(7).trim()
5. IF token is empty:
     RETURN null
6. RETURN token
```

### 3.2 Authentication Algorithm

```
INPUT:
  - authProvider: AuthProvider (port implementation)
  - token: string | null

OUTPUT: Result<AuthContext, AuthError>

1. IF token is null OR empty:
     RETURN Ok(ANONYMOUS_SESSION)

2. verifyResult = await authProvider.verifyToken(token)

3. IF verifyResult.isErr():
     RETURN Err(verifyResult.error)

4. RETURN Ok(verifyResult.value)
```

**State Diagram:**

```
                    ┌─────────────┐
                    │   START     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Token null? │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │ YES                     │ NO
              ▼                         ▼
    ┌─────────────────┐       ┌─────────────────┐
    │ Return Anonymous │       │  Verify Token   │
    │     Session      │       │  with Provider  │
    └─────────────────┘       └────────┬────────┘
                                       │
                          ┌────────────┴────────────┐
                          │                         │
                          ▼                         ▼
                   ┌────────────┐           ┌────────────┐
                   │   Valid    │           │  Invalid   │
                   │   Token    │           │   Token    │
                   └─────┬──────┘           └─────┬──────┘
                         │                        │
                         ▼                        ▼
               ┌─────────────────┐      ┌─────────────────┐
               │ Return Auth     │      │ Return Error    │
               │    Session      │      │                 │
               └─────────────────┘      └─────────────────┘
```

### 3.3 Cached Authentication Flow

When using the cached adapter wrapper, the flow becomes:

```
                     ┌─────────────┐
                     │   START     │
                     └──────┬──────┘
                            │
                            ▼
                     ┌─────────────┐
                     │ Token null? │
                     └──────┬──────┘
                            │
               ┌────────────┴────────────┐
               │ YES                     │ NO
               ▼                         ▼
     ┌─────────────────┐       ┌─────────────────┐
     │ Return Anonymous │       │ Hash token with │
     │     Session      │       │    SHA-256      │
     └─────────────────┘       └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │ Check LRU Cache │
                               └────────┬────────┘
                                        │
                           ┌────────────┴────────────┐
                           │ HIT                     │ MISS
                           ▼                         ▼
                  ┌─────────────────┐       ┌─────────────────┐
                  │ Return Cached   │       │  Verify Token   │
                  │    Session      │       │  with Provider  │
                  └─────────────────┘       └────────┬────────┘
                                                     │
                                        ┌────────────┴────────────┐
                                        │                         │
                                        ▼                         ▼
                                 ┌────────────┐           ┌────────────┐
                                 │   Valid    │           │  Invalid   │
                                 │   Token    │           │   Token    │
                                 └─────┬──────┘           └─────┬──────┘
                                       │                        │
                                       ▼                        │
                             ┌─────────────────┐                │
                             │ Cache Session   │                │
                             │ (with TTL)      │                │
                             └────────┬────────┘                │
                                      │                         │
                                      ▼                         ▼
                            ┌─────────────────┐      ┌─────────────────┐
                            │ Return Auth     │      │ Return Error    │
                            │    Session      │      │ (NOT cached)    │
                            └─────────────────┘      └─────────────────┘
```

**Security Note:** Invalid tokens are NOT cached to prevent cache poisoning attacks.

### 3.4 Token Verification (Provider Contract)

The `AuthProvider.verifyToken(token)` method MUST:

1. Decode and validate token signature
2. Check token expiration (`exp` claim)
3. Extract user ID (`sub` claim)
4. Build and return `AuthSession`

**Possible Errors:**

- `InvalidTokenError`: Token is malformed or undecodable
- `TokenExpiredError`: Token `exp` claim is in the past
- `TokenSignatureError`: Signature verification failed
- `AuthProviderError`: Provider communication failed (retryable)

---

## 4. Authorization

Authorization is simple: check if the user is authenticated.

### 4.1 Authorization Algorithm

```
INPUT:
  - context: AuthContext

OUTPUT: Result<UserId, AuthError>

1. IF context.userId is null:
     RETURN Err(AuthenticationRequiredError)

2. RETURN Ok(context.userId)
```

### 4.2 Usage Pattern

```typescript
// In a resolver or route handler
const userId = requireAuth(context.auth);
if (userId.isErr()) {
  throw new AuthGraphQLError(userId.error);
}

// Use userId.value to associate with user-generated data
await repo.createNotification({ userId: userId.value, ... });
```

---

## 5. Error Types

### 5.1 Error Hierarchy

```
AuthError (union type)
├── InvalidTokenError      (401) - Token malformed
├── TokenExpiredError      (401) - Token past expiration
├── TokenSignatureError    (401) - Signature invalid
├── AuthenticationRequiredError  (401) - Auth required but not provided
└── AuthProviderError      (503) - Provider unavailable (retryable)
```

### 5.2 Error Specifications

| Error Type                    | HTTP | GraphQL Code            | Retryable | Fields                 |
| :---------------------------- | :--- | :---------------------- | :-------- | :--------------------- |
| `InvalidTokenError`           | 401  | `UNAUTHENTICATED`       | No        | `message`, `cause?`    |
| `TokenExpiredError`           | 401  | `UNAUTHENTICATED`       | No        | `message`, `expiredAt` |
| `TokenSignatureError`         | 401  | `UNAUTHENTICATED`       | No        | `message`              |
| `AuthenticationRequiredError` | 401  | `UNAUTHENTICATED`       | No        | `message`              |
| `AuthProviderError`           | 503  | `INTERNAL_SERVER_ERROR` | Yes       | `message`, `cause?`    |

### 5.3 Error Response Format

**REST Response:**

```json
{
  "error": "InvalidTokenError",
  "message": "Token signature verification failed"
}
```

**GraphQL Response:**

```json
{
  "errors": [
    {
      "message": "Token signature verification failed",
      "extensions": {
        "code": "UNAUTHENTICATED"
      }
    }
  ]
}
```

---

## 6. Transport Integration

### 6.1 REST (Fastify) Integration

**Global Authentication Middleware:**

```
FOR EACH incoming request:
  1. Extract token from Authorization header
  2. Authenticate (returns AuthContext or error)
  3. IF error:
       Respond with HTTP status 401 or 503
       END request
  4. Attach AuthContext to request.auth
  5. Continue to route handler
```

**Request Object Extension:**

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}
```

### 6.2 GraphQL (Mercurius) Integration

**Context Builder:**

```
FOR EACH GraphQL request:
  1. Extract token from Authorization header
  2. Authenticate (returns AuthContext or error)
  3. IF error:
       Set AuthContext to ANONYMOUS_SESSION
       (Let resolvers decide how to handle)
  4. Attach AuthContext to context.auth
  5. Return extended MercuriusContext
```

**Context Type Extension:**

```typescript
interface AuthenticatedMercuriusContext extends MercuriusContext {
  auth: AuthContext;
}
```

### 6.3 MCP Integration

**Tool Handler Wrapper:**

```
FOR MCP tool handler requiring auth:
  1. Extract token from MCP request metadata
  2. Authenticate (returns AuthContext or error)
  3. IF auth error:
       Throw Error with message
  4. IF anonymous:
       Throw Error "Authentication required"
  5. Call original handler with userId
```

---

## 7. Provider Adapter Contract

### 7.1 AuthProvider Interface

```typescript
interface AuthProvider {
  /**
   * Verify bearer token and create session.
   *
   * MUST:
   * - Validate token signature
   * - Check expiration
   * - Extract user ID from `sub` claim
   *
   * MUST NOT:
   * - Throw exceptions (return Result.err instead)
   * - Cache tokens (caching is caller's responsibility)
   */
  verifyToken(token: string): Promise<Result<AuthSession, AuthError>>;
}
```

### 7.2 SessionExtractor Interface

```typescript
interface SessionExtractor<T> {
  /**
   * Extract bearer token from transport-specific request.
   *
   * MUST:
   * - Return null for missing token (not error)
   * - Strip 'Bearer ' prefix if present
   * - Trim whitespace
   *
   * MUST NOT:
   * - Validate token (that's AuthProvider's job)
   * - Throw exceptions
   */
  extractToken(request: T): string | null;
}
```

### 7.3 JWT Adapter (Recommended)

The **JWT adapter** uses the `jose` library for pure JWT verification without vendor SDK dependencies:

| AuthProvider Method | jose Function | Notes                                  |
| :------------------ | :------------ | :------------------------------------- |
| `verifyToken`       | `jwtVerify`   | Verifies signature and decodes payload |

**Configuration:**

```typescript
interface JWTAdapterConfig {
  /** PEM-encoded public key for signature verification */
  publicKeyPEM: string;
  /** Allowed audiences (optional) */
  authorizedParties?: string[];
  /** Clock tolerance in seconds (default: 5) */
  clockTolerance?: number;
}
```

**Token Claims Extracted:**

- `sub` → `userId` (required)
- `exp` → `expiresAt` (required)
- `azp` → validated against `authorizedParties` if configured

### 7.4 Cached Adapter (Performance Wrapper)

The **cached adapter** wraps any `AuthProvider` with an LRU cache for high-performance token verification:

| Feature          | Implementation                            |
| :--------------- | :---------------------------------------- |
| Cache key        | SHA-256 hash of token (never raw tokens)  |
| Eviction policy  | LRU (Least Recently Used)                 |
| TTL              | Configurable, default 5 minutes           |
| Max size         | Configurable, default 1000 entries        |
| Negative caching | Invalid tokens NOT cached (always verify) |

**Configuration:**

```typescript
interface CachedAdapterConfig {
  /** Underlying auth provider to wrap */
  provider: AuthProvider;
  /** Maximum cache entries (default: 1000) */
  maxCacheSize?: number;
  /** Cache TTL in milliseconds (default: 300000 = 5 min) */
  cacheTTLMs?: number;
}
```

**Cache Statistics:**

```typescript
interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}
```

### 7.5 Clerk Adapter (Legacy)

| AuthProvider Method | Clerk SDK Method                    | Notes               |
| :------------------ | :---------------------------------- | :------------------ |
| `verifyToken`       | `verifyToken` from `@clerk/backend` | Returns JWT payload |

The adapter extracts `sub` claim as `userId` and `exp` claim as `expiresAt`.

**Note:** The Clerk adapter requires the `@clerk/backend` SDK. For new deployments, prefer the JWT adapter with Clerk's PEM public key.

---

## 8. Module Structure

### 8.1 Directory Layout

```
src/modules/auth/
├── core/
│   ├── types.ts              # Domain types (AuthSession, AuthContext)
│   ├── errors.ts             # Error types and constructors
│   ├── ports.ts              # AuthProvider, SessionExtractor interfaces
│   └── usecases/
│       ├── authenticate.ts   # Token → AuthContext
│       └── require-auth.ts   # Context → UserId (or error)
│
├── shell/
│   ├── adapters/
│   │   ├── jwt-adapter.ts         # Pure JWT verification (jose) - RECOMMENDED
│   │   ├── cached-adapter.ts      # LRU cache wrapper for any provider
│   │   ├── clerk-adapter.ts       # Clerk SDK implementation (legacy)
│   │   └── in-memory-adapter.ts   # Test/dev fake
│   │
│   ├── extractors/
│   │   ├── http-extractor.ts      # Fastify request → token
│   │   └── mcp-extractor.ts       # MCP request → token
│   │
│   └── middleware/
│       ├── fastify-auth.ts        # REST preHandler
│       ├── graphql-context.ts     # Mercurius context builder
│       └── mcp-auth.ts            # MCP tool wrappers
│
└── index.ts                       # Public API
```

### 8.2 Layer Dependencies

| Layer    | Can Import                      | Cannot Import                 |
| -------- | ------------------------------- | ----------------------------- |
| `core/`  | `neverthrow`, `common/*`        | `shell/*`, `infra/*`, any I/O |
| `shell/` | `core/*`, `infra/*`, `common/*` | Other modules' internals      |

---

## 9. Implementation Patterns

### 9.1 Core Types (`core/types.ts`)

```typescript
// Branded Type
export type UserId = string & { readonly __brand: unique symbol };

export const toUserId = (id: string): UserId => id as UserId;

// Session Types
export interface AuthSession {
  readonly userId: UserId;
  readonly expiresAt: Date;
}

export interface AnonymousSession {
  readonly userId: null;
  readonly isAnonymous: true;
}

export type AuthContext = AuthSession | AnonymousSession;

// Type Guards
export const isAuthenticated = (ctx: AuthContext): ctx is AuthSession => ctx.userId !== null;
export const isAnonymous = (ctx: AuthContext): ctx is AnonymousSession => ctx.userId === null;

// Constants
export const ANONYMOUS_SESSION: AnonymousSession = {
  userId: null,
  isAnonymous: true,
} as const;

export const AUTH_HEADER = 'authorization' as const;
export const BEARER_PREFIX = 'Bearer ' as const;
```

### 9.2 Error Definitions (`core/errors.ts`)

```typescript
// Error Interfaces
export interface InvalidTokenError {
  readonly type: 'InvalidTokenError';
  readonly message: string;
  readonly cause?: unknown;
}

export interface TokenExpiredError {
  readonly type: 'TokenExpiredError';
  readonly message: string;
  readonly expiredAt: Date;
}

export interface TokenSignatureError {
  readonly type: 'TokenSignatureError';
  readonly message: string;
}

export interface AuthenticationRequiredError {
  readonly type: 'AuthenticationRequiredError';
  readonly message: string;
}

export interface AuthProviderError {
  readonly type: 'AuthProviderError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// Error Union
export type AuthError =
  | InvalidTokenError
  | TokenExpiredError
  | TokenSignatureError
  | AuthenticationRequiredError
  | AuthProviderError;

// Error Constructors
export const createInvalidTokenError = (message: string, cause?: unknown): InvalidTokenError => ({
  type: 'InvalidTokenError',
  message,
  cause,
});

export const createTokenExpiredError = (expiredAt: Date): TokenExpiredError => ({
  type: 'TokenExpiredError',
  message: `Token expired at ${expiredAt.toISOString()}`,
  expiredAt,
});

export const createTokenSignatureError = (message: string): TokenSignatureError => ({
  type: 'TokenSignatureError',
  message,
});

export const createAuthenticationRequiredError = (): AuthenticationRequiredError => ({
  type: 'AuthenticationRequiredError',
  message: 'Authentication required',
});

export const createAuthProviderError = (message: string, cause?: unknown): AuthProviderError => ({
  type: 'AuthProviderError',
  message,
  retryable: true,
  cause,
});

// Error Mapping
export const AUTH_ERROR_HTTP_STATUS: Record<AuthError['type'], number> = {
  InvalidTokenError: 401,
  TokenExpiredError: 401,
  TokenSignatureError: 401,
  AuthenticationRequiredError: 401,
  AuthProviderError: 503,
} as const;

export const AUTH_ERROR_GQL_CODE: Record<AuthError['type'], string> = {
  InvalidTokenError: 'UNAUTHENTICATED',
  TokenExpiredError: 'UNAUTHENTICATED',
  TokenSignatureError: 'UNAUTHENTICATED',
  AuthenticationRequiredError: 'UNAUTHENTICATED',
  AuthProviderError: 'INTERNAL_SERVER_ERROR',
} as const;
```

### 9.3 Authenticate Use Case (`core/usecases/authenticate.ts`)

```typescript
import { ok, err, type Result } from 'neverthrow';
import type { AuthError } from '../errors.js';
import type { AuthProvider } from '../ports.js';
import type { AuthContext } from '../types.js';
import { ANONYMOUS_SESSION } from '../types.js';

export interface AuthenticateDeps {
  authProvider: AuthProvider;
}

export interface AuthenticateInput {
  token: string | null;
}

export async function authenticate(
  deps: AuthenticateDeps,
  input: AuthenticateInput
): Promise<Result<AuthContext, AuthError>> {
  const { authProvider } = deps;
  const { token } = input;

  // No token = anonymous session (not an error)
  if (token === null || token === '') {
    return ok(ANONYMOUS_SESSION);
  }

  // Verify token with provider
  const sessionResult = await authProvider.verifyToken(token);

  if (sessionResult.isErr()) {
    return err(sessionResult.error);
  }

  return ok(sessionResult.value);
}
```

### 9.4 Require Auth Use Case (`core/usecases/require-auth.ts`)

```typescript
import { ok, err, type Result } from 'neverthrow';
import { createAuthenticationRequiredError, type AuthError } from '../errors.js';
import type { AuthContext, UserId } from '../types.js';
import { isAuthenticated } from '../types.js';

/**
 * Requires authentication and returns the user ID.
 * Use this in resolvers/handlers that need an authenticated user.
 */
export function requireAuth(context: AuthContext): Result<UserId, AuthError> {
  if (!isAuthenticated(context)) {
    return err(createAuthenticationRequiredError());
  }
  return ok(context.userId);
}
```

### 9.5 HTTP Token Extractor (`shell/extractors/http-extractor.ts`)

```typescript
import type { FastifyRequest } from 'fastify';
import type { SessionExtractor } from '../../core/ports.js';
import { AUTH_HEADER, BEARER_PREFIX } from '../../core/types.js';

export const httpSessionExtractor: SessionExtractor<FastifyRequest> = {
  extractToken(request: FastifyRequest): string | null {
    const authHeader = request.headers[AUTH_HEADER];

    if (typeof authHeader !== 'string') {
      return null;
    }

    if (!authHeader.startsWith(BEARER_PREFIX)) {
      return null;
    }

    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    return token !== '' ? token : null;
  },
};

export const makeHttpSessionExtractor = (): SessionExtractor<FastifyRequest> => {
  return httpSessionExtractor;
};
```

### 9.6 Fastify Auth Middleware (`shell/middleware/fastify-auth.ts`)

```typescript
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { AUTH_ERROR_HTTP_STATUS } from '../../core/errors.js';
import type { AuthContext } from '../../core/types.js';
import { httpSessionExtractor } from '../extractors/http-extractor.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export interface MakeAuthMiddlewareDeps extends AuthenticateDeps {}

/**
 * Global middleware that populates request.auth for all requests.
 * Does NOT reject anonymous requests - use requireAuthHandler for that.
 */
export const makeAuthMiddleware = (deps: MakeAuthMiddlewareDeps): preHandlerHookHandler => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = httpSessionExtractor.extractToken(request);
    const result = await authenticate(deps, { token });

    if (result.isErr()) {
      const error = result.error;
      const statusCode = AUTH_ERROR_HTTP_STATUS[error.type];
      return reply.status(statusCode).send({
        error: error.type,
        message: error.message,
      });
    }

    request.auth = result.value;
  };
};

/**
 * Route-level guard that requires authentication.
 * Use as preHandler on protected routes.
 */
export const requireAuthHandler: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const result = requireAuth(request.auth);

  if (result.isErr()) {
    return reply.status(401).send({
      error: result.error.type,
      message: result.error.message,
    });
  }
};
```

### 9.7 GraphQL Context Builder (`shell/middleware/graphql-context.ts`)

```typescript
import type { MercuriusContext } from 'mercurius';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { AUTH_ERROR_GQL_CODE, type AuthError } from '../../core/errors.js';
import type { AuthContext, UserId } from '../../core/types.js';
import { ANONYMOUS_SESSION } from '../../core/types.js';
import { httpSessionExtractor } from '../extractors/http-extractor.js';

export interface AuthenticatedMercuriusContext extends MercuriusContext {
  auth: AuthContext;
}

export interface MakeGraphQLContextDeps extends AuthenticateDeps {}

export const makeGraphQLContext = (deps: MakeGraphQLContextDeps) => {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AuthenticatedMercuriusContext> => {
    const token = httpSessionExtractor.extractToken(request);
    const result = await authenticate(deps, { token });

    // For GraphQL, don't reject - let resolvers decide
    const auth: AuthContext = result.isOk() ? result.value : ANONYMOUS_SESSION;

    return { reply, auth } as AuthenticatedMercuriusContext;
  };
};

/**
 * GraphQL error with proper extensions for auth failures.
 */
export class AuthGraphQLError extends Error {
  extensions: { code: string };

  constructor(error: AuthError) {
    super(error.message);
    this.name = 'AuthGraphQLError';
    this.extensions = { code: AUTH_ERROR_GQL_CODE[error.type] };
  }
}

/**
 * Require authentication in a resolver. Throws GraphQL error if anonymous.
 * Returns the authenticated user ID.
 */
export const requireAuthOrThrow = (auth: AuthContext): UserId => {
  const result = requireAuth(auth);
  if (result.isErr()) {
    throw new AuthGraphQLError(result.error);
  }
  return result.value;
};

/**
 * Higher-order function to wrap resolver with auth requirement.
 */
export const withAuth = <TArgs, TResult>(
  resolver: (
    parent: unknown,
    args: TArgs,
    context: AuthenticatedMercuriusContext,
    userId: UserId
  ) => Promise<TResult>
) => {
  return async (
    parent: unknown,
    args: TArgs,
    context: AuthenticatedMercuriusContext
  ): Promise<TResult> => {
    const userId = requireAuthOrThrow(context.auth);
    return resolver(parent, args, context, userId);
  };
};
```

---

## 10. Security Considerations

### 10.1 Token Handling

| Concern            | Mitigation                                        |
| :----------------- | :------------------------------------------------ |
| Token in logs      | NEVER log full tokens; log only user IDs          |
| Token in URLs      | Tokens MUST be in headers, never in query strings |
| Token transmission | REQUIRE HTTPS in production                       |

### 10.2 Error Information Leakage

| Concern      | Mitigation                                        |
| :----------- | :------------------------------------------------ |
| Stack traces | Never expose stack traces in production responses |

### 10.3 Logging Guidelines

```typescript
// CORRECT - Log user ID only
request.log.info({ userId: session.userId }, 'Request authenticated');

// WRONG - Never log tokens
request.log.info({ token }, 'Received token'); // NEVER DO THIS
```

---

## 11. Testing Requirements

### 11.1 Unit Tests (Core)

**`authenticate` use case:**

- [ ] Returns `ANONYMOUS_SESSION` when token is null
- [ ] Returns `ANONYMOUS_SESSION` when token is empty string
- [ ] Returns `AuthSession` with userId for valid token
- [ ] Returns `InvalidTokenError` for malformed token
- [ ] Returns `TokenExpiredError` for expired token

**`requireAuth` use case:**

- [ ] Returns `Ok(userId)` for authenticated session
- [ ] Returns `Err(AuthenticationRequiredError)` for anonymous session

**Type guards:**

- [ ] `isAuthenticated` returns true for AuthSession
- [ ] `isAuthenticated` returns false for AnonymousSession
- [ ] `isAnonymous` returns true for AnonymousSession
- [ ] `isAnonymous` returns false for AuthSession

### 11.2 Integration Tests (Shell)

**HTTP middleware:**

- [ ] Attaches `auth` to request for valid token
- [ ] Attaches anonymous auth for missing token
- [ ] Returns 401 for invalid token
- [ ] `requireAuthHandler` blocks anonymous access

**GraphQL context:**

- [ ] Sets `context.auth` for valid token
- [ ] Sets anonymous auth for missing/invalid token
- [ ] `requireAuthOrThrow` throws with correct error code
- [ ] `withAuth` HOF passes userId to resolver

### 11.3 In-Memory Fake Provider

```typescript
interface MakeFakeAuthProviderOptions {
  validTokens?: Map<string, string>; // token -> userId
}

export const makeFakeAuthProvider = (options: MakeFakeAuthProviderOptions = {}): AuthProvider => {
  const tokens = options.validTokens ?? new Map<string, string>();

  return {
    async verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      const userId = tokens.get(token);

      if (userId === undefined) {
        return err(createInvalidTokenError('Invalid or unknown token'));
      }

      const session: AuthSession = {
        userId: toUserId(userId),
        expiresAt: new Date(Date.now() + 3600000), // 1 hour
      };

      return ok(session);
    },
  };
};
```

---

## 12. Public API Exports

### 12.1 Types

```typescript
export type { AuthSession, AnonymousSession, AuthContext, UserId };
export type { AuthError };
export type { AuthProvider, SessionExtractor };
export type { AuthenticatedMercuriusContext };
```

### 12.2 Values

```typescript
// Constants
export { ANONYMOUS_SESSION, AUTH_HEADER, BEARER_PREFIX };

// Type constructor
export { toUserId };

// Type guards
export { isAuthenticated, isAnonymous };

// Error constructors
export {
  createInvalidTokenError,
  createTokenExpiredError,
  createTokenSignatureError,
  createAuthenticationRequiredError,
  createAuthProviderError,
};

// Error mappings
export { AUTH_ERROR_HTTP_STATUS, AUTH_ERROR_GQL_CODE };
```

### 12.3 Use Cases

```typescript
export { authenticate, type AuthenticateDeps, type AuthenticateInput };
export { requireAuth };
```

### 12.4 Shell Components

```typescript
// Adapters - JWT (Recommended)
export {
  makeJWTAdapter,
  type JWTAdapterConfig,
  type JWTAdapterDeps,
} from './shell/adapters/jwt-adapter.js';
export {
  makeCachedAuthProvider,
  type CachedAdapterConfig,
  type CacheStats,
} from './shell/adapters/cached-adapter.js';

// Adapters - Legacy/Testing
export { makeClerkAdapter } from './shell/adapters/clerk-adapter.js';
export { makeInMemoryAuthProvider } from './shell/adapters/in-memory-adapter.js';

// Extractors
export { httpSessionExtractor, makeHttpSessionExtractor };
export { mcpSessionExtractor, makeMCPSessionExtractor };

// Middleware
export { makeAuthMiddleware, requireAuthHandler };
export { makeGraphQLContext, AuthGraphQLError, requireAuthOrThrow, withAuth };
export { withMCPAuth };
```

---

## 13. Composition Root Integration

### 13.1 Required Changes to `build-app.ts`

**Recommended: JWT Adapter with Caching**

```typescript
import { jwtVerify, importSPKI } from 'jose';

import {
  makeJWTAdapter,
  makeCachedAuthProvider,
  makeGraphQLContext,
  type AuthProvider,
} from '@/modules/auth/index.js';

export interface AppDeps {
  // ... existing deps
  authProvider?: AuthProvider;
}

export const buildApp = async (options: AppOptions = {}): Promise<FastifyInstance> => {
  // Create auth provider with caching (recommended for production)
  let authProvider: AuthProvider | undefined = deps.authProvider;

  if (authProvider === undefined && config.auth.clerkJwtKey !== undefined) {
    const jwtAdapter = makeJWTAdapter({
      jwtVerify,
      importSPKI,
      publicKeyPEM: config.auth.clerkJwtKey,
      authorizedParties: config.auth.clerkAuthorizedParties,
    });

    // Wrap with LRU cache for performance
    authProvider = makeCachedAuthProvider({
      provider: jwtAdapter,
      maxCacheSize: 1000,
      cacheTTLMs: 5 * 60 * 1000, // 5 minutes
    });
  }

  // Create GraphQL context builder with auth (optional)
  const graphQLContext =
    authProvider !== undefined ? makeGraphQLContext({ authProvider }) : undefined;

  // Register GraphQL with optional auth context
  await app.register(mercurius, {
    schema,
    resolvers,
    loaders,
    context: graphQLContext,
  });

  // ... rest of app setup
};
```

**Legacy: Clerk SDK Adapter**

```typescript
import { verifyToken } from '@clerk/backend';
import { makeClerkAdapter } from '@/modules/auth/index.js';

const authProvider = makeClerkAdapter({ verifyToken });
```

### 13.2 Environment Variables

| Variable                   | Required | Description                       | Example                |
| :------------------------- | :------- | :-------------------------------- | :--------------------- |
| `CLERK_JWT_KEY`            | Yes\*    | PEM public key for JWT verify     | `-----BEGIN PUBLIC...` |
| `CLERK_SECRET_KEY`         | No       | Clerk API secret (legacy adapter) | `sk_test_xxx`          |
| `CLERK_AUTHORIZED_PARTIES` | No       | Comma-separated allowed audiences | `app1.com,app2.com`    |

\*Required for JWT adapter; `CLERK_SECRET_KEY` required for legacy Clerk adapter

---

## 14. Implementation Checklist

### Phase 1: Core Module ✅

- [x] Create `src/modules/auth/core/types.ts`
- [x] Create `src/modules/auth/core/errors.ts`
- [x] Create `src/modules/auth/core/ports.ts`
- [x] Create `src/modules/auth/core/usecases/authenticate.ts`
- [x] Create `src/modules/auth/core/usecases/require-auth.ts`

### Phase 2: Shell Adapters ✅

- [x] Install `jose` dependency (recommended)
- [x] Create `src/modules/auth/shell/adapters/jwt-adapter.ts` (recommended)
- [x] Create `src/modules/auth/shell/adapters/cached-adapter.ts` (performance)
- [x] Create `src/modules/auth/shell/adapters/clerk-adapter.ts` (legacy)
- [x] Create `src/modules/auth/shell/adapters/in-memory-adapter.ts` (testing)

### Phase 3: Extractors ✅

- [x] Create `src/modules/auth/shell/extractors/http-extractor.ts`
- [x] Create `src/modules/auth/shell/extractors/mcp-extractor.ts`

### Phase 4: Middleware ✅

- [x] Create `src/modules/auth/shell/middleware/fastify-auth.ts`
- [x] Create `src/modules/auth/shell/middleware/graphql-context.ts`
- [x] Create `src/modules/auth/shell/middleware/mcp-auth.ts`

### Phase 5: Public API ✅

- [x] Create `src/modules/auth/index.ts`

### Phase 6: Integration ✅

- [x] Update `src/infra/config/env.ts` with auth config
- [x] Update `src/app/build-app.ts` to wire auth module (optional auth)
- [x] Update `src/infra/graphql/index.ts` for context builder support

### Phase 7: Testing ✅

- [x] Create `tests/unit/auth/authenticate.test.ts` (11 tests)
- [x] Create `tests/unit/auth/require-auth.test.ts` (6 tests)
- [x] Create `tests/unit/auth/jwt-adapter.test.ts` (21 tests)
- [x] Create `tests/unit/auth/cached-adapter.test.ts` (9 tests)
- [x] Create `tests/unit/auth/in-memory-adapter.test.ts` (16 tests)
- [x] Update `tests/fixtures/builders.ts` with auth helpers
- [x] Update `tests/golden-master/client.ts` for auth support

### Phase 8: Validation ✅

- [x] Run `pnpm typecheck` - Pass
- [x] Run `pnpm lint` - Pass
- [x] Run `pnpm test` - 847 tests passing
- [x] Run `pnpm ci` - Pass

---

## 15. Future Enhancements

The following features are explicitly out of scope for v3.1 but may be added later:

| Feature                  | Description                                     |
| :----------------------- | :---------------------------------------------- |
| **Role-Based Access**    | Add roles (user, admin) with permission mapping |
| **Permission System**    | Fine-grained permissions (entity:read, etc.)    |
| **User Profile Storage** | Store user metadata in our database             |
| **Session Management**   | List active sessions, revoke sessions           |

When adding roles, extend `AuthSession`:

```typescript
// Future: Add roles to session
interface AuthSession {
  readonly userId: UserId;
  readonly roles: readonly Role[]; // Add this
  readonly expiresAt: Date;
}
```

---

## 16. Migration Path

### 16.1 From Clerk to Another Provider

1. **Create new adapter** implementing `AuthProvider` interface
2. **Update composition root** to use new adapter factory
3. **Update environment variables** for new provider

### 16.2 Estimated Effort

| Change                  | Files Changed | Lines of Code |
| :---------------------- | :------------ | :------------ |
| New adapter             | 1             | ~50-80        |
| Composition root update | 1             | ~5            |
| Environment config      | 1             | ~5            |
| **Total**               | **3**         | **~70**       |

---

## 17. Dependencies

### 17.1 New Dependencies

**Recommended (JWT Adapter):**

```json
{
  "dependencies": {
    "jose": "^5.x.x"
  }
}
```

**Legacy (Clerk SDK Adapter):**

```json
{
  "dependencies": {
    "@clerk/backend": "^1.x.x"
  }
}
```

### 17.2 Existing Dependencies Used

- `neverthrow` - Result type for error handling
- `fastify` - HTTP server and plugin system
- `mercurius` - GraphQL adapter

### 17.3 Why jose over @clerk/backend?

| Aspect         | jose                           | @clerk/backend     |
| :------------- | :----------------------------- | :----------------- |
| Bundle size    | ~50KB                          | ~200KB+            |
| Vendor lock-in | None (standard JWT)            | Clerk-specific     |
| Network calls  | None (local verification)      | May call Clerk API |
| Dependencies   | Zero runtime deps              | Multiple deps      |
| Standards      | RFC 7519 (JWT), RFC 7517 (JWK) | Proprietary        |

The `jose` library provides pure JWT verification using Clerk's PEM public key, eliminating vendor lock-in while maintaining full compatibility.

---

## 18. References

- [AUTH-MODULE-LEGACY.md](./AUTH-MODULE-LEGACY.md) - Historical implementation reference
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Functional Core / Imperative Shell pattern
- [CORE-SHELL-ARCHITECTURE.md](./CORE-SHELL-ARCHITECTURE.md) - Module implementation guide
- [MODULE-DEPENDENCIES.md](./MODULE-DEPENDENCIES.md) - Import rules and boundaries
- Clerk Documentation: https://clerk.com/docs
