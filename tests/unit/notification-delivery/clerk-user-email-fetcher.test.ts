import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  makeClerkUserEmailFetcher,
  type ClerkFetch,
} from '@/modules/notification-delivery/index.js';

const testLogger = pinoLogger({ level: 'silent' });
type FetchInput = string | URL | Request;
const toRequestUrl = (input: FetchInput): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

const createUserPayload = (input: {
  userId: string;
  primaryEmailAddressId?: string | null;
  emailAddresses: {
    id: string;
    emailAddress: string;
    verificationStatus: 'verified' | 'unverified';
  }[];
}) => ({
  id: input.userId,
  primary_email_address_id: input.primaryEmailAddressId ?? null,
  email_addresses: input.emailAddresses.map((email) => ({
    id: email.id,
    email_address: email.emailAddress,
    verification: {
      status: email.verificationStatus,
    },
  })),
});

const createJsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });

describe('makeClerkUserEmailFetcher', () => {
  it('returns the primary verified email for single-user lookups', async () => {
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: RequestInit) =>
      createJsonResponse(
        createUserPayload({
          userId: 'user-1',
          primaryEmailAddressId: 'email-primary',
          emailAddresses: [
            {
              id: 'email-primary',
              emailAddress: 'primary@example.com',
              verificationStatus: 'verified',
            },
            {
              id: 'email-secondary',
              emailAddress: 'secondary@example.com',
              verificationStatus: 'verified',
            },
          ],
        })
      )
    );

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock,
    });

    const result = await fetcher.getEmail('user-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('primary@example.com');
    }
    const [firstCall] = fetchMock.mock.calls;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstCall?.[0] !== undefined ? toRequestUrl(firstCall[0]) : '').toBe(
      'https://api.clerk.com/v1/users/user-1'
    );
    expect(firstCall?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('rejects unsafe path segments and does not cache an email returned for another user', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse(
          createUserPayload({
            userId: 'user-other',
            primaryEmailAddressId: 'email-primary',
            emailAddresses: [
              {
                id: 'email-primary',
                emailAddress: 'other@example.com',
                verificationStatus: 'verified',
              },
            ],
          })
        )
      )
      .mockResolvedValueOnce(createJsonResponse({}, 404));
    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock as ClerkFetch,
    });

    expect((await fetcher.getEmail('..')).isErr()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetcher.getEmail('user-1')).resolves.toMatchObject({
      error: { type: 'UserEmailLookupError', retryable: false },
    });
    await expect(fetcher.getEmail('user-1')).resolves.toMatchObject({ value: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for missing, missing-primary, and unverified-primary users', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({}, 404))
      .mockResolvedValueOnce(
        createJsonResponse(
          createUserPayload({
            userId: 'user-missing-primary',
            primaryEmailAddressId: 'email-missing',
            emailAddresses: [
              {
                id: 'email-secondary',
                emailAddress: 'secondary@example.com',
                verificationStatus: 'verified',
              },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          createUserPayload({
            userId: 'user-unverified',
            primaryEmailAddressId: 'email-primary',
            emailAddresses: [
              {
                id: 'email-primary',
                emailAddress: 'primary@example.com',
                verificationStatus: 'unverified',
              },
              {
                id: 'email-secondary',
                emailAddress: 'secondary@example.com',
                verificationStatus: 'verified',
              },
            ],
          })
        )
      );

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock as ClerkFetch,
    });

    await expect(fetcher.getEmail('user-missing')).resolves.toMatchObject({ value: null });
    await expect(fetcher.getEmail('user-missing-primary')).resolves.toMatchObject({ value: null });
    await expect(fetcher.getEmail('user-unverified')).resolves.toMatchObject({ value: null });
  });

  it('caches positive and negative single-user lookups', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse(
          createUserPayload({
            userId: 'user-1',
            primaryEmailAddressId: 'email-primary',
            emailAddresses: [
              {
                id: 'email-primary',
                emailAddress: 'primary@example.com',
                verificationStatus: 'verified',
              },
            ],
          })
        )
      )
      .mockResolvedValueOnce(createJsonResponse({}, 404));

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock as ClerkFetch,
    });

    const first = await fetcher.getEmail('user-1');
    const second = await fetcher.getEmail('user-1');
    const missingFirst = await fetcher.getEmail('user-missing');
    const missingSecond = await fetcher.getEmail('user-missing');

    expect(first.isOk() && first.value === 'primary@example.com').toBe(true);
    expect(second.isOk() && second.value === 'primary@example.com').toBe(true);
    expect(missingFirst.isOk() && missingFirst.value === null).toBe(true);
    expect(missingSecond.isOk() && missingSecond.value === null).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent single-user lookups for the same user id', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock,
    });

    const firstLookup = fetcher.getEmail('user-1');
    const secondLookup = fetcher.getEmail('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(
      createJsonResponse(
        createUserPayload({
          userId: 'user-1',
          primaryEmailAddressId: 'email-primary',
          emailAddresses: [
            {
              id: 'email-primary',
              emailAddress: 'primary@example.com',
              verificationStatus: 'verified',
            },
          ],
        })
      )
    );

    const [firstResult, secondResult] = await Promise.all([firstLookup, secondLookup]);

    expect(firstResult.isOk() && firstResult.value === 'primary@example.com').toBe(true);
    expect(secondResult.isOk() && secondResult.value === 'primary@example.com').toBe(true);
  });

  it('batch-resolves user IDs, deduplicates requests, and hydrates the single-user cache', async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = new URL(toRequestUrl(input));
      const requestedUserIds = url.searchParams.getAll('user_id');

      return createJsonResponse([
        createUserPayload({
          userId: requestedUserIds[0] ?? 'user-1',
          primaryEmailAddressId: 'email-primary',
          emailAddresses: [
            {
              id: 'email-primary',
              emailAddress: 'primary@example.com',
              verificationStatus: 'verified',
            },
          ],
        }),
      ]);
    });

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock,
    });

    const batchResult = await fetcher.getEmailsByUserIds(['user-1', 'user-1', 'user-2']);

    expect(batchResult.isOk()).toBe(true);
    if (batchResult.isOk()) {
      expect(batchResult.value.get('user-1')).toBe('primary@example.com');
      expect(batchResult.value.get('user-2')).toBe(null);
      expect(batchResult.value.size).toBe(2);
    }

    const singleResult = await fetcher.getEmail('user-1');
    expect(singleResult.isOk() && singleResult.value === 'primary@example.com').toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chunks batch lookups above 100 user IDs and returns null for missing users', async () => {
    const fetchMock = vi.fn(async (input: FetchInput, _init?: RequestInit) => {
      const url = new URL(toRequestUrl(input));
      const requestedUserIds = url.searchParams.getAll('user_id');

      return createJsonResponse(
        requestedUserIds
          .filter((userId) => userId !== 'user-101')
          .map((userId) =>
            createUserPayload({
              userId,
              primaryEmailAddressId: `email-${userId}`,
              emailAddresses: [
                {
                  id: `email-${userId}`,
                  emailAddress: `${userId}@example.com`,
                  verificationStatus: 'verified',
                },
              ],
            })
          )
      );
    });

    const fetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: fetchMock,
    });

    const userIds = Array.from({ length: 101 }, (_, index) => `user-${String(index + 1)}`);
    const result = await fetcher.getEmailsByUserIds(userIds);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.get('user-1')).toBe('user-1@example.com');
      expect(result.value.get('user-100')).toBe('user-100@example.com');
      expect(result.value.get('user-101')).toBe(null);
      expect(result.value.size).toBe(101);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls[0]?.[0] !== undefined ? toRequestUrl(fetchMock.mock.calls[0][0]) : ''
    ).toContain('limit=100');
    expect(
      fetchMock.mock.calls[1]?.[0] !== undefined ? toRequestUrl(fetchMock.mock.calls[1][0]) : ''
    ).toContain('limit=1');
  });

  it('classifies 429 as retryable and malformed payloads as non-retryable', async () => {
    const retryableFetchMock = vi.fn(async () =>
      createJsonResponse({ error: 'rate limited' }, 429)
    );
    const malformedFetchMock = vi.fn(async () => createJsonResponse(null));

    const retryableFetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: retryableFetchMock,
    });
    const malformedFetcher = makeClerkUserEmailFetcher({
      secretKey: 'sk_test_123',
      logger: testLogger,
      fetch: malformedFetchMock,
    });

    const retryableResult = await retryableFetcher.getEmail('user-1');
    const malformedResult = await malformedFetcher.getEmail('user-1');

    expect(retryableResult.isErr()).toBe(true);
    if (retryableResult.isErr()) {
      expect(retryableResult.error.type).toBe('UserEmailLookupError');
      if (retryableResult.error.type === 'UserEmailLookupError') {
        expect(retryableResult.error.retryable).toBe(true);
      }
    }

    expect(malformedResult.isErr()).toBe(true);
    if (malformedResult.isErr()) {
      expect(malformedResult.error.type).toBe('UserEmailLookupError');
      if (malformedResult.error.type === 'UserEmailLookupError') {
        expect(malformedResult.error.retryable).toBe(false);
      }
    }
  });

  it('keeps Clerk requests in cooldown for Retry-After seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 429, headers: { 'Retry-After': '10' } })
        )
        .mockImplementation(async () => createJsonResponse({}, 404));
      const fetcher = makeClerkUserEmailFetcher({
        secretKey: 'sk_test_123',
        logger: testLogger,
        fetch: fetchMock as ClerkFetch,
        negativeCacheTtlMs: 0,
      });

      const retryable = { error: { type: 'UserEmailLookupError', retryable: true } };
      await expect(fetcher.getEmail('user-1')).resolves.toMatchObject(retryable);
      await vi.advanceTimersByTimeAsync(9999);
      await expect(fetcher.getEmail('user-2')).resolves.toMatchObject(retryable);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(fetcher.getEmail('user-2')).resolves.toMatchObject({ value: null });
      await expect(fetcher.getEmail('user-2')).resolves.toMatchObject({ value: null });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a timeout while reading the response body as retryable', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock: ClerkFetch = async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => {
                controller.error(new Error('aborted'));
              },
              { once: true }
            );
          },
        });
        return new Response(stream);
      };
      const fetcher = makeClerkUserEmailFetcher({
        secretKey: 'sk_test_123',
        logger: testLogger,
        fetch: fetchMock,
        requestTimeoutMs: 10,
      });

      const lookup = fetcher.getEmail('user-1');
      await vi.advanceTimersByTimeAsync(10);
      await expect(lookup).resolves.toMatchObject({
        error: {
          type: 'UserEmailLookupError',
          retryable: true,
          message: expect.stringContaining('timed out'),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when CLERK_SECRET_KEY is missing', () => {
    expect(() =>
      makeClerkUserEmailFetcher({
        secretKey: '   ',
        logger: testLogger,
      })
    ).toThrow('CLERK_SECRET_KEY is required to create the Clerk user email fetcher');
  });
});
