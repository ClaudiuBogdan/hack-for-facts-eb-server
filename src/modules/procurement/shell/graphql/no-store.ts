/**
 * PROC-VDWQ: a GraphQL answer that carries a direct-acquisition supplier name is never cacheable.
 *
 * DA supplier names come from the live registry (`party_public_names`) or the source, and D6 or the
 * registry can withdraw one without any publication key moving, so an HTTP cache (browser, CDN,
 * proxy) must not keep or replay such an answer. Every resolver that hands out a DA supplier name
 * marks the reply `Cache-Control: no-store` as it does; answers without one keep their headers.
 * The same marking approach as the client's ruling for name-bearing renders. Other modules'
 * GraphQL caching is unchanged (an owner decision to widen).
 */

import type { FastifyReply } from 'fastify';

/** Marks this request's GraphQL reply `Cache-Control: no-store`. No reply (not over HTTP): no-op. */
export const markNoStore = (context: unknown): void => {
  const reply =
    typeof context === 'object' && context !== null && 'reply' in context
      ? (context as { reply?: FastifyReply }).reply
      : undefined;
  reply?.header('cache-control', 'no-store');
};
