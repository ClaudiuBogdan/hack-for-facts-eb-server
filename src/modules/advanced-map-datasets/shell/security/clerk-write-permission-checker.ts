import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { AdvancedMapDatasetWritePermissionChecker } from '../../core/ports.js';
import type { Logger } from 'pino';

const DEFAULT_CLERK_API_BASE_URL = 'https://api.clerk.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

const PrivateMetadataSchema = Type.Object(
  {
    permissions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true }
);

const ClerkUserSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    private_metadata: Type.Optional(PrivateMetadataSchema),
  },
  { additionalProperties: true }
);

type ClerkUser = Static<typeof ClerkUserSchema>;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

export interface ClerkWritePermissionCheckerOptions {
  secretKey: string;
  permissionName: string;
  logger: Logger;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

const trimUserId = (userId: string): string => userId.trim();

function evictExpiredEntries(cache: Map<string, CacheEntry>, now: number): void {
  for (const [userId, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(userId);
    }
  }
}

function getCacheValue(
  cache: Map<string, CacheEntry>,
  userId: string,
  now: number
): boolean | undefined {
  const entry = cache.get(userId);
  if (entry === undefined) {
    return undefined;
  }

  if (entry.expiresAt <= now) {
    cache.delete(userId);
    return undefined;
  }

  return entry.value;
}

function setCacheValue(
  cache: Map<string, CacheEntry>,
  userId: string,
  value: boolean,
  now: number,
  ttlMs: number,
  maxEntries: number
): void {
  if (cache.has(userId)) {
    cache.delete(userId);
  }

  cache.set(userId, {
    value,
    expiresAt: now + ttlMs,
  });

  if (cache.size <= maxEntries) {
    return;
  }

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === 'string') {
    cache.delete(oldestKey);
  }
}

function extractPermissions(user: ClerkUser): Set<string> {
  const permissions = new Set<string>();

  for (const permission of user.private_metadata?.permissions ?? []) {
    const trimmed = permission.trim();
    if (trimmed !== '') {
      permissions.add(trimmed);
    }
  }

  return permissions;
}

export const makeClerkAdvancedMapDatasetWritePermissionChecker = (
  options: ClerkWritePermissionCheckerOptions
): AdvancedMapDatasetWritePermissionChecker => {
  const secretKey = options.secretKey.trim();
  const permissionName = options.permissionName.trim();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_CLERK_API_BASE_URL).replace(/\/+$/u, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const log = options.logger.child({ component: 'ClerkAdvancedMapDatasetWritePermissionChecker' });
  const cache = new Map<string, CacheEntry>();
  const inFlightLookups = new Map<string, Promise<boolean>>();

  if (secretKey.length === 0 || permissionName.length === 0 || typeof fetchImpl !== 'function') {
    return {
      canWrite() {
        return Promise.resolve(false);
      },
    };
  }

  const lookupPermission = async (userId: string): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await fetchImpl(`${apiBaseUrl}/users/${encodeURIComponent(userId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        log.warn({ statusCode: response.status, userId }, 'Clerk permission lookup failed');
        return false;
      }

      const payload: unknown = await response.json();
      if (!Value.Check(ClerkUserSchema, payload)) {
        log.warn({ userId }, 'Clerk permission lookup returned invalid payload');
        return false;
      }

      return extractPermissions(payload).has(permissionName);
    } catch (error) {
      log.warn({ err: error, userId }, 'Clerk permission lookup failed closed');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async canWrite(rawUserId: string): Promise<boolean> {
      const userId = trimUserId(rawUserId);
      if (userId.length === 0) {
        return false;
      }

      const now = Date.now();
      evictExpiredEntries(cache, now);

      const cached = getCacheValue(cache, userId, now);
      if (cached !== undefined) {
        return cached;
      }

      const inFlight = inFlightLookups.get(userId);
      if (inFlight !== undefined) {
        return inFlight;
      }

      const lookupPromise = (async (): Promise<boolean> => {
        const value = await lookupPermission(userId);
        setCacheValue(cache, userId, value, Date.now(), cacheTtlMs, maxCacheEntries);
        return value;
      })();

      inFlightLookups.set(userId, lookupPromise);

      try {
        return await lookupPromise;
      } finally {
        inFlightLookups.delete(userId);
      }
    },
  };
};
