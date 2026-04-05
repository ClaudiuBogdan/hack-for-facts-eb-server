import {
  createAdminEventScriptContext,
  reconcileAdminEventQueue,
} from '../src/modules/admin-events/index.js';

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const main = async (): Promise<void> => {
  const context = await createAdminEventScriptContext();

  try {
    const eventTypesArg = getArgValue('--event-types');
    const limitArg = getArgValue('--limit');
    const result = await reconcileAdminEventQueue(
      {
        registry: context.registry,
        queue: context.queue,
      },
      {
        ...(limitArg !== undefined ? { limit: Number.parseInt(limitArg, 10) } : {}),
        ...(eventTypesArg !== undefined && eventTypesArg !== ''
          ? {
              eventTypes: eventTypesArg
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
