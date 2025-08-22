# Short Links API v1 Specification

## Overview

The Short Links API allows authenticated users to create and resolve shortened URLs for approved client applications. This service provides deterministic short link generation, ensuring that identical URLs always produce the same short code.

### Key Features

- **Deterministic Generation**: Same URL always produces the same short code
- **User Association**: Multiple users can be associated with the same short link
- **URL Validation**: Only approved client domains are allowed
- **Rate Limiting**: Per-user daily limits prevent abuse
- **Analytics**: Access tracking and statistics

### Base URL

```
https://api.example.com/api/v1
```

## Quick Start

### Example Usage Flow

1. **Create a short link**:

   ```bash
   curl -X POST https://api.example.com/api/v1/short-links \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://app.example.com/dashboard?user=123&tab=overview"}'
   ```

   Response:

   ```json
   {
     "ok": true,
     "data": {
       "code": "aBc123XyZ456789A",
     }
   }
   ```

2. **Resolve the short link**:

   ```bash
   curl https://api.example.com/api/v1/short-links/aBc123XyZ456789A
   ```

   Response:

   ```json
   {
     "ok": true,
     "data": {
       "url": "https://app.example.com/dashboard?user=123&tab=overview"
     }
   }
   ```

## API Endpoints

### 1. Create Short Link

**Endpoint**: `POST /api/v1/short-links`

Creates a deterministic short link for an approved URL. If the URL was previously shortened, returns the existing short link and associates the current user with it.

#### Request

- **Authentication**: Required (Bearer token)
- **Content-Type**: `application/json`
- **Body**:

  ```json
  {
    "url": "https://app.example.com/page?id=123"
  }
  ```

#### Response

**Success (200 OK)**:

```json
{
  "ok": true,
  "data": {
    "code": "aBc123XyZ456789A",
  }
}
```

**Error Responses**:

- `400 Bad Request`: Invalid URL format, URL too long, or not an approved domain
- `401 Unauthorized`: Missing or invalid authentication
- `429 Too Many Requests`: User exceeded daily creation limit
- `500 Internal Server Error`: Hash collision or system error

### 2. Resolve Short Link

**Endpoint**: `GET /api/v1/short-links/:code`

Resolves a short link code and returns the original URL. Increments access statistics.

#### Request

- **Authentication**: Not required
- **Parameters**:
  - `code` (path): 16-character short link code

#### Response

**Success (200 OK)**:

```json
{
  "ok": true,
  "data": {
    "url": "https://app.example.com/page?id=123"
  }
}
```

**Error Responses**:

- `400 Bad Request`: Invalid code format
- `404 Not Found`: Short link code not found

## Authentication & Authorization

### Authentication Methods

- **Bearer Token**: JWT token in `Authorization` header
- **Session Cookie**: `__session` cookie (fallback method)

### Authorization Rules

- **Creation endpoint**: Requires valid authentication
- **Resolution endpoint**: Public access (no authentication required)
- **User Association**: Users are automatically associated with links they create or recreate

## Rate Limiting

### Creation Endpoint Limits

- **Scope**: Per-user daily limit
- **Default Limit**: 100 links per 24-hour period
- **Configuration**: `SHORT_LINK_DAILY_LIMIT` environment variable
- **Reset**: Rolling 24-hour window from first creation
- **Response**: `429 Too Many Requests` when limit exceeded

### Rate Limit Headers

Response headers include rate limit information:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1640995200
```

## URL Validation & Security

### Approved Domains

Only URLs from pre-approved client domains are accepted:

- **Configuration**: Set via environment variables
  - `ALLOWED_ORIGINS`: Comma-separated list of allowed origins
  - `CLIENT_BASE_URL`: Primary client application URL
  - `PUBLIC_CLIENT_BASE_URL`: Public-facing client URL

- **Validation Logic**:

  ```javascript
  // Allowed origins example
  ALLOWED_ORIGINS="https://app.example.com,https://dashboard.example.com"
  CLIENT_BASE_URL="https://app.example.com"
  ```

### URL Constraints

- **Maximum Length**: 2048 characters
- **Format**: Valid URL with protocol (https:// or http://)
- **Domain Restriction**: Must match approved client domains

### Security Features

- **Input Sanitization**: URL validation and length limits
- **Domain Whitelisting**: Only approved domains accepted
- **Deterministic Generation**: Prevents enumeration attacks
- **Access Logging**: All resolutions are tracked

## Short Link Generation

### Algorithm

The system uses a **double-hashing approach** for enhanced collision resistance:

1. **Stage 1 - SHA-512**: Generate SHA-512 hash of the original URL for maximum entropy
2. **Stage 2 - SHA-256**: Generate SHA-256 hash of the Stage 1 output  
3. **Encoding**: Base64URL encoding of the final hash
4. **Truncation**: First 16 characters become the short code
5. **Pattern**: `[A-Za-z0-9_-]{16}`

This cascaded approach makes hash collisions astronomically unlikely while maintaining deterministic behavior.

### Deterministic Behavior

- **Same Input → Same Output**: Identical URLs always produce identical codes
- **Collision Handling**: System detects and rejects hash collisions
- **Uniqueness**: Each URL has exactly one associated short code

### Example Generation

```
URL: https://app.example.com/page?id=123

Stage 1 (SHA-512):
Input: https://app.example.com/page?id=123
SHA-512: a1b2c3d4e5f6789abc123def456...128chars

Stage 2 (SHA-256):
Input: a1b2c3d4e5f6789abc123def456...128chars  
SHA-256: xyz789abc123def456...64chars

Final:
Base64URL: aBc123XyZ456789A1B2C3D4E5F6...
Code: aBc123XyZ456789A (first 16 chars)
```

## Business Logic

### Link Creation Flow

1. **Authentication Check**: Verify user authentication
2. **Rate Limit Check**: Ensure user hasn't exceeded daily limit
3. **URL Validation**: Verify URL format and approved domain
4. **Code Generation**: Generate deterministic short code
5. **Collision Detection**: Check for hash collisions
6. **Database Operation**: Create new link or associate user with existing link
7. **Response**: Return short code and full short URL

### Link Resolution Flow

1. **Code Validation**: Verify code format and length
2. **Database Lookup**: Find link by short code
3. **Analytics Update**: Increment access count (fire-and-forget)
4. **Response**: Return original URL

### Multi-User Association

When a URL is shortened:

- **First Time**: Creates new short link, associates creating user
- **Subsequent Times**: Returns existing short link, adds new user to association list
- **User Tracking**: Multiple users can be associated with the same short link
- **Analytics**: All users' creations count toward the same link statistics

## Data Model

### ShortLinks Table

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| `id` | `BIGSERIAL` | Primary key | NOT NULL, AUTO INCREMENT |
| `code` | `TEXT` | 16-character short code | NOT NULL, UNIQUE |
| `user_ids` | `TEXT[]` | Array of associated user IDs | NOT NULL |
| `original_url` | `TEXT` | Original URL | NOT NULL, UNIQUE |
| `created_at` | `TIMESTAMPTZ` | Creation timestamp | NOT NULL, DEFAULT NOW() |
| `access_count` | `INTEGER` | Resolution count | NOT NULL, DEFAULT 0 |
| `last_access_at` | `TIMESTAMPTZ` | Last resolution time | NULL |
| `metadata` | `JSONB` | URL components (path, query) | DEFAULT '{}' |

### Indexes

- `idx_shortlinks_code`: Fast code lookups
- `idx_shortlinks_original_url`: Fast URL lookups
- `idx_shortlinks_user_ids`: GIN index for user association queries
- `idx_shortlinks_created_at`: Rate limiting queries

### Metadata Structure

```json
{
  "path": "/dashboard",
  "query": {
    "user": "123",
    "tab": "overview"
  }
}
```

## Error Handling

### Error Response Format

All errors follow a consistent format:

```json
{
  "ok": false,
  "error": "Error description",
  "code": "ERROR_CODE",
  "details": {
    "field": "specific error details"
  }
}
```

### Error Codes

#### 400 Bad Request

- **Invalid URL**: Malformed URL or unsupported protocol
- **URL Too Long**: Exceeds 2048 character limit
- **Domain Not Allowed**: URL domain not in approved list
- **Invalid Code Format**: Code doesn't match required pattern

#### 401 Unauthorized

- **Missing Token**: No authentication provided
- **Invalid Token**: Token expired or malformed
- **Token Verification Failed**: Unable to verify token signature

#### 404 Not Found

- **Short Link Not Found**: Code doesn't exist in database

#### 429 Too Many Requests

- **Rate Limit Exceeded**: User exceeded daily creation limit
- **Headers**: Include rate limit information

#### 500 Internal Server Error

- **Hash Collision**: Extremely rare collision detected
- **Database Error**: System unavailable

## Configuration

### Environment Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|----------|
| `SHORT_LINK_DAILY_LIMIT` | Per-user daily creation limit | `100` | `500` |
| `ALLOWED_ORIGINS` | Comma-separated approved domains | - | `https://app.example.com,https://admin.example.com` |
| `CLIENT_BASE_URL` | Primary client application URL | - | `https://app.example.com` |
| `PUBLIC_CLIENT_BASE_URL` | Public client URL | - | `https://example.com` |
| `PUBLIC_API_BASE_URL` | API base URL for short link generation | - | `https://api.example.com` |

### Security Configuration

- **JWT Verification**: Requires `CLERK_JWT_KEY` for token validation
- **Authorized Parties**: Optional `CLERK_AUTHORIZED_PARTIES` for additional security

## Analytics & Monitoring

### Access Tracking

- **Resolution Count**: Incremented on each successful resolution
- **Last Access Time**: Updated with each resolution
- **User Association**: Track which users created/accessed links

### Metrics Available

- Total links created per user
- Most accessed links
- Creation patterns over time
- Popular domains/paths

## Troubleshooting

### Common Issues

**"URL not allowed" Error**:

- Verify domain is in `ALLOWED_ORIGINS`
- Check URL format includes protocol
- Ensure no typos in environment configuration

**Rate Limit Reached**:

- Check user's creation count in last 24 hours
- Verify `SHORT_LINK_DAILY_LIMIT` setting
- Wait for rolling window to reset

**Authentication Failures**:

- Verify JWT token format and expiration
- Check `CLERK_JWT_KEY` configuration
- Ensure proper Authorization header format

### Support

For technical support or questions about this API, please contact the development team or refer to the main application documentation.
