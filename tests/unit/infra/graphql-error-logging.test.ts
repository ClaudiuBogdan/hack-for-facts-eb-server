/**
 * PRJ-DMHY: a GraphQL error message can quote a value the caller sent (a variable-coercion
 * error quotes it whole, in any spelling), and a path key or an operation name is chosen by the
 * caller, so the shared formatter and the operation log write fixed categories only. The
 * response the client gets is unchanged.
 */

import { Writable } from 'node:stream';

import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance } from 'fastify';
import mercuriusPlugin, { type MercuriusOptions } from 'mercurius';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  loggedGraphQLErrors,
  loggedOperationType,
  makeGraphQLErrorFormatter,
} from '@/infra/graphql/security.js';

/** A synthetic CNP-shaped value (never a real person's). */
const CODE = '1960101123456';

const TYPE_DEFS = /* GraphQL */ `
  type Query {
    echo(c: String!): String
    fail(c: String!): String
    many: String
  }
`;
const RESOLVERS = {
  Query: {
    echo: (_root: unknown, args: { c: string }) => args.c,
    fail: (_root: unknown, args: { c: string }): never => {
      throw new Error(`lookup failed for ${args.c}`);
    },
    many: (): never => {
      throw new AggregateError([`detail ${CODE}`]);
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

/** The logged text without the logger's own numbers (time, pid). */
const callerText = (lines: readonly string[]): string =>
  lines.join('\n').replace(/"(time|pid)":[0-9]+/gu, '');

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

/** Mercurius as the redesign entrypoint registers it, with a given formatter. */
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

const post = (app: FastifyInstance, query: string, variables: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });

/** Caller values in every spelling an error can carry them. */
const send = async (app: FastifyInstance) => [
  // A mistyped variable (a number for String!), over GET and POST.
  await app.inject({
    method: 'GET',
    url: `/graphql?query=${encodeURIComponent(ECHO)}&variables=${encodeURIComponent(
      JSON.stringify({ c: Number(CODE) })
    )}`,
  }),
  await post(app, ECHO, { c: Number(CODE) }),
  // A resolver error quoting a dotted, tab-split and encoded value.
  await post(app, FAIL, { c: `196.0101.123456 196\t0101\t123456 ion%40example.ro` }),
  // A literal in exponent form, an alias and an operation name with the code.
  await post(app, '{ echo(c: 1960.101123456e9) }'),
  await post(app, `{ id${CODE}: fail(c: "x") }`),
  await post(app, `query q${CODE} { fail(c: "x") }`),
  // Caller text with no digits at all: a person's name as an operation name and as an alias.
  await post(app, 'query Alice_Smith { fail(c: "x") }'),
  await post(app, '{ AliceSmith: fail(c: "x") }'),
  // An error with no message of its own.
  await post(app, '{ many }'),
];

describe('GraphQL error logging (PRJ-DMHY)', () => {
  it('logs categories only, whatever the error carries', () => {
    const throwing = Object.defineProperty({}, 'path', {
      get: () => {
        throw new Error('getter');
      },
    });
    const named = new Error('x');
    named.name = 'AliceSmith';
    expect(
      loggedGraphQLErrors([
        { message: `x ${CODE}`, extensions: { code: 'BAD_USER_INPUT' }, path: [`id${CODE}`, 0] },
        { message: `x ${CODE}`, locations: [{ line: 1, column: 2 }] },
        { message: 'x', originalError: new TypeError(`y ${CODE}`), path: ['a'] },
        { message: 'x', extensions: { code: 'ALICE_SMITH' } },
        { message: 'x', extensions: { code: 'MER_ERR_GQL_VALIDATION' } },
        { message: 'x', originalError: named },
        throwing,
        null,
        'text',
      ])
    ).toEqual([
      { category: 'BAD_USER_INPUT', kind: 'execution', pathDepth: 2 },
      { category: 'unknown', kind: 'validation', pathDepth: null },
      { category: 'TypeError', kind: 'execution', pathDepth: 1 },
      { category: 'other_code', kind: 'request', pathDepth: null },
      { category: 'MER_ERR_GQL_VALIDATION', kind: 'request', pathDepth: null },
      { category: 'other_error', kind: 'request', pathDepth: null },
      { category: 'unknown', kind: 'request', pathDepth: null },
      { category: 'unknown', kind: 'request', pathDepth: null },
      { category: 'unknown', kind: 'request', pathDepth: null },
    ]);
    expect(loggedOperationType('query')).toBe('query');
    expect(loggedOperationType('AliceSmith')).toBe('unknown');
  });

  for (const isProduction of [false, true])
    it(`logs no caller value (shared plugin, production ${String(isProduction)})`, async () => {
      const logs = collector();
      const responses = await send(await pluginApp(isProduction, logs.stream));
      // Every request reached an error path.
      for (const response of responses)
        expect(JSON.stringify(response.json<unknown>())).toContain('errors');
      const text = callerText(logs.lines);
      // No run of four digits at all, no address, no alias or operation name with the code.
      expect(text).not.toMatch(/[0-9]{4}/u);
      expect(text).not.toContain('example');
      expect(text).not.toContain('Alice');
      // The errors and the operation warning are still logged.
      expect(
        logs.lines.filter((line) => line.includes('"msg":"GraphQL error"')).length
      ).toBeGreaterThanOrEqual(responses.length);
      expect(logs.lines.some((line) => line.includes('completed with 1 error(s)'))).toBe(true);
    });

  it('logs no caller value through the redesign registration either', async () => {
    const logs = collector();
    await send(await rawApp(makeGraphQLErrorFormatter(false), logs.stream));
    const text = callerText(logs.lines);
    expect(text).not.toMatch(/[0-9]{4}/u);
    expect(text).not.toContain('example');
    expect(text).not.toContain('Alice');
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
