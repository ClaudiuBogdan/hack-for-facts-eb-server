# Share Module Specification

## Module Purpose

The Share module provides URL shortening functionality that enables users to create compact, shareable links to application content. This is essential for a data-intensive platform where URLs often contain complex query parameters representing filters, time periods, and visualization states.

---

## Key Decisions Summary

| Decision           | Choice                                        | Rationale                                 |
| ------------------ | --------------------------------------------- | ----------------------------------------- |
| Database           | User database                                 | Alongside notifications, user preferences |
| Expiration         | No expiration                                 | Simpler; permanent links                  |
| Rate limiting      | Per-user daily (100/day)                      | Prevents abuse without complexity         |
| API style          | REST only                                     | Simpler, cacheable GETs                   |
| System tools       | Pass-through user identity                    | No special system user needed             |
| Collision handling | Return error (fail safe)                      | Explicit failure over silent issues       |
| URL normalization  | Yes (canonical form)                          | Same view = same link                     |
| Response format    | `{ ok, data/error }` (legacy)                 | Backward compatible with existing clients |
| Caching            | Redis cache-aside (24h TTL)                   | Performance for read-heavy resolution     |
| Hasher             | Shared port (reuse from common/notifications) | Testable, consistent across modules       |

---

## 1. Problem Statement

### 1.1 The Challenge

Budget analytics URLs in Transparenta.eu are often long and unwieldy:

```
https://transparenta.eu/entities/12345678/analytics?
  period=2020-01..2024-12&
  fundingSource=1,2,3&
  classification=economic&
  normalization=cpi&
  view=chart&
  selectedMetrics=approved,executed,difference
```

These URLs are:

- **Hard to share** in emails, chat, or social media (truncation, broken links)
- **Ugly** when displayed to users
- **Problematic** for AI assistants that need to provide actionable links

### 1.2 What We Need

A way to transform complex URLs into short, stable links:

```
https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v
```

---

## 2. Design Decisions

### 2.1 Deterministic Code Generation with URL Normalization

**Decision**: Same URL (after normalization) always produces the same short code.

**Rationale**:

- **Deduplication**: Prevents database bloat when multiple users share the same view
- **Same view = same link**: `?a=1&b=2` and `?b=2&a=1` produce identical codes
- **Predictability**: Makes debugging and testing straightforward
- **No enumeration attacks**: Cannot guess codes sequentially (unlike auto-increment IDs)

**Normalization rules**:

- Query parameters sorted alphabetically by key
- Multi-value parameters deduplicated and sorted
- Original URL stored for resolution (user sees what they shared)

**Trade-off**: Slightly more complex collision handling vs. simpler random codes.

### 2.2 Double-Hashing Algorithm (SHA-512 → SHA-256 → Base64URL)

**Decision**: Use two cryptographic hashes in sequence, then encode to URL-safe Base64.

```
URL → SHA-512(hex) → SHA-256(base64url) → first 16 chars
```

**Rationale**:

- **Security**: SHA-512 provides strong avalanche effect; SHA-256 adds mixing
- **URL-safe**: Base64URL uses only `[A-Za-z0-9_-]` — no escaping needed
- **Compact**: 16 characters provides ~96 bits of entropy (collision-resistant for our scale)

**Trade-off**: Computational overhead of two hashes is negligible; security and uniformity justify it.

### 2.3 Multi-User Association (Not Ownership)

**Decision**: Multiple users can "own" the same short link via `user_ids[]` array.

**Rationale**:

- A popular dashboard URL shouldn't create duplicate entries
- Rate limiting applies per-user while sharing the underlying record
- Audit trail shows all users who created a given link

**Trade-off**: Slightly more complex repository logic; simpler data model overall.

### 2.4 Domain Whitelisting

**Decision**: Only URLs from approved client domains can be shortened.

**Rationale**:

- **Security**: Prevents abuse as an open redirector (phishing, malware distribution)
- **Focus**: This is a feature for our application, not a public URL shortener
- **Trust**: Users clicking our short links stay within our ecosystem

**Trade-off**: Requires configuration; cannot be used for arbitrary external URLs.

### 2.5 REST-Only API (No GraphQL)

**Decision**: Expose short links via REST endpoints, not GraphQL.

**Rationale**:

- **Simplicity**: Create and resolve are simple CRUD operations
- **Caching**: GET requests for resolution benefit from HTTP caching
- **Integration**: AI assistants and external tools expect REST for simple operations
- **No relationships**: Short links don't have complex relational queries

**Trade-off**: Different API style from analytics queries; justified by use case.

### 2.6 Fire-and-Forget Analytics

**Decision**: Access statistics (count, last access) are updated asynchronously without blocking the response.

**Rationale**:

- **Performance**: Resolution should be as fast as possible
- **Reliability**: A failed stats update shouldn't break link resolution
- **Simplicity**: No need for transactional consistency on analytics

**Trade-off**: Stats may be slightly behind; acceptable for analytics purposes.

---

## 3. Assumptions

### 3.1 URL Stability

We assume the client application's URL structure is stable. If URL patterns change:

- Existing short links may point to broken pages
- No automatic migration is provided

### 3.2 Client-Side Resolution

The client application handles the `/share/:code` route and:

1. Calls the server API to resolve the code
2. Redirects to the resolved URL

The server does **not** perform HTTP redirects — it returns the URL in JSON.

### 3.3 User Identity

- Authenticated users are identified by their auth provider ID (e.g., Clerk `sub` claim)
- System processes (MCP tools, AI assistants) pass through the authenticated user's identity
- Anonymous users cannot create short links (resolution is public)

### 3.4 Database Availability

The module requires the user database to be available. There is no offline fallback or caching for writes. Resolution could be cached in the future if needed.

### 3.5 Collision Rarity

With 16 Base64URL characters (~96 bits), collisions are statistically improbable at our scale. The system handles collisions gracefully but doesn't expect them in practice.

---

## 4. Limitations

### 4.1 No Link Expiration

Short links are permanent. There is no TTL or automatic cleanup.

**Future consideration**: Add `expires_at` column if ephemeral links are needed.

### 4.2 No Link Editing

Once created, a short link cannot be updated to point to a different URL.

**Rationale**: Deterministic codes mean the URL is part of the identity.

### 4.3 No Custom Codes (Vanity URLs)

Users cannot choose their own short codes (e.g., `share/my-budget-2024`).

**Rationale**: Adds complexity (uniqueness checks, moderation) with limited value.

### 4.4 No Bulk Operations

No batch creation or resolution endpoints.

**Future consideration**: Add batch resolution for AI tools that process multiple links.

### 4.5 Rate Limit is Per-User, Not Global

Heavy load from many users could still stress the system. Consider global rate limiting at the infrastructure level (nginx, CDN) for production.

### 4.6 No Click Analytics Beyond Count

We track access count and last access time. We don't track:

- Geographic location
- Referrer source
- Device type
- Time-series access patterns

**Rationale**: Keep it simple; GDPR/privacy compliance by default.

---

## 5. High-Level Architecture

### 5.1 Module Structure

```
src/modules/share/
├── core/
│   ├── types.ts          # ShortLink, CreateInput, UrlMetadata, constants
│   ├── errors.ts         # DomainError union, error constructors
│   ├── ports.ts          # ShortLinkRepository, Hasher, Cache interfaces
│   ├── url-utils.ts      # Pure URL normalization functions
│   └── usecases/
│       ├── create-short-link.ts    # Core creation logic (uses Hasher port)
│       ├── resolve-short-link.ts   # Core resolution logic
│       └── make-share-link.ts      # Utility for other modules
│
├── shell/
│   ├── repo/
│   │   └── short-link-repo.ts      # Kysely implementation
│   ├── rest/
│   │   ├── routes.ts               # Fastify route handlers
│   │   └── schemas.ts              # TypeBox request/response schemas
│   └── cache/
│       └── redis-cache.ts          # Redis cache adapter
│
└── index.ts              # Public API exports
```

**Note**: The `Hasher` port is shared with the notifications module. Consider extracting to `common/` or a shared crypto module if not already available.

### 5.2 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT                                  │
│                                                                 │
│  User clicks "Share" → POST /api/v1/short-links { url }         │
│  User visits /share/Xk9m... → GET /api/v1/short-links/:code     │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    REST ROUTES (Shell)                          │
│                                                                 │
│  • Validate request (TypeBox schemas)                           │
│  • Check authentication (create requires auth)                  │
│  • Validate domain whitelist (create only)                      │
│  • Check rate limit (create only, per-user daily quota)         │
│  • Call use case                                                │
│  • Map Result to HTTP response                                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    USE CASES (Core)                             │
│                                                                 │
│  createShortLink:                                               │
│    1. Normalize URL (pure - sort query params)                  │
│    2. Generate code via Hasher port (injected)                  │
│    3. Build canonical metadata (pure)                           │
│    4. Delegate to repository                                    │
│                                                                 │
│  resolveShortLink:                                              │
│    1. Check cache (via Cache port)                              │
│    2. If miss: fetch from repository, populate cache            │
│    3. Trigger async stats update (fire-and-forget)              │
│    4. Return original URL                                       │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    REPOSITORY (Shell)                           │
│                                                                 │
│  • Kysely queries to user database                              │
│  • Handle upsert with user association                          │
│  • Collision detection (same code, different URL)               │
│  • Rate limit counting (recent links per user)                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                        ┌────────┴────────┐
                        │                 │
                        ▼                 ▼
┌───────────────────────────┐  ┌───────────────────────────────┐
│   DATABASE (PostgreSQL)   │  │      CACHE (Redis)            │
│                           │  │                               │
│   ShortLinks table        │  │   code → originalUrl          │
│   in user database        │  │   TTL: 24h (configurable)     │
└───────────────────────────┘  └───────────────────────────────┘
```

### 5.3 Key Interfaces

```typescript
// Domain Type
interface ShortLink {
  id: number;
  code: string; // 16-char base64url
  userIds: string[]; // Users who created this link
  originalUrl: string; // Full URL
  createdAt: Date;
  accessCount: number;
  lastAccessAt: Date | null;
  metadata: UrlMetadata | null;
}

interface UrlMetadata {
  path: string;
  query: Record<string, string | string[]>;
}

// Repository Port (Core defines, Shell implements)
interface ShortLinkRepository {
  getByCode(code: string): Promise<Result<ShortLink | null, DatabaseError>>;
  getByOriginalUrl(url: string): Promise<Result<ShortLink | null, DatabaseError>>;
  createOrAssociateUser(input: CreateInput): Promise<Result<ShortLink, ShortLinkError>>;
  countRecentForUser(userId: string, since: Date): Promise<Result<number, DatabaseError>>;
  incrementAccessStats(code: string): Promise<Result<void, DatabaseError>>;
}

// Hasher Port (shared with notifications module)
// Injected to keep core pure and testable
interface Hasher {
  hash(input: string): string; // Returns hex digest
}

// Cache Port (optional - for Redis caching)
interface ShortLinkCache {
  get(code: string): Promise<string | null>; // Returns originalUrl or null
  set(code: string, originalUrl: string): Promise<void>;
}
```

### 5.4 Error Handling

| Domain Error        | HTTP Status | When                               |
| ------------------- | ----------- | ---------------------------------- |
| `UrlNotAllowed`     | 400         | URL not from approved domain       |
| `InvalidInput`      | 400         | Malformed URL or code              |
| `RateLimitExceeded` | 429         | User exceeded daily quota          |
| `HashCollision`     | 500         | Two URLs produced same code (rare) |
| `NotFound`          | 404         | Code doesn't exist                 |
| `DatabaseError`     | 500         | Query failed                       |

**Collision handling**: On the extremely rare event of a hash collision (same code for different URLs), the system returns an explicit error (fail-safe). No automatic retry with salts — collisions warrant investigation.

### 5.5 Validation Responsibilities

| Check               | Location                   | Rationale                               |
| ------------------- | -------------------------- | --------------------------------------- |
| URL format          | Shell (TypeBox schema)     | Input validation is shell concern       |
| Domain whitelist    | Shell (route handler)      | Config-based, not business logic        |
| Rate limit          | Shell (route handler)      | Infrastructure concern, keeps core pure |
| URL normalization   | Core (use case)            | Business logic for deduplication        |
| Code generation     | Core (use case via Hasher) | Business logic, injected for testing    |
| Collision detection | Shell (repository)         | Database concern                        |

---

## 6. External API Contract

### 6.1 Create Short Link

```http
POST /api/v1/short-links
Authorization: Bearer <token>
Content-Type: application/json

{ "url": "https://transparenta.eu/entities/12345?period=2024" }
```

**Response (200)**:

```json
{ "ok": true, "data": { "code": "Xk9mN2pQ4rS5tU6v" } }
```

### 6.2 Resolve Short Link

```http
GET /api/v1/short-links/Xk9mN2pQ4rS5tU6v
```

**Response (200)**:

```json
{ "ok": true, "data": { "url": "https://transparenta.eu/entities/12345?period=2024" } }
```

### 6.3 Share URL Format

The client constructs share URLs as:

```
{PUBLIC_CLIENT_BASE_URL}/share/{code}
```

Example: `https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v`

### 6.4 Utility Function

The module exposes a convenience function for other modules to create share links:

```typescript
/**
 * Creates a shareable short link with graceful fallback.
 * Returns the original URL if short link creation fails.
 */
async function makeShareLink(
  deps: { shortLinkRepo: ShortLinkRepository; config: ShareConfig },
  input: { url: string; userId: string }
): Promise<string>;
```

**Usage in other modules**:

```typescript
// In AI service or report generator
const shareUrl = await makeShareLink(deps, {
  url: 'https://transparenta.eu/entities/12345?period=2024',
  userId: context.auth.userId,
});
// Returns: "https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v"
// Or falls back to original URL on any failure
```

This function never throws — it logs errors and returns the original URL as fallback.

---

## 7. Configuration

| Variable                 | Required | Default           | Description                         |
| ------------------------ | -------- | ----------------- | ----------------------------------- |
| `ALLOWED_ORIGINS`        | No       | -                 | Comma-separated approved origins    |
| `CLIENT_BASE_URL`        | Yes      | -                 | Primary client URL                  |
| `PUBLIC_CLIENT_BASE_URL` | No       | `CLIENT_BASE_URL` | Public-facing URL                   |
| `SHORT_LINK_DAILY_LIMIT` | No       | `100`             | Max links per user per 24h          |
| `SHORT_LINK_CACHE_TTL`   | No       | `86400` (24h)     | Cache TTL in seconds for resolution |
| `REDIS_URL`              | No       | -                 | Redis URL for caching (optional)    |

**Implementation note**: Add `SHORT_LINK_DAILY_LIMIT` and `SHORT_LINK_CACHE_TTL` to `infra/config/env.ts`.

---

## 8. Database Schema

```sql
-- User database (not budget database)
CREATE TABLE IF NOT EXISTS short_links (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_ids TEXT[] NOT NULL,
  original_url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_short_links_code ON short_links(code);
CREATE INDEX idx_short_links_original_url ON short_links(original_url);
CREATE INDEX idx_short_links_user_ids ON short_links USING GIN(user_ids);
CREATE INDEX idx_short_links_created_at ON short_links(created_at);
```

---

## 9. Data Migration

### 9.1 Existing Data

There is existing short link data in the old system that needs to be migrated. The migration should:

1. **Export existing records** from the old `ShortLinks` table
2. **Verify data integrity** — ensure codes are unique and URLs are valid
3. **Import to new table** — insert into `short_links` table in user database
4. **Validate migration** — compare record counts and spot-check resolution

### 9.2 Migration Script Considerations

- Run during maintenance window (short links are non-critical)
- Use batch inserts for performance
- Handle any schema differences (e.g., column naming conventions)
- Log any records that fail validation

---

## 10. Implementation Checklist

### Infrastructure

- [ ] Add `SHORT_LINK_DAILY_LIMIT` to `infra/config/env.ts` (optional, default 100)
- [ ] Add `SHORT_LINK_CACHE_TTL` to `infra/config/env.ts` (optional, default 86400)
- [ ] Verify `short_links` table exists in user database (already defined in types)

### Core Layer

- [ ] `core/types.ts` — ShortLink, UrlMetadata, CreateInput, constants
- [ ] `core/errors.ts` — Error types and constructors
- [ ] `core/ports.ts` — ShortLinkRepository, ShortLinkCache interfaces
- [ ] `core/url-utils.ts` — Pure URL normalization functions
- [ ] `core/usecases/create-short-link.ts` — Creation logic with Hasher port
- [ ] `core/usecases/resolve-short-link.ts` — Resolution with cache
- [ ] `core/usecases/make-share-link.ts` — Utility for other modules

### Shell Layer

- [ ] `shell/repo/short-link-repo.ts` — Kysely implementation
- [ ] `shell/cache/redis-cache.ts` — Redis cache adapter (optional)
- [ ] `shell/rest/schemas.ts` — TypeBox request/response schemas
- [ ] `shell/rest/routes.ts` — Fastify route handlers

### Integration

- [ ] `index.ts` — Public API exports
- [ ] Wire routes in `app/build-app.ts`
- [ ] Reuse or extract shared Hasher (check notifications module)

### Testing

- [ ] Unit tests for URL normalization (pure functions)
- [ ] Unit tests for use cases with fakes
- [ ] Integration tests for REST endpoints

### Migration & Verification

- [ ] Migrate existing data from old system (if needed)
- [ ] Verify client `/share/:code` route exists
- [ ] End-to-end test with authenticated user

---

## 11. Future Considerations

| Feature                  | Complexity | Value  | Notes                       |
| ------------------------ | ---------- | ------ | --------------------------- |
| Link expiration          | Low        | Medium | Add `expires_at` column     |
| Batch resolution         | Low        | Medium | For AI multi-link responses |
| QR code generation       | Medium     | Low    | Could be client-side        |
| Custom aliases           | High       | Low    | Requires moderation         |
| Link analytics dashboard | High       | Medium | Time-series, geography      |

---

## 12. Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Overall system architecture
- [CORE-SHELL-ARCHITECTURE.md](./CORE-SHELL-ARCHITECTURE.md) — Implementation patterns
- [AUTH-MODULE-SPEC.md](./AUTH-MODULE-SPEC.md) — Authentication integration
