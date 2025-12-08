# Authentication Layer - Legacy Specification

> **Historical Reference**: This document describes the legacy authentication implementation
> from a previous codebase. It is preserved for reference during migration.
> For the current specification, see [AUTH-MODULE-SPEC.md](./AUTH-MODULE-SPEC.md).

This specification documents the authentication layer for migration to a new codebase.

---

## 1. Overview

The authentication system uses **Clerk as the identity provider** with **JWT-based token verification**. It's built on Fastify with GraphQL (Mercurius) support. The implementation is lightweight and networkless, using Clerk's backend package for local token verification without API calls.

### Architecture Pattern

```
Client Request
    ↓
CORS Validation (origin whitelist)
    ↓
Rate Limiting (IP/API key based)
    ↓
Route Handler
    ↓
Authentication Hook (preHandler)
    ├─ Token Extraction (Bearer header / session cookie)
    ├─ JWT Verification (Clerk verifyToken)
    └─ Auth Context Attachment (request.auth)
    ↓
Route Logic (access request.auth.userId)
    ↓
Error Handler (UnauthorizedError → 401)
```

### Key Features

- Stateless JWT verification (no database session store)
- Networkless token validation using Clerk's public key
- Dual token sources: Bearer header and session cookie
- Type-safe auth context throughout the application
- GraphQL context integration for resolver access
- Authorized parties validation (CORS equivalent for JWTs)
- Graceful error handling with standardized responses

---

## 2. Dependencies

| Package               | Version   | Purpose                                                |
| --------------------- | --------- | ------------------------------------------------------ |
| `@clerk/backend`      | `^2.19.0` | JWT token verification                                 |
| `@clerk/fastify`      | `^2.4.42` | Clerk Fastify plugin (available but not directly used) |
| `fastify`             | `^5.6.1`  | Web framework                                          |
| `@fastify/cors`       | `^11.1.0` | CORS handling                                          |
| `@fastify/rate-limit` | -         | Request rate limiting                                  |
| `@fastify/helmet`     | -         | Security headers                                       |
| `mercurius`           | `^16.5.0` | GraphQL plugin                                         |

---

## 3. Configuration

### 3.1 Environment Variables

| Variable                    | Required | Default                         | Description                                              |
| --------------------------- | -------- | ------------------------------- | -------------------------------------------------------- |
| `CLERK_JWT_KEY`             | Yes      | `""`                            | Clerk's JWT public key for verification                  |
| `CLERK_AUTHORIZED_PARTIES`  | No       | Falls back to `CLIENT_BASE_URL` | Comma-separated list of authorized origins               |
| `CLIENT_BASE_URL`           | No       | -                               | Client application URL (fallback for authorized parties) |
| `PUBLIC_CLIENT_BASE_URL`    | No       | -                               | Public client URL (fallback for authorized parties)      |
| `ALLOWED_ORIGINS`           | No       | -                               | Comma-separated CORS allowed origins                     |
| `RATE_LIMIT_MAX`            | No       | `300`                           | Maximum requests per time window                         |
| `RATE_LIMIT_WINDOW`         | No       | `"1 minute"`                    | Rate limit time window                                   |
| `SPECIAL_RATE_LIMIT_KEY`    | No       | `""`                            | API key for elevated rate limits                         |
| `SPECIAL_RATE_LIMIT_HEADER` | No       | `"x-api-key"`                   | Header name for API key                                  |
| `SPECIAL_RATE_LIMIT_MAX`    | No       | `6000`                          | Max requests for special API key                         |

### 3.2 Configuration Object

```typescript
// src/config/index.ts

export const config = {
  // Auth config (Clerk) - using JWT public key for networkless verification
  clerkJwtKey: process.env.CLERK_JWT_KEY || '',
  clerkAuthorizedParties: (
    process.env.CLERK_AUTHORIZED_PARTIES ||
    process.env.CLIENT_BASE_URL ||
    process.env.PUBLIC_CLIENT_BASE_URL ||
    ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Rate limiting
  rateLimitMax: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 300,
  rateLimitTimeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
  specialRateLimitKey: process.env.SPECIAL_RATE_LIMIT_KEY || '',
  specialRateLimitHeader: (process.env.SPECIAL_RATE_LIMIT_HEADER || 'x-api-key').toLowerCase(),
  specialRateLimitMax: process.env.SPECIAL_RATE_LIMIT_MAX
    ? parseInt(process.env.SPECIAL_RATE_LIMIT_MAX, 10)
    : 60 * 100, // 100 req/sec = 6000 req/min
};
```

---

## 4. Type Definitions

### 4.1 Fastify Request Augmentation

```typescript
// src/types/fastify.d.ts

import 'fastify';

declare module 'fastify' {
  export interface FastifyRequest {
    auth?: {
      userId: string;
    } | null;
  }
}
```

### 4.2 Auth Context Type

```typescript
// Implicit type from getAuthContext return
type AuthContext = {
  userId: string;
} | null;
```

### 4.3 GraphQL Context Type

```typescript
// Context passed to all GraphQL resolvers
interface GraphQLContext {
  auth: AuthContext;
}
```

---

## 5. Core Implementation

### 5.1 Token Extraction

```typescript
// src/utils/auth.ts

import type { FastifyRequest } from 'fastify';

/**
 * Extracts JWT token from request
 * Priority: 1) Authorization Bearer header, 2) __session cookie
 */
export function extractToken(request: FastifyRequest): string | null {
  // Try Authorization header first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Fall back to session cookie (Clerk's default cookie name)
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const sessionCookie = cookieHeader.split(';').find((c) => c.trim().startsWith('__session='));
    if (sessionCookie) {
      const parts = sessionCookie.split('=');
      if (parts.length > 1) return parts[1];
    }
  }

  return null;
}
```

### 5.2 Auth Context Resolution

```typescript
// src/utils/auth.ts

import { verifyToken } from '@clerk/backend';
import config from '../config';

/**
 * Verifies JWT and extracts user context
 * Returns null if verification fails (no exception thrown)
 */
export async function getAuthContext(request: FastifyRequest): Promise<{ userId: string } | null> {
  // Skip if no JWT key configured
  if (!config.clerkJwtKey) return null;

  const token = extractToken(request);
  if (!token) return null;

  try {
    const payload = await verifyToken(token, {
      jwtKey: config.clerkJwtKey,
      authorizedParties: config.clerkAuthorizedParties?.length
        ? config.clerkAuthorizedParties
        : undefined,
    });

    // Extract userId from JWT subject claim
    return payload.sub ? { userId: payload.sub } : null;
  } catch (error: any) {
    // Log at debug level (not error) since invalid tokens are expected
    request.log.debug({ error: error.message }, 'JWT verification failed');
    return null;
  }
}
```

### 5.3 Authentication Hook

```typescript
// src/utils/auth-hook.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from './errors';
import { getAuthContext } from './auth';

/**
 * Fastify preHandler hook for route protection
 * Attaches auth context to request and throws if missing
 */
export async function authenticate(request: FastifyRequest, _: FastifyReply): Promise<void> {
  try {
    const auth = await getAuthContext(request);
    request.auth = auth;

    if (!auth) {
      throw new UnauthorizedError('Unauthorized');
    }
  } catch (error) {
    request.log.error(error, 'Authentication hook failed');
    throw error;
  }
}
```

---

## 6. Error Handling

### 6.1 Custom Error Classes

```typescript
// src/utils/errors.ts

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

export class ValidationError extends Error {
  issues: Array<{ path: string; message: string; code: string }>;

  constructor(
    message: string,
    issues: Array<{ path: string; message: string; code: string }> = []
  ) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
```

### 6.2 Global Error Handler

```typescript
// src/plugins/errors.ts

import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../utils/errors';

export async function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    // Handle authentication errors
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({
        ok: false,
        error: error.message || 'Unauthorized',
      });
      return;
    }

    // Log and return generic error for unhandled cases
    request.log.error(error);
    reply.status(500).send({
      ok: false,
      error: 'Internal Server Error',
    });
  });
}
```

### 6.3 Error Response Format

```typescript
// Standard error response structure
interface ErrorResponse {
  ok: false;
  error: string;
  details?: Array<{ path: string; message: string; code: string }>;
}

// HTTP Status Codes
// 401 Unauthorized - Missing or invalid authentication
// 403 Forbidden - Valid auth but insufficient permissions
// 500 Internal Server Error - Unhandled errors
```

---

## 7. CORS Configuration

```typescript
// src/plugins/cors.ts

import type { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import config from '../config';

function getAllowedOriginsSet(): Set<string> {
  const set = new Set<string>();

  // Parse ALLOWED_ORIGINS env var
  const raw = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  raw.forEach((u) => set.add(u));

  // Add client URLs as allowed origins
  if (process.env.CLIENT_BASE_URL) {
    set.add(process.env.CLIENT_BASE_URL.trim());
  }
  if (process.env.PUBLIC_CLIENT_BASE_URL) {
    set.add(process.env.PUBLIC_CLIENT_BASE_URL.trim());
  }

  return set;
}

export async function registerCors(fastify: FastifyInstance) {
  const allowedOrigins = getAllowedOriginsSet();

  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow server-to-server or same-origin requests (no origin header)
      if (!origin) return cb(null, true);

      // Allow everything in non-production environments
      if (config.nodeEnv !== 'production') return cb(null, true);

      // Check against whitelist in production
      if (allowedOrigins.has(origin)) return cb(null, true);

      return cb(new Error('CORS origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'x-requested-with',
      'authorization', // JWT Bearer token
      'x-api-key', // API key for rate limiting
      'accept',
      'mcp-session-id',
      'last-event-id',
    ],
    exposedHeaders: ['content-length', 'mcp-session-id', 'Mcp-Session-Id'],
    credentials: true, // Allow cookies to be sent
  });
}
```

---

## 8. Rate Limiting

```typescript
// src/plugins/ratelimit.ts

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import config from '../config';

export async function registerRateLimit(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    // Dynamic max based on API key
    max: (req, _res) => {
      const headerName = config.specialRateLimitHeader;
      const provided = String(req.headers[headerName] || '').trim();

      // Elevated limit for valid API key
      if (provided && config.specialRateLimitKey && provided === config.specialRateLimitKey) {
        return config.specialRateLimitMax; // 6000 req/min default
      }

      return config.rateLimitMax; // 300 req/min default
    },

    timeWindow: config.rateLimitTimeWindow,

    // Identity based on API key or IP
    keyGenerator: (req) => {
      const headerName = config.specialRateLimitHeader;
      const provided = String(req.headers[headerName] || '').trim();

      // Use API key as identity if provided
      if (provided) return `apiKey:${provided}`;

      // Fall back to IP address
      return req.ip;
    },
  });
}
```

### Rate Limit Tiers

| Tier       | Identifier                   | Max Requests | Time Window |
| ---------- | ---------------------------- | ------------ | ----------- |
| Standard   | IP address                   | 300          | 1 minute    |
| Privileged | API key (`x-api-key` header) | 6000         | 1 minute    |

---

## 9. GraphQL Integration

```typescript
// src/plugins/mercurius.ts

import type { FastifyInstance, FastifyRequest } from 'fastify';
import mercurius from 'mercurius';
import { getAuthContext } from '../utils/auth';
import config from '../config';
import { schema } from '../graphql/schemas';
import depthLimit from 'graphql-depth-limit';
import { NoSchemaIntrospectionCustomRule } from 'graphql';

export async function registerMercurius(fastify: FastifyInstance) {
  await fastify.register(mercurius, {
    schema,
    graphiql: config.nodeEnv !== 'production',
    ide: false,
    path: '/graphql',

    // Security rules
    validationRules:
      config.nodeEnv === 'production'
        ? [depthLimit(8), NoSchemaIntrospectionCustomRule]
        : [depthLimit(8)],

    allowBatchedQueries: false,

    // Auth context injected into all resolvers
    context: async (request) => {
      const auth = await getAuthContext(request);
      return { auth };
    },
  });
}
```

### GraphQL Resolver Usage

```typescript
// Example resolver accessing auth context
const resolvers = {
  Query: {
    myNotifications: async (_, args, context) => {
      const { auth } = context;

      if (!auth) {
        throw new Error('Unauthorized');
      }

      return notificationService.getUserNotifications(auth.userId);
    },
  },
};
```

### GraphQL Security Features

| Feature              | Development | Production |
| -------------------- | ----------- | ---------- |
| GraphiQL Playground  | Enabled     | Disabled   |
| Schema Introspection | Enabled     | Disabled   |
| Query Depth Limit    | 8 levels    | 8 levels   |
| Batched Queries      | Disabled    | Disabled   |

---

## 10. Server Initialization

```typescript
// src/server.ts

import Fastify from 'fastify';
import config from './config';
import { registerHelmet } from './plugins/helmet';
import { registerCors } from './plugins/cors';
import { registerRateLimit } from './plugins/rateLimit';
import { registerSwagger } from './plugins/swagger';
import { registerMercurius } from './plugins/mercurius';
import applicationRoutes from './routes';
import { registerErrorHandler } from './plugins/errors';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.nodeEnv === 'development' ? 'info' : 'error',
    },
    bodyLimit: 1_000_000, // 1MB max body size
    maxParamLength: 200, // Max URL parameter length
    trustProxy: true, // Trust X-Forwarded-* headers
  });

  // Plugin registration order matters!
  await registerHelmet(fastify); // 1. Security headers
  await registerCors(fastify); // 2. CORS validation
  await registerRateLimit(fastify); // 3. Rate limiting
  await registerMercurius(fastify); // 4. GraphQL with auth context
  await registerSwagger(fastify); // 5. API documentation
  await registerErrorHandler(fastify); // 6. Error handling
  await fastify.register(applicationRoutes); // 7. Routes

  return fastify;
}
```

### Plugin Registration Order

| Order | Plugin        | Purpose                            |
| ----- | ------------- | ---------------------------------- |
| 1     | Helmet        | Security headers (CSP, HSTS, etc.) |
| 2     | CORS          | Origin validation                  |
| 3     | Rate Limit    | Request throttling                 |
| 4     | Mercurius     | GraphQL with auth context          |
| 5     | Swagger       | API documentation                  |
| 6     | Error Handler | Standardized error responses       |
| 7     | Routes        | Application endpoints              |

---

## 11. Route Protection Patterns

### 11.1 Protected REST Endpoint

```typescript
// src/routes/notifications.ts

import { authenticate } from '../utils/auth-hook';

export default async function notificationRoutes(fastify: FastifyInstance) {
  await fastify.register(async function (fastify) {
    // Protected endpoint - requires authentication
    fastify.post(
      '/api/v1/notifications',
      {
        preHandler: [authenticate], // Auth hook
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;

        // Double-check (authenticate already throws if null)
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        // Route logic with authenticated userId
        const notification = await notificationService.subscribe(
          userId
          // ... other params
        );

        return reply.code(200).send({ ok: true, data: notification });
      }
    );
  });
}
```

### 11.2 Public REST Endpoint

```typescript
// Public endpoint - no auth required
fastify.get('/api/v1/short-links/:code', async (request: FastifyRequest, reply: FastifyReply) => {
  // No preHandler auth hook
  // Route is accessible without authentication
  const { code } = request.params;
  const link = await shortLinkService.resolve(code);
  return reply.code(200).send({ ok: true, data: link });
});
```

### 11.3 Optional Auth Endpoint

```typescript
// Optional auth - works with or without authentication
fastify.get('/api/v1/analytics/public', async (request: FastifyRequest, reply: FastifyReply) => {
  // Manually get auth context (doesn't throw)
  const auth = await getAuthContext(request);

  if (auth) {
    // Authenticated user - return personalized data
    return reply.send({
      ok: true,
      data: await getPersonalizedAnalytics(auth.userId),
    });
  }

  // Anonymous user - return public data only
  return reply.send({
    ok: true,
    data: await getPublicAnalytics(),
  });
});
```

### 11.4 Ownership Verification

```typescript
// Verify user owns the resource
fastify.delete(
  '/api/v1/notifications/:id',
  {
    preHandler: [authenticate],
  },
  async (request, reply) => {
    const userId = request.auth?.userId;
    const { id } = request.params;

    // Fetch resource and verify ownership
    const notification = await notificationsRepository.findById(id);

    if (!notification) {
      return reply.code(404).send({ ok: false, error: 'Not found' });
    }

    if (notification.userId !== userId) {
      return reply.code(403).send({ ok: false, error: 'Forbidden' });
    }

    // User owns resource - proceed with deletion
    await notificationService.deleteNotification(id);
    return reply.code(200).send({ ok: true });
  }
);
```

---

## 12. JWT Token Structure

### 12.1 Clerk JWT Claims

```typescript
interface ClerkJWTPayload {
  // Standard claims
  sub: string; // User ID (e.g., "user_2NNEqL2nrIRdJ194ndJqAHwEfxC")
  iss: string; // Issuer (Clerk instance URL)
  aud: string | string[]; // Audience (authorized parties)
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  nbf: number; // Not before timestamp

  // Clerk-specific claims
  azp: string; // Authorized party (client URL)

  // Optional user metadata
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}
```

### 12.2 Token Verification Options

```typescript
// Clerk verifyToken options used
const verificationOptions = {
  jwtKey: config.clerkJwtKey, // Public key for signature verification
  authorizedParties: [
    // Valid client origins
    'https://app.example.com',
    'https://www.example.com',
  ],
};
```

---

## 13. Security Features Summary

| Feature            | Implementation                     | Notes                            |
| ------------------ | ---------------------------------- | -------------------------------- |
| Token Verification | Clerk `verifyToken()`              | Networkless, uses public key     |
| Authorized Parties | JWT `azp` claim validation         | Prevents token theft across apps |
| Token Sources      | Bearer header + `__session` cookie | Flexible client integration      |
| CORS               | Whitelist-based in production      | Permissive in development        |
| Rate Limiting      | IP-based with API key override     | 300 req/min standard             |
| Security Headers   | Helmet plugin                      | CSP, HSTS, X-Frame-Options       |
| GraphQL Security   | Depth limit, no introspection      | Production hardening             |
| Error Handling     | Standardized responses             | No sensitive data leaked         |
| Logging            | Debug level for auth failures      | Prevents log flooding            |

---

## 14. Protected Endpoints Summary

| Route                                      | Method | Auth                 | Description               |
| ------------------------------------------ | ------ | -------------------- | ------------------------- |
| `/api/v1/notifications`                    | POST   | Required             | Subscribe to notification |
| `/api/v1/notifications`                    | GET    | Required             | List user's notifications |
| `/api/v1/notifications/:id`                | PATCH  | Required + Ownership | Update notification       |
| `/api/v1/notifications/:id`                | DELETE | Required + Ownership | Delete notification       |
| `/api/v1/notifications/entity/:cui`        | GET    | Required             | Get entity notifications  |
| `/api/v1/notifications/deliveries`         | GET    | Required             | View delivery history     |
| `/api/v1/notifications/unsubscribe/:token` | GET    | Token-based          | Unsubscribe via email     |
| `/api/v1/short-links`                      | POST   | Required             | Create short link         |
| `/api/v1/short-links/:code`                | GET    | None                 | Resolve short link        |
| `/graphql`                                 | POST   | Optional (context)   | GraphQL endpoint          |

---

## 15. File Inventory

| File                       | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `src/utils/auth.ts`        | Token extraction and JWT verification          |
| `src/utils/auth-hook.ts`   | Fastify authentication preHandler hook         |
| `src/utils/errors.ts`      | Custom error classes (UnauthorizedError, etc.) |
| `src/types/fastify.d.ts`   | Fastify request type augmentation              |
| `src/config/index.ts`      | Configuration including auth settings          |
| `src/plugins/errors.ts`    | Global error handler plugin                    |
| `src/plugins/cors.ts`      | CORS configuration plugin                      |
| `src/plugins/ratelimit.ts` | Rate limiting plugin                           |
| `src/plugins/mercurius.ts` | GraphQL plugin with auth context               |
| `src/plugins/helmet.ts`    | Security headers plugin                        |
| `src/server.ts`            | Server initialization and plugin registration  |

---

## 16. Migration Considerations

### 16.1 Required Setup

1. **Clerk Account**: Create Clerk application and obtain JWT public key
2. **Environment Variables**: Configure all auth-related env vars
3. **Client Integration**: Ensure client sends Bearer token or uses Clerk session cookies

### 16.2 Clerk JWT Key Setup

```bash
# Get JWT public key from Clerk Dashboard:
# Dashboard > JWT Templates > Get Public Key

# Add to environment
CLERK_JWT_KEY="-----BEGIN PUBLIC KEY-----\nMIIBI....\n-----END PUBLIC KEY-----"

# Or use JWKS URL (requires network call)
# The current implementation uses direct public key (networkless)
```

### 16.3 Alternative Auth Providers

If migrating away from Clerk, replace:

1. `verifyToken()` call in `src/utils/auth.ts`
2. Token extraction logic if cookie name differs
3. JWT claims mapping (`sub` → `userId`)

### 16.4 Migration Checklist

- [ ] Set up Clerk account and application
- [ ] Obtain JWT public key from Clerk dashboard
- [ ] Configure `CLERK_JWT_KEY` environment variable
- [ ] Configure `CLERK_AUTHORIZED_PARTIES` with client URLs
- [ ] Set up `ALLOWED_ORIGINS` for CORS
- [ ] Configure rate limiting parameters if needed
- [ ] Test token verification with Clerk-issued JWTs
- [ ] Verify protected endpoints return 401 without token
- [ ] Verify protected endpoints work with valid token
- [ ] Test GraphQL context auth injection
- [ ] Verify ownership checks work correctly

---

## 17. Testing Authentication

### 17.1 Manual Testing

```bash
# Test without token (should return 401)
curl -X GET http://localhost:3000/api/v1/notifications

# Test with Bearer token
curl -X GET http://localhost:3000/api/v1/notifications \
  -H "Authorization: Bearer <clerk_jwt_token>"

# Test GraphQL with auth
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <clerk_jwt_token>" \
  -d '{"query": "{ myNotifications { id } }"}'
```

### 17.2 Expected Responses

```json
// 401 Unauthorized (no/invalid token)
{
  "ok": false,
  "error": "Unauthorized"
}

// 403 Forbidden (valid token, wrong owner)
{
  "ok": false,
  "error": "Forbidden"
}

// 200 Success (valid token)
{
  "ok": true,
  "data": { ... }
}
```
