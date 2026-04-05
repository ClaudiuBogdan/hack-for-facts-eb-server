import {
  applyAdminEventOutcome,
  createAdminEventScriptContext,
} from '../src/modules/admin-events/index.js';

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const main = async (): Promise<void> => {
  const context = await createAdminEventScriptContext();

  try {
    const bundleDir = getArgValue('--bundle-dir');
    if (bundleDir === undefined || bundleDir === '') {
      throw new Error('--bundle-dir is required.');
    }

    const result = await applyAdminEventOutcome(
      {
        registry: context.registry,
        queue: context.queue,
        bundleStore: context.bundleStore,
      },
      {
        bundleDir,
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
