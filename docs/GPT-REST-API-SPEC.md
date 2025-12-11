# GPT REST API Specification

## Purpose

REST API for Custom GPT integration, exposing MCP module's budget analytics capabilities via standard HTTP endpoints.

## Key Decisions

| Decision            | Choice                          | Rationale                                    |
| ------------------- | ------------------------------- | -------------------------------------------- |
| **Architecture**    | Reuse MCP core use cases        | Single source of truth, no logic duplication |
| **API Prefix**      | `/api/v1/gpt/*`                 | GPT-specific namespace, versioned            |
| **Module Location** | `src/modules/mcp/shell/rest/`   | Shares core with MCP tools                   |
| **Authentication**  | `X-API-Key` header              | Simple, Custom GPT compatible                |
| **API Key Config**  | `GPT_API_KEY` env var           | Separate from MCP key                        |
| **Rate Limiting**   | Reuse MCP limiter (100 req/min) | Consistent protection                        |
| **Response Format** | `{ok, data}` wrapper            | Consistent with share/notifications modules  |
| **OpenAPI**         | `/openapi.json` only            | No Swagger UI needed                         |

## Endpoints

| Method | Path                           | Use Case                 | Description                          |
| ------ | ------------------------------ | ------------------------ | ------------------------------------ |
| POST   | `/api/v1/gpt/entity-snapshot`  | `getEntitySnapshot`      | Financial overview for single entity |
| POST   | `/api/v1/gpt/discover-filters` | `discoverFilters`        | Resolve Romanian names to IDs        |
| POST   | `/api/v1/gpt/timeseries`       | `queryTimeseries`        | Multi-series time-series data        |
| POST   | `/api/v1/gpt/entity-budget`    | `analyzeEntityBudget`    | Entity budget breakdown              |
| POST   | `/api/v1/gpt/budget-breakdown` | `exploreBudgetBreakdown` | Hierarchical drill-down              |
| POST   | `/api/v1/gpt/rank-entities`    | `rankEntities`           | Entity ranking by metrics            |
| GET    | `/openapi.json`                | -                        | OpenAPI 3.0 specification            |

## Response Format

**Success:**

```json
{
  "ok": true,
  "data": {
    /* use case output */
  }
}
```

**Error:**

```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
```

## Error Codes

| Code                  | HTTP Status | Description                |
| --------------------- | ----------- | -------------------------- |
| `UNAUTHORIZED`        | 401         | Missing or invalid API key |
| `RATE_LIMIT_EXCEEDED` | 429         | Too many requests          |
| `ENTITY_NOT_FOUND`    | 404         | Entity CUI not found       |
| `INVALID_INPUT`       | 400         | Validation failed          |
| `DATABASE_ERROR`      | 500         | Query failed               |

## Security

- **Authentication**: Timing-safe API key comparison (prevents timing attacks)
- **Rate Limiting**: 100 requests/minute per IP
- **CORS**: Inherits app-level CORS configuration

## Architecture

```
Custom GPT
    │
    ▼ HTTPS + X-API-Key
┌─────────────────────────────────┐
│  GPT Routes (shell/rest/)       │
│  - Request validation           │
│  - Auth + Rate limiting         │
│  - Response wrapping            │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│  MCP Core Use Cases             │
│  - getEntitySnapshot()          │
│  - discoverFilters()            │
│  - queryTimeseries()            │
│  - analyzeEntityBudget()        │
│  - exploreBudgetBreakdown()     │
│  - rankEntities()               │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│  Existing Repositories          │
│  (entity, classification, etc.) │
└─────────────────────────────────┘
```

## Files

| File                        | Purpose                     |
| --------------------------- | --------------------------- |
| `shell/rest/gpt-auth.ts`    | API key authentication hook |
| `shell/rest/gpt-schemas.ts` | Response wrapper schemas    |
| `shell/rest/gpt-routes.ts`  | Route handlers              |
| `shell/rest/openapi.ts`     | OpenAPI configuration       |

## Configuration

```bash
# .env
GPT_API_KEY=your-secret-api-key
```

## Custom GPT Setup

1. Import OpenAPI spec from `https://api.transparenta.eu/openapi.json`
2. Set authentication: API Key → Header → `X-API-Key`
3. Add system instructions for Romanian data terminology
