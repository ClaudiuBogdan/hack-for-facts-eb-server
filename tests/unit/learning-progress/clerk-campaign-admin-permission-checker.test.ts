import { describe, expect, it, vi } from 'vitest';

import { makeClerkCampaignAdminPermissionAuthorizer } from '@/modules/learning-progress/index.js';

import type { Logger } from 'pino';

function makeLogger(): Logger {
  const logger = {
    child: vi.fn(() => logger),
    warn: vi.fn(),
  };

  return logger as unknown as Logger;
}

describe('makeClerkCampaignAdminPermissionAuthorizer', () => {
  it('throws when constructed without a secret key', () => {
    expect(() =>
      makeClerkCampaignAdminPermissionAuthorizer({
        secretKey: '   ',
        logger: makeLogger(),
      })
    ).toThrow('Campaign admin permission authorizer requires a non-empty secretKey.');
  });

  it('returns true when the required permission is present and caches the permission set', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'user_123',
          private_metadata: {
            permissions: ['campaign:funky_admin'],
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

    const authorizer = makeClerkCampaignAdminPermissionAuthorizer({
      secretKey: 'sk_test_123',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(true);
    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:other_admin',
      })
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when clerk returns an error', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));

    const authorizer = makeClerkCampaignAdminPermissionAuthorizer({
      secretKey: 'sk_test_123',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(false);
  });

  it('does not cache failed Clerk responses as empty permissions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'user_123',
            private_metadata: {
              permissions: ['campaign:funky_admin'],
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      );

    const authorizer = makeClerkCampaignAdminPermissionAuthorizer({
      secretKey: 'sk_test_123',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(false);
    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    const authorizer = makeClerkCampaignAdminPermissionAuthorizer({
      secretKey: 'sk_test_123',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(false);
  });

  it('does not cache invalid Clerk payloads as empty permissions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'user_123',
            private_metadata: {
              permissions: 'campaign:funky_admin',
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'user_123',
            private_metadata: {
              permissions: ['campaign:funky_admin'],
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          }
        )
      );

    const authorizer = makeClerkCampaignAdminPermissionAuthorizer({
      secretKey: 'sk_test_123',
      logger: makeLogger(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(false);
    await expect(
      authorizer.hasPermission({
        userId: 'user_123',
        permissionName: 'campaign:funky_admin',
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
