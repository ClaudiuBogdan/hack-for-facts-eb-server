/**
 * Auth hook for feature scopes the kernel surface registers on behalf of an
 * embedding server (native maps, INS dataset requests): a configured provider
 * verifies a presented bearer (garbage → 401, absent → anonymous); with
 * authentication disabled every request is the anonymous session, so the
 * owner-only operations fail closed at route level while public reads stay
 * served — the legacy composer's fallback hook, scoped.
 */
import { ANONYMOUS_SESSION, makeAuthMiddleware, type AuthProvider } from '../modules/auth/index.js';

import type { FastifyInstance } from 'fastify';

export const addEmbeddedScopeAuth = (
  scope: FastifyInstance,
  authProvider: AuthProvider | undefined,
  isPublic: (method: string, url: string) => boolean = () => false
): void => {
  if (authProvider === undefined) {
    scope.addHook('preHandler', (request, _reply, done) => {
      request.auth = ANONYMOUS_SESSION;
      done();
    });
    return;
  }
  const authenticate = makeAuthMiddleware({ authProvider });
  scope.addHook('preHandler', async function (this: FastifyInstance, request, reply) {
    if (isPublic(request.method, request.url)) return;
    await authenticate.call(this, request, reply);
  });
};
