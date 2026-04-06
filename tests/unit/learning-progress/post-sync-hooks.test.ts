import { describe, expect, it, vi } from 'vitest';

import { createLearningProgressPostSyncHookRunner } from '@/modules/learning-progress/shell/post-sync-hooks.js';

const createLoggerSpy = () => {
  const logger = {
    child: vi.fn(),
    error: vi.fn(),
  };

  logger.child.mockReturnValue(logger);

  return logger;
};

describe('createLearningProgressPostSyncHookRunner', () => {
  it('continues running later hooks after one hook fails', async () => {
    const logger = createLoggerSpy();
    const firstHook = vi.fn(async () => {
      throw new Error('first hook failed');
    });
    const secondHook = vi.fn(async () => undefined);
    const runner = createLearningProgressPostSyncHookRunner({
      hooks: [
        { name: 'first', run: firstHook },
        { name: 'second', run: secondHook },
      ],
      logger: logger as never,
    });

    await runner({
      userId: 'user-1',
      events: [],
    });

    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hookName: 'first',
        userId: 'user-1',
        eventCount: 0,
        err: expect.any(Error),
      }),
      'Learning progress post-sync hook failed'
    );
  });
});
