<spec>
# Share Module (Short Links) - Detailed Specification

This specification documents the share/short-links module for migration to a new codebase.

---

## 1. Overview

The share module provides URL shortening functionality for creating shareable links to application content. It uses deterministic hashing to generate short codes, ensuring the same URL always produces the same short link.

### Architecture Pattern

```
Client Request
    ↓
Route Handler (/api/v1/short-links)
    ↓
ShortLinkService (Business Logic)
    ├─ Domain Validation (whitelist check)
    ├─ Rate Limiting (per-user daily limit)
    ├─ Code Generation (SHA-512 + SHA-256 + Base64URL)
    └─ Collision Detection
    ↓
ShortLinkRepository (Data Access)
    ↓
Database (ShortLinks table)
```

### Key Features

- **Deterministic code generation**: Same URL always produces the same short code
- **Multi-user association**: Multiple users can own the same short link
- **Domain whitelisting**: Only approved client URLs can be shortened
- **Rate limiting**: Per-user daily creation limits
- **Collision detection**: Handles hash collisions gracefully
- **Access analytics**: Tracks resolution count and last access time
- **Canonical URL matching**: Normalizes URLs for consistent deduplication

---

## 2. Database Schema

### ShortLinks Table

```sql
CREATE TABLE IF NOT EXISTS ShortLinks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_ids TEXT[] NOT NULL,
  original_url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shortlinks_user_ids ON ShortLinks USING GIN(user_ids);
CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON ShortLinks(code);
CREATE INDEX IF NOT EXISTS idx_shortlinks_original_url ON ShortLinks(original_url);
CREATE INDEX IF NOT EXISTS idx_shortlinks_created_at ON ShortLinks(created_at);
```

### Column Details

| Column           | Type        | Constraints             | Description                                   |
| ---------------- | ----------- | ----------------------- | --------------------------------------------- |
| `id`             | BIGSERIAL   | PRIMARY KEY             | Auto-incrementing identifier                  |
| `code`           | TEXT        | UNIQUE, NOT NULL        | 16-character short code                       |
| `user_ids`       | TEXT[]      | NOT NULL                | Array of user IDs who created this link       |
| `original_url`   | TEXT        | UNIQUE, NOT NULL        | The original full URL                         |
| `created_at`     | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp                            |
| `access_count`   | INTEGER     | NOT NULL, DEFAULT 0     | Number of times link was resolved             |
| `last_access_at` | TIMESTAMPTZ | NULL                    | Last resolution timestamp                     |
| `metadata`       | JSONB       | DEFAULT '{}'            | URL metadata (path + normalized query params) |

### Index Purpose

| Index                         | Type   | Purpose                              |
| ----------------------------- | ------ | ------------------------------------ |
| `idx_shortlinks_code`         | B-tree | Fast code lookups during resolution  |
| `idx_shortlinks_original_url` | B-tree | Fast URL lookups for deduplication   |
| `idx_shortlinks_user_ids`     | GIN    | Efficient user association queries   |
| `idx_shortlinks_created_at`   | B-tree | Rate limiting queries (recent links) |

---

## 3. Type Definitions

### 3.1 Data Model

```typescript
interface ShortLink {
  id: number;
  code: string;
  user_ids: string[];
  original_url: string;
  created_at: Date;
  access_count: number;
  last_access_at?: Date | null;
  metadata?: Record<string, unknown> | null;
}

interface CreateShortLinkInput {
  code: string;
  userId: string;
  originalUrl: string;
  metadata?: Record<string, unknown> | null;
}
```

### 3.2 Metadata Structure

```typescript
// Canonical URL metadata for collision detection
interface UrlMetadata {
  path: string; // URL pathname
  query: Record<string, string | string[]>; // Sorted, deduplicated query params
}
```

### 3.3 Service Response Types

```typescript
// Create short link result
type CreateResult =
  | { success: true; code: string }
  | { success: false; error: string; status: number };

// Resolve short link result
type ResolveResult =
  | { success: true; url: string }
  | { success: false; error: string; status: number };

// Rate limit check result
interface RateLimitResult {
  allowed: boolean;
  error?: string;
}

// Validation result
type ValidationResult<T> = { success: true; data: T } | { success: false; error: string };
```

### 3.4 Custom Errors

```typescript
class ShortLinkCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortLinkCollisionError';
  }
}
```

---

## 4. Constants

```typescript
// Maximum URL length (Chrome compatibility)
const MAX_URL_LENGTH = 2_097_152; // 2MB

// Short code length
const MAX_CODE_LENGTH = 16;

// Default daily limit per user
const DEFAULT_DAILY_LIMIT = 100;
```

---

## 5. Code Generation Algorithm

### 5.1 Double-Hashing Process

```typescript
static generateCode(url: string, salt: string = ""): string {
  // Step 1: SHA-512 hash of URL + optional salt
  const intermediateHash = createHash("sha512")
    .update(url + salt)
    .digest("hex");

  // Step 2: SHA-256 hash of intermediate result
  const finalHash = createHash("sha256")
    .update(intermediateHash)
    .digest("base64url");

  // Step 3: Take first 16 characters
  return finalHash.substring(0, MAX_CODE_LENGTH);
}
```

### 5.2 Algorithm Properties

| Property      | Value                            |
| ------------- | -------------------------------- |
| Input         | URL string + optional salt       |
| First Hash    | SHA-512 (128 hex chars)          |
| Second Hash   | SHA-256 (43 base64url chars)     |
| Output        | First 16 characters of base64url |
| Character Set | `[A-Za-z0-9_-]`                  |
| Deterministic | Yes (same input = same output)   |

### 5.3 Code Pattern

```
Pattern: ^[A-Za-z0-9_-]{16}$
Example: "Xk9mN2pQ4rS5tU6v"
```

---

## 6. URL Canonicalization

### 6.1 Metadata Building

```typescript
private static buildCanonicalMetadata(url: string): UrlMetadata {
  const urlObject = new URL(url);

  // Get unique, sorted query param keys
  const keys = Array.from(new Set(
    Array.from(urlObject.searchParams.keys())
  ));
  keys.sort();

  // Build normalized query params
  const queryParams: Record<string, string | string[]> = {};
  for (const key of keys) {
    const allValues = urlObject.searchParams.getAll(key).map(String);

    if (allValues.length <= 1) {
      queryParams[key] = allValues[0] ?? "";
    } else {
      // Multi-value params: deduplicate and sort
      const deduped = Array.from(new Set(allValues));
      deduped.sort();
      queryParams[key] = deduped;
    }
  }

  return {
    path: urlObject.pathname,
    query: queryParams,
  };
}
```

### 6.2 Canonicalization Rules

1. **Query param keys**: Sorted alphabetically
2. **Multi-value params**: Deduplicated and sorted
3. **Empty values**: Preserved as empty string
4. **Path**: Extracted as-is from URL

### 6.3 Equivalent URLs Example

```
// These URLs produce the same canonical metadata:
https://example.com/page?b=2&a=1
https://example.com/page?a=1&b=2

// Canonical metadata:
{
  "path": "/page",
  "query": { "a": "1", "b": "2" }
}
```

---

## 7. Domain Validation

### 7.1 Whitelist Check

```typescript
static isApprovedClientUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const allowed = new Set<string>();

    // Build whitelist from environment
    const origins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    origins.forEach((o) => allowed.add(o));

    if (process.env.CLIENT_BASE_URL) {
      allowed.add(process.env.CLIENT_BASE_URL.trim());
    }
    if (process.env.PUBLIC_CLIENT_BASE_URL) {
      allowed.add(process.env.PUBLIC_CLIENT_BASE_URL.trim());
    }

    // Check origin (protocol + host)
    const origin = `${urlObj.protocol}//${urlObj.host}`;
    return allowed.has(origin);
  } catch {
    return false;
  }
}
```

### 7.2 Whitelist Sources

| Source                   | Priority | Description                     |
| ------------------------ | -------- | ------------------------------- |
| `ALLOWED_ORIGINS`        | 1        | Comma-separated list of origins |
| `CLIENT_BASE_URL`        | 2        | Primary client application URL  |
| `PUBLIC_CLIENT_BASE_URL` | 3        | Public-facing client URL        |

---

## 8. Rate Limiting

### 8.1 Implementation

```typescript
static async checkRateLimit(userId: string): Promise<RateLimitResult> {
  const limit = parseInt(process.env.SHORT_LINK_DAILY_LIMIT || "100", 10);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);  // 24 hours ago

  const count = await shortLinkRepository.countRecentLinksForUser(userId, since);

  if (count >= limit) {
    return {
      allowed: false,
      error: "Daily limit reached for creating short links."
    };
  }

  return { allowed: true };
}
```

### 8.2 Rate Limit Parameters

| Parameter   | Default  | Env Variable             | Description                |
| ----------- | -------- | ------------------------ | -------------------------- |
| Daily Limit | 100      | `SHORT_LINK_DAILY_LIMIT` | Max links per user per 24h |
| Window      | 24 hours | -                        | Rolling window             |

---

## 9. REST API Endpoints

### 9.1 Create Short Link

```
POST /api/v1/short-links
Authorization: Required (JWT)
Content-Type: application/json

Request Body:
{
  "url": "https://app.example.com/analytics?filter=abc&period=2024"
}

Success Response (200):
{
  "ok": true,
  "data": {
    "code": "Xk9mN2pQ4rS5tU6v"
  }
}

Error Responses:
- 400: Invalid body / URL not allowed
- 401: Unauthorized
- 429: Daily limit reached
- 500: Hash collision / Internal error
```

### 9.2 Resolve Short Link

```
GET /api/v1/short-links/:code
Authorization: Not required

Path Parameters:
- code: 16-character short code (pattern: ^[A-Za-z0-9_-]{16}$)

Success Response (200):
{
  "ok": true,
  "data": {
    "url": "https://app.example.com/analytics?filter=abc&period=2024"
  }
}

Error Responses:
- 400: Invalid code format
- 404: Short link not found
```

---

## 10. Service Methods

### 10.1 ShortLinkService

| Method                  | Signature                               | Description                          |
| ----------------------- | --------------------------------------- | ------------------------------------ |
| `generateCode`          | `(url, salt?) → string`                 | Generate 16-char deterministic code  |
| `isApprovedClientUrl`   | `(url) → boolean`                       | Check if URL is from approved domain |
| `checkRateLimit`        | `(userId) → Promise<RateLimitResult>`   | Check user's daily quota             |
| `validateCreateRequest` | `(body) → ValidationResult<{url}>`      | Validate creation request            |
| `validateCodeParams`    | `(params) → ValidationResult<{code}>`   | Validate resolution params           |
| `createShortLink`       | `(userId, url) → Promise<CreateResult>` | Create or reuse short link           |
| `resolveShortLink`      | `(code) → Promise<ResolveResult>`       | Resolve code to original URL         |

### 10.2 Creation Flow

```
createShortLink(userId, url)
    ↓
1. Generate code from URL
    ↓
2. Build canonical metadata
    ↓
3. Check if code exists in DB
    ├─ Yes + Same URL → Update user association
    ├─ Yes + Same Config → Reuse existing link
    ├─ Yes + Different Config → Return collision error
    └─ No → Create new record
    ↓
4. Return { success: true, code }
```

### 10.3 Resolution Flow

```
resolveShortLink(code)
    ↓
1. Look up code in DB
    ├─ Not found → Return 404
    └─ Found → Continue
    ↓
2. Fire-and-forget: Increment access stats
    ↓
3. Return { success: true, url }
```

---

## 11. Repository Methods

### 11.1 ShortLinkRepository

| Method                    | Signature                                      | Description                           |
| ------------------------- | ---------------------------------------------- | ------------------------------------- |
| `createOrUpdate`          | `(input) → Promise<ShortLink>`                 | Create new or update user association |
| `getByCode`               | `(code, client?) → Promise<ShortLink \| null>` | Look up by short code                 |
| `getByOriginalUrl`        | `(url, client?) → Promise<ShortLink \| null>`  | Look up by original URL               |
| `countRecentLinksForUser` | `(userId, since) → Promise<number>`            | Count recent links for rate limiting  |
| `incrementAccessStats`    | `(code) → Promise<void>`                       | Update access count and timestamp     |

### 11.2 createOrUpdate Logic

```
1. Check if link exists for original URL
   ├─ Yes → Add userId to user_ids array if not present
   └─ No → Continue
       ↓
2. Check if code already exists (collision check)
   ├─ Yes → Throw ShortLinkCollisionError
   └─ No → Insert new record
```

---

## 12. Utility Function

### makeShareLink

```typescript
/**
 * Creates a shareable short link for a given full client URL.
 * Falls back to the original URL on failure.
 */
async function makeShareLink(
  fullUrl: string,
  options?: { userId?: string; context?: string }
): Promise<string> {
  const clientBase = (
    process.env.PUBLIC_CLIENT_BASE_URL ||
    process.env.CLIENT_BASE_URL ||
    ''
  ).replace(/\/$/, '');

  const userId = options?.userId || 'mcp-system';

  try {
    const res = await ShortLinkService.createShortLink(userId, fullUrl);
    if (res.success) {
      return `${clientBase || 'https://transparenta.eu'}/share/${res.code}`;
    }
    // Log and fall back to original URL
    console.warn(`Short link creation failed: ${res.error}`);
    return fullUrl;
  } catch (error) {
    console.error(`Short link error: ${error}`);
    return fullUrl;
  }
}
```

### Usage Pattern

```typescript
// In AI service or other places needing shareable links
const shareUrl = await makeShareLink('https://transparenta.eu/entities/12345?period=2024-01', {
  userId: 'user_123',
  context: 'entity-details',
});
// Returns: "https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v"
// Or falls back to original URL on failure
```

---

## 13. Configuration

### Environment Variables

| Variable                 | Required | Default | Description                      |
| ------------------------ | -------- | ------- | -------------------------------- |
| `ALLOWED_ORIGINS`        | No       | -       | Comma-separated approved origins |
| `CLIENT_BASE_URL`        | Yes      | -       | Primary client application URL   |
| `PUBLIC_CLIENT_BASE_URL` | No       | -       | Public-facing client URL         |
| `SHORT_LINK_DAILY_LIMIT` | No       | `100`   | Max links per user per day       |

### Example Configuration

```bash
# .env
ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
CLIENT_BASE_URL=https://app.example.com
PUBLIC_CLIENT_BASE_URL=https://www.example.com
SHORT_LINK_DAILY_LIMIT=100
```

---

## 14. Error Handling

### Error Types

| Error                | HTTP Status | Cause                         |
| -------------------- | ----------- | ----------------------------- |
| Invalid body         | 400         | Malformed JSON or missing URL |
| URL not allowed      | 400         | URL not from approved domain  |
| Invalid code format  | 400         | Code doesn't match pattern    |
| Unauthorized         | 401         | Missing or invalid auth token |
| Short link not found | 404         | Code doesn't exist in DB      |
| Daily limit reached  | 429         | User exceeded rate limit      |
| Hash collision       | 500         | Two URLs produced same code   |

### Response Format

```typescript
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "Error message" }
```

---

## 15. Analytics

### Tracked Metrics

| Metric        | Column           | Update Trigger          |
| ------------- | ---------------- | ----------------------- |
| Access Count  | `access_count`   | Each resolution         |
| Last Access   | `last_access_at` | Each resolution         |
| Creation Time | `created_at`     | On creation             |
| User IDs      | `user_ids`       | On creation/association |

### Fire-and-Forget Update

```typescript
// Analytics update doesn't block response
shortLinkRepository.incrementAccessStats(code).catch(() => {
  // Silently fail - stats are not critical
});
```

---

## 16. Security Features

| Feature                | Description                         |
| ---------------------- | ----------------------------------- |
| Domain Whitelisting    | Only approved URLs can be shortened |
| Rate Limiting          | Per-user daily creation limits      |
| Input Validation       | URL format and length validation    |
| Deterministic Codes    | Prevents enumeration attacks        |
| Double Hashing         | SHA-512 + SHA-256 for security      |
| Collision Detection    | Prevents data corruption            |
| No Auth for Resolution | Public links work without login     |

---

## 17. File Inventory

| File                                         | Purpose                          |
| -------------------------------------------- | -------------------------------- |
| `src/routes/short-links.ts`                  | HTTP API endpoints               |
| `src/services/short-link.ts`                 | Business logic service           |
| `src/db/repositories/shortLinkRepository.ts` | Data access layer                |
| `src/schemas/short-links.ts`                 | Fastify validation schemas       |
| `src/utils/shortLink.ts`                     | Utility wrapper for easy sharing |
| `src/db/schema-userdata.sql`                 | Database table definition        |

---

## 18. Integration Points

### Used By

- **AI Basic Service** (`src/services/ai-basic.ts`): Creates shareable links for:
  - Entity details
  - Functional budget views
  - Economic budget views
  - Budget analysis
  - Analytics charts
  - Analytics hierarchies
  - Entity analytics lists

### Share URL Format

```
{PUBLIC_CLIENT_BASE_URL}/share/{code}

Example:
https://transparenta.eu/share/Xk9mN2pQ4rS5tU6v
```

---

## 19. Migration Considerations

### Required Setup

1. **Database**: Create `ShortLinks` table in userdata database
2. **Environment**: Configure domain whitelist variables
3. **Client Integration**: Set up `/share/:code` route on client

### Migration Checklist

- [ ] Create ShortLinks table with indexes
- [ ] Configure `ALLOWED_ORIGINS` environment variable
- [ ] Configure `CLIENT_BASE_URL` environment variable
- [ ] Configure `PUBLIC_CLIENT_BASE_URL` if different
- [ ] Set `SHORT_LINK_DAILY_LIMIT` if needed
- [ ] Implement `/share/:code` route on client application
- [ ] Test short link creation with authenticated user
- [ ] Test short link resolution (public)
- [ ] Verify rate limiting works correctly
- [ ] Test domain validation rejects unauthorized URLs

### Client Route Implementation

```typescript
// Client-side route handler for /share/:code
async function handleShareRoute(code: string) {
  const response = await fetch(`${API_URL}/api/v1/short-links/${code}`);
  const result = await response.json();

  if (result.ok) {
    // Redirect to original URL
    window.location.href = result.data.url;
  } else {
    // Show error page
    showError('Link not found');
  }
}
```

---

## 20. Testing

### Manual Testing

```bash
# Create short link (requires auth token)
curl -X POST http://localhost:3000/api/v1/short-links \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://app.example.com/page?param=value"}'

# Response: {"ok":true,"data":{"code":"Xk9mN2pQ4rS5tU6v"}}

# Resolve short link (no auth required)
curl http://localhost:3000/api/v1/short-links/Xk9mN2pQ4rS5tU6v

# Response: {"ok":true,"data":{"url":"https://app.example.com/page?param=value"}}
```

### Test Cases

1. **Deterministic codes**: Same URL produces same code
2. **Domain validation**: Unauthorized URLs are rejected
3. **Rate limiting**: Excess requests return 429
4. **Multi-user association**: Second user gets same code for same URL
5. **Collision handling**: Different URLs with same hash handled
6. **Analytics**: Access count increments on resolution

</spec>

I want you to review the following specification file from the old codebase and write a new specification for this module. We should plan this in a way that we can migrate the code to the new codebase, but keeping the external api interfaces.

You can also have a look at some old code in the old_code_repositories folder: /Users/claudiuconstantinbogdan/projects/devostack/transparenta-eu/transparenta-eu-server/old_code_repositories/share.

Focus the specification on the following:

- What problem is trying to solve this module
- Why we made some design decisions
- What are some assumptions we made
- What are some limitations we may have
- High level architecture, without overwhelming the user with technical details
