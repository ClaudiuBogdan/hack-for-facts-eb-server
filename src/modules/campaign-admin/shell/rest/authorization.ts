import { requireAuth } from '@/modules/auth/index.js';

import type { CampaignAdminPermissionAuthorizer } from '../../core/ports.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface CampaignAdminAuthorizationFailure {
  readonly statusCode: 403 | 404;
  readonly error: string;
  readonly message: string;
}

export type CampaignAdminAuthorizationResult<TAccessContext> =
  | { ok: true; accessContext: TAccessContext }
  | ({ ok: false } & CampaignAdminAuthorizationFailure);

interface ResolveCampaignAdminPermissionAccessInput<TConfig, TAccessContext> {
  readonly campaignKey: string;
  readonly userId: string;
  readonly permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  readonly enabledCampaignKeys: ReadonlySet<string>;
  readonly getConfig: (campaignKey: string) => TConfig | null;
  readonly getPermissionName: (config: TConfig) => string;
  readonly buildAccessContext: (input: { userId: string; config: TConfig }) => TAccessContext;
  readonly notFoundMessage: string;
  readonly forbiddenMessage: string;
}

interface MakeCampaignAdminAuthorizationHookInput<TAccessContext> {
  readonly setAccessContext: (
    request: FastifyRequest,
    accessContext: TAccessContext | null
  ) => void;
  readonly authorize: (input: {
    campaignKey: string;
    userId: string;
  }) => Promise<CampaignAdminAuthorizationResult<TAccessContext>>;
}

function sendCampaignAdminError(
  reply: FastifyReply,
  statusCode: 401 | 403 | 404,
  error: string,
  message: string
) {
  return reply.status(statusCode).send({
    ok: false,
    error,
    message,
    retryable: false,
  });
}

function getRequestCampaignKey(request: FastifyRequest): string | null {
  const params = request.params as { campaignKey?: unknown };
  return typeof params.campaignKey === 'string' ? params.campaignKey : null;
}

export async function resolveCampaignAdminPermissionAccess<TConfig, TAccessContext>(
  input: ResolveCampaignAdminPermissionAccessInput<TConfig, TAccessContext>
): Promise<CampaignAdminAuthorizationResult<TAccessContext>> {
  if (!input.enabledCampaignKeys.has(input.campaignKey)) {
    return {
      ok: false,
      statusCode: 404,
      error: 'NotFoundError',
      message: input.notFoundMessage,
    };
  }

  const config = input.getConfig(input.campaignKey);
  if (config === null) {
    return {
      ok: false,
      statusCode: 404,
      error: 'NotFoundError',
      message: input.notFoundMessage,
    };
  }

  const allowed = await input.permissionAuthorizer.hasPermission({
    userId: input.userId,
    permissionName: input.getPermissionName(config),
  });
  if (!allowed) {
    return {
      ok: false,
      statusCode: 403,
      error: 'ForbiddenError',
      message: input.forbiddenMessage,
    };
  }

  return {
    ok: true,
    accessContext: input.buildAccessContext({
      userId: input.userId,
      config,
    }),
  };
}

export function makeCampaignAdminAuthorizationHook<TAccessContext>(
  input: MakeCampaignAdminAuthorizationHookInput<TAccessContext>
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    input.setAccessContext(request, null);

    const campaignKey = getRequestCampaignKey(request);
    if (campaignKey === null) {
      void sendCampaignAdminError(
        reply,
        404,
        'NotFoundError',
        'Campaign interaction audit not found'
      );
      return;
    }

    const authResult = requireAuth(request.auth);
    if (authResult.isErr()) {
      void sendCampaignAdminError(reply, 401, authResult.error.type, authResult.error.message);
      return;
    }

    const userId = authResult.value as string;
    const access = await input.authorize({
      campaignKey,
      userId,
    });

    if (!access.ok) {
      void sendCampaignAdminError(reply, access.statusCode, access.error, access.message);
      return;
    }

    input.setAccessContext(request, access.accessContext);
  };
}
