import type { LearningProgressEvent } from '../core/types.js';
import type { Logger } from 'pino';

export interface LearningProgressPostSyncHookInput {
  userId: string;
  events: readonly LearningProgressEvent[];
}

export interface NamedLearningProgressPostSyncHook {
  name: string;
  run(input: LearningProgressPostSyncHookInput): Promise<void>;
}

export interface LearningProgressPostSyncHookRunnerDeps {
  hooks: readonly NamedLearningProgressPostSyncHook[];
  logger: Logger;
}

export const createLearningProgressPostSyncHookRunner = (
  deps: LearningProgressPostSyncHookRunnerDeps
) => {
  const log = deps.logger.child({ component: 'learning-progress-post-sync-hooks' });

  return async (input: LearningProgressPostSyncHookInput): Promise<void> => {
    for (const hook of deps.hooks) {
      try {
        await hook.run(input);
      } catch (error) {
        log.error(
          {
            err: error,
            hookName: hook.name,
            userId: input.userId,
            eventCount: input.events.length,
          },
          'Learning progress post-sync hook failed'
        );
      }
    }
  };
};
