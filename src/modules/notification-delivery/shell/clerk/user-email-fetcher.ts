import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  createUserEmailLookupError,
  createValidationError,
  type DeliveryError,
} from '../../core/errors.js';

import type { UserEmailFetcher } from '../../core/ports.js';
import type { Logger } from 'pino';

const DEFAULT_CLERK_API_BASE_URL = 'https://api.clerk.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POSITIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

const ClerkVerificationSchema = Type.Object(
  {
    status: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);

const ClerkEmailAddressSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    email_address: Type.String({ minLength: 1 }),
    verification: Type.Union([ClerkVerificationSchema, Type.Null()]),
  },
  { additionalProperties: true }
);

const ClerkUserSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    primary_email_address_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    email_addresses: Type.Array(ClerkEmailAddressSchema),
  },
  { additionalProperties: true }
);

const ClerkUserListSchema = Type.Array(ClerkUserSchema);

type ClerkUser = Static<typeof ClerkUserSchema>;

interface CacheEntry {
  expiresAt: number;
  value: string | null;
}

export type ClerkFetch = typeof fetch;

export interface ClerkUserEmailFetcherConfig {
  secretKey: string;
  logger: Logger;
  fetch?: ClerkFetch;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  batchSize?: number;
  positiveCacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  maxCacheEntries?: number;
}

const formatValidationErrorPath = (path: string): string => (path.length === 0 ? '/' : path);

const trimUserId = (userId: string): string => userId.trim();

const uniqueUserIds = (userIds: string[]): string[] => [
  ...new Set(userIds.map(trimUserId).filter((userId) => userId.length > 0)),
];

const buildLookupError = (message: string, retryable: boolean): Result<never, DeliveryError> =>
  err(createUserEmailLookupError(message, retryable));

const getPrimaryVerifiedEmail = (user: ClerkUser): string | null => {
  const primaryEmailAddressId = user.primary_email_address_id;

  if (primaryEmailAddressId === null) {
    return null;
  }

  const primaryEmail = user.email_addresses.find((email) => email.id === primaryEmailAddressId);

  if (primaryEmail === undefined) {
    return null;
  }

  if (primaryEmail.verification?.status !== 'verified') {
    return null;
  }

  return primaryEmail.email_address;
};

const evictExpiredEntries = (cache: Map<string, CacheEntry>, now: number): void => {
  for (const [userId, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(userId);
    }
  }
};

const setCacheEntry = (
  cache: Map<string, CacheEntry>,
  userId: string,
  value: string | null,
  now: number,
  positiveCacheTtlMs: number,
  negativeCacheTtlMs: number,
  maxCacheEntries: number
): void => {
  if (cache.has(userId)) {
    cache.delete(userId);
  }

  cache.set(userId, {
    value,
    expiresAt: now + (value === null ? negativeCacheTtlMs : positiveCacheTtlMs),
  });

  if (cache.size <= maxCacheEntries) {
    return;
  }

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === 'string') {
    cache.delete(oldestKey);
  }
};

const getCacheEntry = (
  cache: Map<string, CacheEntry>,
  userId: string,
  now: number
): string | null | undefined => {
  const entry = cache.get(userId);

  if (entry === undefined) {
    return undefined;
  }

  if (entry.expiresAt <= now) {
    cache.delete(userId);
    return undefined;
  }

  return entry.value;
};

const splitIntoChunks = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export const makeClerkUserEmailFetcher = (
  config: ClerkUserEmailFetcherConfig
): UserEmailFetcher => {
  const secretKey = config.secretKey.trim();

  if (secretKey.length === 0) {
    throw new Error('CLERK_SECRET_KEY is required to create the Clerk user email fetcher');
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for Clerk user email fetcher');
  }

  const apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_CLERK_API_BASE_URL).replace(/\/+$/u, '');
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const positiveCacheTtlMs = config.positiveCacheTtlMs ?? DEFAULT_POSITIVE_CACHE_TTL_MS;
  const negativeCacheTtlMs = config.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const maxCacheEntries = config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const log = config.logger.child({ component: 'ClerkUserEmailFetcher' });
  const cache = new Map<string, CacheEntry>();
  const inFlightLookups = new Map<string, Promise<Result<string | null, DeliveryError>>>();

  if (batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) {
    throw new Error(`batchSize must be between 1 and ${String(DEFAULT_BATCH_SIZE)}`);
  }

  const fetchJson = async (
    url: string,
    context: { operation: 'getEmail' | 'getEmailsByUserIds'; userId?: string; batchSize?: number }
  ): Promise<Result<unknown, DeliveryError>> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 404 && context.operation === 'getEmail') {
        return ok(null);
      }

      if (response.status === 401 || response.status === 403) {
        log.warn(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            statusCode: response.status,
          },
          'Clerk user lookup was rejected'
        );
        return buildLookupError(
          `Clerk user lookup rejected with status ${String(response.status)}`,
          false
        );
      }

      if (response.status === 429) {
        log.warn(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            statusCode: response.status,
          },
          'Clerk user lookup hit rate limit'
        );
        return buildLookupError('Clerk user lookup rate limited', true);
      }

      if (response.status >= 500) {
        log.warn(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            statusCode: response.status,
          },
          'Clerk user lookup failed with server error'
        );
        return buildLookupError(
          `Clerk user lookup failed with status ${String(response.status)}`,
          true
        );
      }

      if (!response.ok) {
        log.warn(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            statusCode: response.status,
          },
          'Clerk user lookup failed with client error'
        );
        return buildLookupError(
          `Clerk user lookup failed with status ${String(response.status)}`,
          false
        );
      }

      try {
        return ok(await response.json());
      } catch (error) {
        log.error(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Clerk user lookup returned invalid JSON'
        );
        return buildLookupError('Clerk user lookup returned invalid JSON', false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        log.warn(
          {
            operation: context.operation,
            userId: context.userId,
            batchSize: context.batchSize,
            timeoutMs: requestTimeoutMs,
          },
          'Clerk user lookup timed out'
        );
        return buildLookupError(
          `Clerk user lookup timed out after ${String(requestTimeoutMs)}ms`,
          true
        );
      }

      log.warn(
        {
          operation: context.operation,
          userId: context.userId,
          batchSize: context.batchSize,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Clerk user lookup failed with network error'
      );
      return buildLookupError('Clerk user lookup failed due to network error', true);
    } finally {
      clearTimeout(timeout);
    }
  };

  const parseUser = (
    payload: unknown,
    context: { operation: 'getEmail'; userId: string }
  ): Result<ClerkUser | null, DeliveryError> => {
    if (payload === null) {
      return ok(null);
    }

    if (!Value.Check(ClerkUserSchema, payload)) {
      const details = [...Value.Errors(ClerkUserSchema, payload)]
        .map((error) => `${formatValidationErrorPath(error.path)}: ${error.message}`)
        .join(', ');

      log.error(
        { operation: context.operation, userId: context.userId },
        'Clerk user payload failed validation'
      );
      return buildLookupError(
        details.length > 0
          ? `Clerk user lookup returned invalid payload: ${details}`
          : 'Clerk user lookup returned invalid payload',
        false
      );
    }

    return ok(payload);
  };

  const parseUsers = (
    payload: unknown,
    context: { operation: 'getEmailsByUserIds'; batchSize: number }
  ): Result<ClerkUser[], DeliveryError> => {
    if (!Value.Check(ClerkUserListSchema, payload)) {
      const details = [...Value.Errors(ClerkUserListSchema, payload)]
        .map((error) => `${formatValidationErrorPath(error.path)}: ${error.message}`)
        .join(', ');

      log.error(
        { operation: context.operation, batchSize: context.batchSize },
        'Clerk user list payload failed validation'
      );
      return buildLookupError(
        details.length > 0
          ? `Clerk user list lookup returned invalid payload: ${details}`
          : 'Clerk user list lookup returned invalid payload',
        false
      );
    }

    return ok(payload);
  };

  const hydrateCache = (userId: string, value: string | null): void => {
    const now = Date.now();
    evictExpiredEntries(cache, now);
    setCacheEntry(
      cache,
      userId,
      value,
      now,
      positiveCacheTtlMs,
      negativeCacheTtlMs,
      maxCacheEntries
    );
  };

  const getEmail = async (userId: string): Promise<Result<string | null, DeliveryError>> => {
    const normalizedUserId = trimUserId(userId);

    if (normalizedUserId.length === 0) {
      return err(createValidationError('userId is required'));
    }

    const now = Date.now();
    evictExpiredEntries(cache, now);
    const cachedValue = getCacheEntry(cache, normalizedUserId, now);
    if (cachedValue !== undefined) {
      return ok(cachedValue);
    }

    const inFlightLookup = inFlightLookups.get(normalizedUserId);
    if (inFlightLookup !== undefined) {
      return inFlightLookup;
    }

    const lookupPromise = (async (): Promise<Result<string | null, DeliveryError>> => {
      const responseResult = await fetchJson(
        `${apiBaseUrl}/users/${encodeURIComponent(normalizedUserId)}`,
        {
          operation: 'getEmail',
          userId: normalizedUserId,
        }
      );

      if (responseResult.isErr()) {
        return err(responseResult.error);
      }

      const userResult = parseUser(responseResult.value, {
        operation: 'getEmail',
        userId: normalizedUserId,
      });
      if (userResult.isErr()) {
        return err(userResult.error);
      }

      const email = userResult.value === null ? null : getPrimaryVerifiedEmail(userResult.value);
      hydrateCache(normalizedUserId, email);
      return ok(email);
    })();

    inFlightLookups.set(normalizedUserId, lookupPromise);

    try {
      return await lookupPromise;
    } finally {
      inFlightLookups.delete(normalizedUserId);
    }
  };

  const getEmailsByUserIds = async (
    userIds: string[]
  ): Promise<Result<Map<string, string | null>, DeliveryError>> => {
    if (userIds.length === 0) {
      return ok(new Map());
    }

    const result = new Map<string, string | null>();
    const now = Date.now();
    evictExpiredEntries(cache, now);

    for (const rawUserId of userIds) {
      const normalizedUserId = trimUserId(rawUserId);

      if (normalizedUserId.length === 0) {
        result.set(normalizedUserId, null);
        continue;
      }

      const cachedValue = getCacheEntry(cache, normalizedUserId, now);
      if (cachedValue !== undefined) {
        result.set(normalizedUserId, cachedValue);
      }
    }

    const uncachedUserIds = uniqueUserIds(userIds).filter((userId) => !result.has(userId));
    if (uncachedUserIds.length === 0) {
      return ok(result);
    }

    for (const chunk of splitIntoChunks(uncachedUserIds, batchSize)) {
      const searchParams = new URLSearchParams();
      searchParams.set('limit', String(chunk.length));

      for (const userId of chunk) {
        searchParams.append('user_id', userId);
      }

      const responseResult = await fetchJson(`${apiBaseUrl}/users?${searchParams.toString()}`, {
        operation: 'getEmailsByUserIds',
        batchSize: chunk.length,
      });
      if (responseResult.isErr()) {
        return err(responseResult.error);
      }

      const usersResult = parseUsers(responseResult.value, {
        operation: 'getEmailsByUserIds',
        batchSize: chunk.length,
      });
      if (usersResult.isErr()) {
        return err(usersResult.error);
      }

      const usersById = new Map(usersResult.value.map((user) => [user.id, user]));

      for (const userId of chunk) {
        const user = usersById.get(userId);
        const email = user === undefined ? null : getPrimaryVerifiedEmail(user);
        result.set(userId, email);
        hydrateCache(userId, email);
      }
    }

    return ok(result);
  };

  return {
    getEmail,
    getEmailsByUserIds,
  };
};
