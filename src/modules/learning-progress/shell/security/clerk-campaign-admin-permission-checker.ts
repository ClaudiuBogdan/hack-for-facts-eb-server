import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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
  permissions: ReadonlySet<string>;
  expiresAt: number;
}

interface PermissionLookupResult {
  permissions: ReadonlySet<string>;
  cacheable: boolean;
}

export interface CampaignAdminPermissionAuthorizer {
  hasPermission(input: { userId: string; permissionName: string }): Promise<boolean>;
}

export interface ClerkCampaignAdminPermissionAuthorizerOptions {
  secretKey: string;
  logger: Logger;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

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
): ReadonlySet<string> | undefined {
  const entry = cache.get(userId);
  if (entry === undefined) {
    return undefined;
  }

  if (entry.expiresAt <= now) {
    cache.delete(userId);
    return undefined;
  }

  return entry.permissions;
}

function setCacheValue(
  cache: Map<string, CacheEntry>,
  userId: string,
  permissions: ReadonlySet<string>,
  now: number,
  ttlMs: number,
  maxEntries: number
): void {
  if (cache.has(userId)) {
    cache.delete(userId);
  }

  cache.set(userId, {
    permissions,
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
    const trimmedPermission = permission.trim();
    if (trimmedPermission !== '') {
      permissions.add(trimmedPermission);
    }
  }

  return permissions;
}

// Spec: docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md
export const makeClerkCampaignAdminPermissionAuthorizer = (
  options: ClerkCampaignAdminPermissionAuthorizerOptions
): CampaignAdminPermissionAuthorizer => {
  const secretKey = options.secretKey.trim();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_CLERK_API_BASE_URL).replace(/\/+$/u, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const log = options.logger.child({ component: 'ClerkCampaignAdminPermissionAuthorizer' });
  const cache = new Map<string, CacheEntry>();
  const inFlightLookups = new Map<string, Promise<PermissionLookupResult>>();

  if (secretKey === '') {
    throw new Error('Campaign admin permission authorizer requires a non-empty secretKey.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('Campaign admin permission authorizer requires a fetch implementation.');
  }

  const lookupPermissions = async (rawUserId: string): Promise<PermissionLookupResult> => {
    const userId = rawUserId.trim();
    if (userId === '') {
      return { permissions: new Set(), cacheable: false };
    }

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
        log.warn(
          { statusCode: response.status, userId },
          'Campaign admin permission lookup failed'
        );
        return { permissions: new Set(), cacheable: false };
      }

      const payload: unknown = await response.json();
      if (!Value.Check(ClerkUserSchema, payload)) {
        log.warn({ userId }, 'Campaign admin permission lookup returned invalid payload');
        return { permissions: new Set(), cacheable: false };
      }

      return {
        permissions: extractPermissions(payload),
        cacheable: true,
      };
    } catch (error) {
      log.warn({ err: error, userId }, 'Campaign admin permission lookup failed closed');
      return { permissions: new Set(), cacheable: false };
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async hasPermission(input: { userId: string; permissionName: string }): Promise<boolean> {
      const userId = input.userId.trim();
      const permissionName = input.permissionName.trim();
      if (userId === '' || permissionName === '') {
        return false;
      }

      const now = Date.now();
      evictExpiredEntries(cache, now);

      const cached = getCacheValue(cache, userId, now);
      if (cached !== undefined) {
        return cached.has(permissionName);
      }

      const inFlight = inFlightLookups.get(userId);
      if (inFlight !== undefined) {
        const lookupResult = await inFlight;
        return lookupResult.permissions.has(permissionName);
      }

      const lookupPromise = (async (): Promise<PermissionLookupResult> => {
        const lookupResult = await lookupPermissions(userId);
        if (lookupResult.cacheable) {
          setCacheValue(
            cache,
            userId,
            lookupResult.permissions,
            Date.now(),
            cacheTtlMs,
            maxCacheEntries
          );
        }
        return lookupResult;
      })();

      inFlightLookups.set(userId, lookupPromise);

      try {
        const lookupResult = await lookupPromise;
        return lookupResult.permissions.has(permissionName);
      } finally {
        inFlightLookups.delete(userId);
      }
    },
  };
};
