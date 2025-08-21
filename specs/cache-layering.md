# Two-Layer Cache Specification (L1 in-memory, L2 Redis)

## Goals
- Fast local hits via in-memory LRU (L1)
- Warm-start resilience via Redis (L2)
- Read-through: miss in L1 → fetch from L2; if found, backfill L1
- Write-through: writes go to both L1 and L2; tolerate L2 outages without failing requests
- Backward compatible API: `AsyncCache<T>` with `get/set/has/delete/clear`

## Configuration
- `CACHE_ENABLED` (default true)
- `CACHE_TTL_MS` default 30 days
- `CACHE_MAX_SIZE_BYTES`, `CACHE_MAX_ITEMS` for L1 sizing
- `REDIS_ENABLED`, `REDIS_URL`, `REDIS_PREFIX`

## Keyspace
- Namespaced per cache: `<REDIS_PREFIX>:<cacheName>::<key>`

## Semantics
- get(k):
  - Try L1; if hit → return
  - Else try L2; if hit → parse, set L1, return
  - Else → undefined
- set(k, v, ttl?):
  - Set L1 immediately
  - Attempt set to L2 with per-key ttl (fallback to default ttl). Errors log but return true.
- has(k):
  - Check L1; if present → true
  - Else check L2 exists → true/false
- delete(k):
  - Delete from L1; attempt delete from L2 (ignore errors)
- clear():
  - Clear L1; best-effort scan+del for L2 under the cache prefix

## Serialization
- JSON for L2; values must be serializable

## Eviction
- L1: LRUCache sizing via `sizeCalculation`
- L2: rely on Redis server eviction policy (e.g., allkeys-lru)

## Operational Notes
- If Redis is down/unavailable, service continues using L1 only
- Using dynamic import for ioredis to avoid hard dependency when disabled
- Optional debug via `CACHE_DEBUG=true`

## Migration
- No interface changes for repos; behavior improves with Redis enabled

## Testing
- Unit test `get/set/has/delete/clear` (L1 only vs L1+L2)
- Simulate Redis failures and ensure L1 continues to serve


