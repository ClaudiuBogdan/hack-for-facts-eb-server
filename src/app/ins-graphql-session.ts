import type { GraphQLContextBuilder } from '../infra/graphql/index.js';
import type { InsReadSession } from '../modules/ins-native/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** App composition owns HTTP lifetime; the INS module owns the database session. */
export const makeInsGraphqlLifecycle = (
  app: FastifyInstance,
  createSession: () => InsReadSession,
  authContext?: GraphQLContextBuilder
): { context: GraphQLContextBuilder; registerHooks: () => void } => {
  const requests = new WeakMap<FastifyRequest, () => Promise<void>>();
  const close = (request: FastifyRequest): Promise<void> =>
    requests.get(request)?.() ?? Promise.resolve();

  return {
    context: async (request, reply) => {
      const session = createSession(); // Lazy: no INS resolver means no DB connection.
      let closing: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        if (closing !== undefined) return closing;
        reply.raw.removeListener('close', disconnected);
        request.raw.removeListener('aborted', disconnected);
        closing = session
          .close()
          .then((result) => {
            if (result.isErr()) {
              request.log.error(
                { errorType: result.error.type },
                'INS read session cleanup failed'
              );
            }
            return undefined;
          })
          .catch(() => {
            request.log.error('INS read session cleanup failed unexpectedly');
          });
        return closing;
      };
      const disconnected = (): void => {
        void cleanup();
      };
      requests.set(request, cleanup);
      // A fully received request may disconnect during execution; onRequestAbort
      // alone covers only an incomplete incoming body. Register before auth IO.
      reply.raw.once('close', disconnected);
      request.raw.once('aborted', disconnected);
      if ((!request.raw.complete && request.raw.destroyed) || reply.raw.destroyed) await cleanup();
      try {
        const auth = authContext === undefined ? {} : await authContext(request, reply);
        return { ...(auth as object), insReadSession: session };
      } catch (cause) {
        await cleanup();
        throw cause;
      }
    },
    registerHooks: () => {
      app.graphql.addHook('onResolution', async (_execution, context) => {
        await close(context.reply.request);
      });
      app.addHook('onError', async (request) => {
        await close(request);
      });
      app.addHook('onResponse', async (request) => {
        await close(request);
      });
      app.addHook('onRequestAbort', async (request) => {
        await close(request);
      });
    },
  };
};
