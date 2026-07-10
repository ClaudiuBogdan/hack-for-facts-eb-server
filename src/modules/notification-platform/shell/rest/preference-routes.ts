import { isAuthenticated, requireAuthHandler } from '@/modules/auth/index.js';

import { sendPlatformRouteError } from './route-errors.js';
import {
  ChannelPreferenceParamsSchema,
  ErrorResponseSchema,
  PreferencesResponseSchema,
  UpdateChannelPreferenceBodySchema,
  UpdateGlobalPreferenceBodySchema,
  type ChannelPreferenceParams,
  type UpdateChannelPreferenceBody,
  type UpdateGlobalPreferenceBody,
} from './schemas.js';
import {
  getPreferences,
  type GetPreferencesDeps,
} from '../../core/preferences/usecases/get-preferences.js';
import {
  setChannelPreference,
  type SetChannelPreferenceDeps,
} from '../../core/preferences/usecases/set-channel-preference.js';
import {
  setGlobalPreference,
  type SetGlobalPreferenceDeps,
} from '../../core/preferences/usecases/set-global-preference.js';

import type { FastifyPluginAsync } from 'fastify';

export type MakePreferenceRoutesDeps = GetPreferencesDeps &
  SetGlobalPreferenceDeps &
  SetChannelPreferenceDeps;

const ERROR_RESPONSES = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

export const makePreferenceRoutes = (deps: MakePreferenceRoutesDeps): FastifyPluginAsync => {
  return (fastify) => {
    fastify.addHook('preHandler', requireAuthHandler);

    fastify.get(
      '/api/notifications/preferences',
      { schema: { response: { 200: PreferencesResponseSchema, ...ERROR_RESPONSES } } },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await getPreferences(deps, { userId: request.auth.userId });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.put<{ Body: UpdateGlobalPreferenceBody }>(
      '/api/notifications/preferences/global',
      {
        schema: {
          body: UpdateGlobalPreferenceBodySchema,
          response: { 200: PreferencesResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await setGlobalPreference(deps, {
          userId: request.auth.userId,
          enabled: request.body.enabled,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.put<{ Params: ChannelPreferenceParams; Body: UpdateChannelPreferenceBody }>(
      '/api/notifications/preferences/channels/:channel',
      {
        schema: {
          params: ChannelPreferenceParamsSchema,
          body: UpdateChannelPreferenceBodySchema,
          response: { 200: PreferencesResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await setChannelPreference(deps, {
          userId: request.auth.userId,
          channel: request.params.channel,
          enabled: request.body.enabled,
          cadence: request.body.cadence,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );
    return Promise.resolve();
  };
};
