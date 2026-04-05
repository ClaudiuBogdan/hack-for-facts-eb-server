import { randomUUID } from 'node:crypto';

import {
  createAdminEventScriptContext,
  exportAdminEventBundles,
} from '../src/modules/admin-events/index.js';

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const main = async (): Promise<void> => {
  const context = await createAdminEventScriptContext();

  try {
    const eventTypesArg = getArgValue('--event-types');
    const jobIdsArg = getArgValue('--job-ids');
    const outputDir = getArgValue('--output-dir') ?? context.defaultExportDir;
    const limitArg = getArgValue('--limit');
    const exportId = getArgValue('--export-id') ?? `admin-events-${randomUUID()}`;

    const result = await exportAdminEventBundles(
      {
        registry: context.registry,
        queue: context.queue,
        bundleStore: context.bundleStore,
      },
      {
        exportId,
        outputDir,
        workspace: outputDir,
        environment: context.config.server.isProduction
          ? 'production'
          : context.config.server.isTest
            ? 'test'
            : 'development',
        ...(limitArg !== undefined ? { limit: Number.parseInt(limitArg, 10) } : {}),
        ...(eventTypesArg !== undefined && eventTypesArg !== ''
          ? {
              eventTypes: eventTypesArg
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value !== ''),
            }
          : {}),
        ...(jobIdsArg !== undefined && jobIdsArg !== ''
          ? {
              jobIds: jobIdsArg
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value !== ''),
            }
          : {}),
      }
    );

    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    console.log(JSON.stringify(result.value, null, 2));
  } finally {
    await context.close();
  }
};

await main();
