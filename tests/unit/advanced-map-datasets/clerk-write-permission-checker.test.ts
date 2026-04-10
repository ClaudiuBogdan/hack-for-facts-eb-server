import { describe, expect, it, vi } from 'vitest';

import { makeClerkAdvancedMapDatasetWritePermissionChecker } from '@/modules/advanced-map-datasets/index.js';

import type { Logger } from 'pino';

function makeLogger(): Logger {
  const logger = {
    child: vi.fn(() => logger),
    warn: vi.fn(),
  };

  return logger as unknown as Logger;
}

describe('makeClerkAdvancedMapDatasetWritePermissionChecker', () => {
  it('returns true when the required permission is present and caches the result', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'user_123',
          private_metadata: {
            permissions: ['advanced_map:public_write'],
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    });

    const checker = makeClerkAdvancedMapDatasetWritePermissionChecker({
      secretKey: 'sk_test_123',
      permissionName: 'advanced_map:public_write',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(checker.canWrite('user_123')).resolves.toBe(true);
    await expect(checker.canWrite('user_123')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when clerk returns an error', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));

    const checker = makeClerkAdvancedMapDatasetWritePermissionChecker({
      secretKey: 'sk_test_123',
      permissionName: 'advanced_map:public_write',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(checker.canWrite('user_123')).resolves.toBe(false);
  });

  it('returns false when private metadata permissions are missing', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'user_123',
          private_metadata: {},
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    });

    const checker = makeClerkAdvancedMapDatasetWritePermissionChecker({
      secretKey: 'sk_test_123',
      permissionName: 'advanced_map:public_write',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(checker.canWrite('user_123')).resolves.toBe(false);
  });
});
