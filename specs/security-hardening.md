# API Security & Operations Spec

This document specifies the security posture and operational configuration for the Hack for Facts EB Server (Fastify + Mercurius + PostgreSQL).

## Goals
- Reduce attack surface (limit exposed tooling/UI in production)
- Prevent common web vulns (SQLi, CORS misconfig, information disclosure)
- Mitigate abuse/DoS (rate limit, request size caps, query depth limits)
- Provide a clear, configurable production setup

## Controls and Behavior

### HTTP Server Hardening
- HTTP headers: `@fastify/helmet` enabled
- Request body size: `~1 MB` (`bodyLimit: 1_000_000`)
- URL param length: `maxParamLength: 200`
- `trustProxy: true` (for accurate client IPs behind proxies)

### CORS Policy
- Development: allow all origins (to ease local client dev)
- Production: allowlist-only via `ALLOWED_ORIGINS` (comma-separated absolute URLs)
  - Match protocol + hostname, and port if specified
  - Allowed headers: `content-type, x-requested-with, authorization, x-api-key, accept`
  - Exposed headers: `content-length`
  - `credentials: true` (cookies/credentials across allowed origins only)

Example:
```
ALLOWED_ORIGINS="https://client.example.com,https://www.example.com"
```

### Rate Limiting
- `@fastify/rate-limit`: 300 requests / minute / IP
- Intent: mitigate abusive scraping and basic resource-exhaustion attempts
- Can be tuned later via env if needed

### OpenAPI / Swagger
- OpenAPI document is registered
- Swagger UI (`/docs`) is enabled only outside production

### GraphQL Surface
- Endpoint: `/graphql`
- GraphiQL IDE: enabled only outside production
- Introspection: disabled in production (prevents schema enumeration)
- Query limits: depth limit = 8; batched queries disabled

Planned (not yet implemented): query cost/complexity analysis in addition to depth limits.

### Database Access
- All repositories use parameterized queries and safe `ORDER BY` whitelists
- No unsafe raw SQL execution or string concatenation into SQL
- Optional session settings supported (timeouts) via env (see DB_* vars)

### XML Processing
- XML parsing is performed with `fast-xml-parser` (no DTD/XXE usage)
- Source data is local batch files; not user-uploaded over HTTP

### AI/LLM Routes
- All REST inputs validated with Zod
- LLM JSON responses post-processed before use; raw content is not blindly trusted
- Sensitive config is not logged

### MCP Client Helper
- `src/mcp/index.ts` uses a static GraphQL URL (update for prod deployments)

## Environment Variables
- `NODE_ENV`: must be `production` in prod
- `PORT`: server port (default `3000`) — in k8s, use `APP_PORT` config map
- `DATABASE_URL`: PostgreSQL connection string
- `DB_USE_SSL`, `DB_REJECT_UNAUTHORIZED_SSL`: optional SSL controls
- `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TX_TIMEOUT_MS`: optional performance/timeouts
- `CLIENT_BASE_URL` / `PUBLIC_CLIENT_BASE_URL`: primary client URL for deep links
- `ALLOWED_ORIGINS`: comma-separated absolute origins allowed by CORS in production

## Kubernetes Configuration
- ConfigMap: `k8s/base/configmap.yaml`
  - Sets `NODE_ENV=production`, `APP_PORT`, and `ALLOWED_ORIGINS` (empty by default, set in overlays)
- Service: `k8s/base/service.yaml` → exposes port 80, targets 3000
- VirtualService: `k8s/base/virtual-service.yaml` → host routing via Istio
- Probes: `/healthz` for liveness/readiness

## Operational Guidance
- CI/CD checks:
  - `npx tsc -b --noEmit` (type safety)
  - `yarn audit --groups dependencies --level moderate` (SCA)
- Secrets: store DB credentials and API keys in Kubernetes Secrets (sealed or vault-backed)
- Logging: production log level defaults to `error`; can be tuned via config

## Threat Scenarios & Mitigations
- Schema discovery & tooling exposure → Introspection + GraphiQL disabled in production; Swagger UI off in production
- Resource exhaustion via deep GraphQL queries → depth limit (8) and no batched queries
- Abusive request bursts → rate limiting (300/min/IP)
- Oversized payloads → body size cap (~1MB)
- Cross-origin abuse → CORS allowlist enforced in production
- SQL injection → parameterized queries and explicit sort whitelists throughout repositories

## Future Enhancements
- Add `@fastify/under-pressure` for backpressure/overload protection
- Add GraphQL query cost analysis (e.g., graphql-query-complexity)
- Add authentication/authorization (e.g., API keys/JWT) where applicable
- Web Application Firewall (WAF) integration in fronting ingress if needed

## Change Summary (current iteration)
- Upgraded `fastify` to address advisory and added security plugins (helmet, rate-limit)
- Implemented production-only restrictions: CORS allowlist, no GraphiQL/Swagger UI, no GraphQL introspection
- Added body and param limits; documented env and k8s setup
- Resolved critical transitive vulnerability (`form-data`)
