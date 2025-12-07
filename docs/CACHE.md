# Cache Specification

A pluggable caching layer with silent degradation - cache failures never cause request failures.

## Quick Reference

| Setting      | Default      | Options                                |
| ------------ | ------------ | -------------------------------------- |
| Backend      | `memory`     | `memory`, `redis`, `multi`, `disabled` |
| TTL          | disabled     | Configurable per operation             |
| Memory limit | 1000 entries | Configurable                           |

**Environment variables:**

| Variable                   | Type                                   | Default     | Description                    |
| -------------------------- | -------------------------------------- | ----------- | ------------------------------ |
| `CACHE_BACKEND`            | `memory \| redis \| multi \| disabled` | Auto-detect | Cache backend                  |
| `CACHE_DEFAULT_TTL_MS`     | `number`                               | `null`      | Default TTL (no ttl)           |
| `CACHE_MEMORY_MAX_ENTRIES` | `number`                               | `1000`      | Memory cache limit             |
| `CACHE_L1_MAX_ENTRIES`     | `number`                               | `500`       | L1 cache limit (multi backend) |
| `REDIS_URL`                | `string`                               | -           | Redis connection URL           |

**Auto-detection:** If `REDIS_URL` is set → Redis, otherwise → Memory.

---

## Architecture

```
GraphQL/REST
    ↓
Use Cases (explicit caching)
    ↓
Cached Repositories (decorator caching)
    ↓
Repositories (Kysely)
    ↓
Database
```

### File Structure

```
src/infra/cache/
├── index.ts              # Public exports
├── ports.ts              # CachePort, SilentCachePort interfaces
├── key-builder.ts        # Key generation + namespaces
├── serialization.ts      # Decimal.js-aware JSON
├── with-cache.ts         # Decorator for repo methods
├── client.ts             # initCache() factory
├── adapters/
│   ├── noop-cache.ts         # Disabled (passthrough)
│   ├── memory-cache.ts       # In-memory LRU
│   ├── redis-cache.ts        # Redis via ioredis
│   └── multi-level-cache.ts  # L1 (memory) + L2 (Redis)
└── wrappers/
    └── silent-cache.ts   # Error → undefined wrapper
```

---

## Interfaces

### SilentCachePort (Application Layer)

Use this interface in application code. Errors are logged and swallowed.

```typescript
interface SilentCachePort<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clearByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
  stats(): Promise<{ hits: number; misses: number; size: number }>;
}
```

### CachePort (Adapter Layer)

Low-level interface for implementing backends. Uses `Result<T, CacheError>` from neverthrow.

```typescript
type CacheError =
  | { type: 'ConnectionError'; message: string; cause?: unknown }
  | { type: 'SerializationError'; message: string; cause?: unknown }
  | { type: 'TimeoutError'; message: string; cause?: unknown };
```

All errors result in silent degradation: logged and treated as cache misses.

---

## Backends

| Backend    | Use Case                 | Persistence | Shared Across Instances |
| ---------- | ------------------------ | ----------- | ----------------------- |
| `memory`   | Single server, dev       | No          | No                      |
| `redis`    | Multi-server, prod       | Yes         | Yes                     |
| `multi`    | High performance, shared | Yes (L2)    | Yes (L2)                |
| `disabled` | Testing, debugging       | -           | -                       |

### Multi-Level Cache (`multi`)

When `backend: 'multi'`, uses memory (L1) in front of Redis (L2):

- **L1 hit**: Returns immediately, L2 not queried
- **L1 miss, L2 hit**: Returns value, populates L1 for next request
- **Both miss**: Returns undefined

**Behavior:**

| Operation       | Logic                                         |
| --------------- | --------------------------------------------- |
| `get`           | L1 → L2 (populate L1 on L2 hit)               |
| `set`           | Write to both L1 and L2 (parallel)            |
| `delete`        | Delete from both (returns true if either had) |
| `has`           | L1 → L2                                       |
| `clearByPrefix` | Clear both, return combined count             |
| `stats`         | Combined hits, L2 size                        |

**When to use:**

- Multi-server deployments needing both speed and consistency
- High-traffic endpoints with repeated queries
- Requires `REDIS_URL` to be set (falls back to memory if not)

---

## Keys & Namespaces

### Namespaces

```typescript
const CacheNamespace = {
  ANALYTICS_EXECUTION: 'analytics:execution',
  ANALYTICS_AGGREGATED: 'analytics:aggregated',
  ANALYTICS_COUNTY: 'analytics:county',
  ANALYTICS_ENTITY: 'analytics:entity',
  DATASETS: 'datasets',
} as const;
```

### Key Format

```
{globalPrefix}:{namespace}:{identifier}

Examples:
- transparenta:analytics:execution:a1b2c3d4
- transparenta:datasets:budget-2024
```

Filter objects are hashed (SHA-256, truncated to 16 chars) for deterministic keys.

---

## Usage Patterns

### Pattern 1: Decorator (Recommended)

Wrap repository methods transparently. Use for straightforward query caching.

```typescript
import { withCache, CacheNamespace } from '@/infra/cache';

const cachedRepo = {
  getAnalytics: withCache(baseRepo.getAnalytics.bind(baseRepo), cache, {
    namespace: CacheNamespace.ANALYTICS_EXECUTION,
    ttlMs: 3600000,
    keyGenerator: ([filter]) => keyBuilder.fromFilter(filter),
  }),
};
```

### Pattern 2: Explicit

Use when caching logic is conditional or complex.

```typescript
const key = keyBuilder.fromFilter(filter);
const cached = await cache.get(key);
if (cached !== undefined) return ok(cached);

const result = await repo.getData(filter);
if (result.isOk()) {
  await cache.set(key, result.value, { ttlMs: 3600000 });
}
return result;
```

---

## Serialization

Financial data uses `Decimal.js` for precision. Custom serialization handles this:

```typescript
// Stored as:
{ "value": { "__decimal__": "1234567890.123456789" } }

// Restored to Decimal instance on read
```

---

## Invalidation

Data changes approximately once per month. Manual invalidation is sufficient.

```typescript
// Clear specific namespace
await cache.clearByPrefix('analytics:execution:');

// Clear all analytics
await cache.clearByPrefix('analytics:');

// Clear everything
await cache.clear();
```

---

## Testing

| Level       | Approach                                |
| ----------- | --------------------------------------- |
| Unit        | Each adapter in isolation               |
| Integration | Cached repos with mock underlying repos |
| E2E (Redis) | Redis url in env                        |

```typescript
// Verify cache hit prevents second repo call
await cachedRepo.getData(filter);
await cachedRepo.getData(filter);
expect(mockRepo.getData).toHaveBeenCalledTimes(1);
```

---

## Future Considerations

| Feature                  | Description                            |
| ------------------------ | -------------------------------------- |
| Cache warming            | Pre-populate common queries on startup |
| Prometheus metrics       | Export hit/miss counters               |
| Stale-while-revalidate   | Return stale data, refresh async       |
| Event-based invalidation | Clear cache on data import events      |

### Event-Based Invalidation

When data import events are implemented, use table-to-namespace mapping:

```typescript
const TABLE_NAMESPACE_MAP: Record<string, CacheNamespace[]> = {
  executionlineitems: [
    CacheNamespace.ANALYTICS_EXECUTION,
    CacheNamespace.ANALYTICS_AGGREGATED,
    CacheNamespace.ANALYTICS_COUNTY,
    CacheNamespace.ANALYTICS_ENTITY,
  ],
  entities: [CacheNamespace.ANALYTICS_ENTITY],
  uats: [CacheNamespace.ANALYTICS_COUNTY],
};

// On DataImportEvent, clear affected namespaces
for (const table of event.tables) {
  const namespaces = TABLE_NAMESPACE_MAP[table] ?? [];
  for (const ns of namespaces) {
    await cache.clearByPrefix(`${ns}:`);
  }
}
```
