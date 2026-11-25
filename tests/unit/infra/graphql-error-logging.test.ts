/**
 * PRJ-DMHY: a GraphQL error message can quote a value the caller sent (a variable-coercion
 * error quotes it whole), so the shared formatter and the operation log write it redacted. The
 * response the client gets is unchanged.
 */

import { Writable } from 'node:stream';

import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance } from 'fastify';
import mercuriusPlugin, { type MercuriusOptions } from 'mercurius';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeGraphQLErrorFormatter, redactLoggedText } from '@/infra/graphql/security.js';

/** A synthetic CNP-shaped value (never a real person's). */
const CODE = '1960101123456';
const EMAIL = 'ion@example.ro';

const TYPE_DEFS = /* GraphQL */ `
  type Query {
    echo(c: String!): String
    fail(c: String!): String
  }
`;
const RESOLVERS = {
  Query: {
    echo: (_root: unknown, args: { c: string }) => args.c,
    fail: (_root: unknown, args: { c: string }): never => {
      throw new Error(`lookup failed for ${args.c} (${EMAIL})`);
    },
  },
};

const collector = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: string | Uint8Array, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .split('\n')
          .filter((line) => line.trim() !== '')
      );
      callback();
    },
  });
  return { lines, stream };
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * The shared plugin (operation logging included), as the legacy entrypoint mounts it. Both
 * entrypoints disable Fastify's own request logging (api.ts, build-redesign-app.ts).
 */
const pluginApp = async (isProduction: boolean, stream: Writable) => {
  const app = fastifyLib({ logger: { level: 'info', stream }, disableRequestLogging: true });
  apps.push(app);
  await app.register(
    makeGraphQLPlugin({
      schema: [TYPE_DEFS],
      resolvers: [RESOLVERS],
      isProduction,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  return app;
};

/** Mercurius as the redesign entrypoint mounts it, with a given formatter. */
const rawApp = async (
  errorFormatter: NonNullable<MercuriusOptions['errorFormatter']>,
  stream: Writable
) => {
  const app = fastifyLib({ logger: { level: 'info', stream }, disableRequestLogging: true });
  apps.push(app);
  await app.register(mercuriusPlugin, {
    schema: makeExecutableSchema({ typeDefs: TYPE_DEFS, resolvers: RESOLVERS }),
    path: '/graphql',
    errorFormatter,
  });
  await app.ready();
  return app;
};

const ECHO = 'query($c: String!) { echo(c: $c) }';
const FAIL = 'query($c: String!) { fail(c: $c) }';

/** A mistyped variable (a number for String!) over GET and POST, and a resolver error quoting it. */
const send = async (app: FastifyInstance) => [
  await app.inject({
    method: 'GET',
    url: `/graphql?query=${encodeURIComponent(ECHO)}&variables=${encodeURIComponent(
      JSON.stringify({ c: Number(CODE) })
    )}`,
  }),
  await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query: ECHO, variables: { c: Number(CODE) } }),
  }),
  await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query: FAIL, variables: { c: CODE } }),
  }),
];

describe('GraphQL error logging (PRJ-DMHY)', () => {
  it('redacts 11+ digit runs, also written with separators, and e-mail addresses', () => {
    expect(redactLoggedText(`got ${CODE} and 196 0101 123456 and ${EMAIL}`)).toBe(
      'got [digits] and [digits] and [email]'
    );
    // Fullwidth digits fold to ASCII first.
    expect(redactLoggedText('１９６０１０１１２３４５６')).toBe('[digits]');
    // Short numbers stay (an organization code, a count, a line number).
    expect(redactLoggedText('code 14399840, line 12')).toBe('code 14399840, line 12');
  });

  for (const isProduction of [false, true])
    it(`logs no caller value from an error (shared plugin, production ${String(isProduction)})`, async () => {
      const logs = collector();
      const responses = await send(await pluginApp(isProduction, logs.stream));
      // The requests reached their error paths.
      expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 200]);
      const raw = logs.lines.join('\n');
      expect(raw).not.toContain(CODE);
      expect(raw).not.toContain('example.ro');
      // The errors are still logged, redacted.
      const logged = logs.lines.filter((line) => line.includes('"msg":"GraphQL error"'));
      expect(logged.length).toBeGreaterThanOrEqual(3);
      expect(logged.join('\n')).toContain('[digits]');
    });

  it('logs no caller value through the redesign registration either', async () => {
    const logs = collector();
    await send(await rawApp(makeGraphQLErrorFormatter(false), logs.stream));
    const raw = logs.lines.join('\n');
    expect(raw).not.toContain(CODE);
    expect(raw).not.toContain('example.ro');
  });

  it('leaves the client-facing response as Mercurius formats it', async () => {
    const ours = await send(await rawApp(makeGraphQLErrorFormatter(false), collector().stream));
    const theirs = await send(
      await rawApp(mercuriusPlugin.defaultErrorFormatter, collector().stream)
    );
    expect(ours.map((response) => [response.statusCode, response.json<unknown>()])).toEqual(
      theirs.map((response) => [response.statusCode, response.json<unknown>()])
    );
  });

  it('keeps the production redaction of internal messages', async () => {
    const [, , failed] = await send(
      await rawApp(makeGraphQLErrorFormatter(true), collector().stream)
    );
    expect(failed?.json<{ errors: { message: string }[] }>().errors[0]?.message).toBe(
      'Internal server error'
    );
  });
});
