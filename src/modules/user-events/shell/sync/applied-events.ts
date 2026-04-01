import type { LearningProgressAppliedEventHandler } from '../../core/ports.js';
import type { LearningProgressEvent } from '@/modules/learning-progress/index.js';
import type { Logger } from 'pino';

export interface ProcessLearningProgressAppliedEventsDeps {
  handlers: readonly LearningProgressAppliedEventHandler[];
  logger: Logger;
}

export interface ProcessLearningProgressAppliedEventsInput {
  userId: string;
  events: readonly LearningProgressEvent[];
}

export const processLearningProgressAppliedEvents = async (
  deps: ProcessLearningProgressAppliedEventsDeps,
  input: ProcessLearningProgressAppliedEventsInput
): Promise<void> => {
  const { handlers, logger } = deps;

  for (const event of input.events) {
    const matchedHandlers = handlers.filter((handler) => handler.matches(event));

    for (const handler of matchedHandlers) {
      logger.debug(
        {
          handler: handler.name,
          eventType: event.type,
          eventId: event.eventId,
          userId: input.userId,
        },
        'Dispatching sync learning-progress handler'
      );

      await handler.handle({
        userId: input.userId,
        event,
      });
    }
  }
};
