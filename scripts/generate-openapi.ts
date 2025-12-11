/**
 * Generate offline OpenAPI YAML for the GPT REST API.
 *
 * This script does not expose any HTTP route. It registers the GPT routes
 * with @fastify/swagger in dynamic mode, then writes the resulting spec to disk.
 *
 * Usage:
 *   pnpm openapi:yaml
 *   pnpm openapi:yaml ./docs/openapi.yaml
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import swagger from '@fastify/swagger';
// eslint-disable-next-line import-x/no-named-as-default -- fastify is the standard export name
import fastify from 'fastify';
import { ok } from 'neverthrow';
import yaml from 'yaml';

import { makeGptRoutes, type MakeGptRoutesDeps } from '../src/modules/mcp/shell/rest/gpt-routes.js';
import { gptOpenApiConfig } from '../src/modules/mcp/shell/rest/openapi.js';

const defaultOutPath = path.resolve(process.cwd(), 'docs/openapi.yaml');
const outArg = process.argv[2];
const outPath =
  typeof outArg === 'string' && outArg.trim() !== '' ? path.resolve(outArg) : defaultOutPath;

const main = async (): Promise<void> => {
  const app = fastify({ logger: false });

  await app.register(swagger, gptOpenApiConfig);

  // Stub deps: handlers are never invoked during spec generation.
  // We use empty objects cast to the expected types since the routes
  // are only registered to extract their schemas, not to execute handlers.
  const stubDeps: MakeGptRoutesDeps = {
    entityRepo: {} as MakeGptRoutesDeps['entityRepo'],
    executionRepo: {} as MakeGptRoutesDeps['executionRepo'],
    uatRepo: {} as MakeGptRoutesDeps['uatRepo'],
    functionalClassificationRepo: {} as MakeGptRoutesDeps['functionalClassificationRepo'],
    economicClassificationRepo: {} as MakeGptRoutesDeps['economicClassificationRepo'],
    entityAnalyticsRepo: {} as MakeGptRoutesDeps['entityAnalyticsRepo'],
    analyticsService: {} as MakeGptRoutesDeps['analyticsService'],
    aggregatedLineItemsRepo: {} as MakeGptRoutesDeps['aggregatedLineItemsRepo'],
    shareLink: {
      create: () => Promise.resolve(ok('')),
    },
    config: {
      clientBaseUrl: '',
    },
  };

  await app.register(
    makeGptRoutes({
      deps: stubDeps,
      auth: {
        apiKey: 'DUMMY',
      },
    })
  );

  await app.ready();

  const spec = app.swagger();
  const yamlText = yaml.stringify(spec);

  await writeFile(outPath, yamlText, { encoding: 'utf8' });

  console.info(`OpenAPI YAML written to ${outPath}`);

  await app.close();
};

await main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
