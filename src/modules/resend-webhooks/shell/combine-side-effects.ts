import type { ResendWebhookSideEffect } from '../core/ports.js';
import type { Logger } from 'pino';

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error('Unknown resend webhook side effect error');
};

export const combineResendWebhookSideEffects = (
  sideEffects: readonly ResendWebhookSideEffect[],
  logger: Logger
): ResendWebhookSideEffect | undefined => {
  if (sideEffects.length === 0) {
    return undefined;
  }

  if (sideEffects.length === 1) {
    return sideEffects[0];
  }

  const log = logger.child({ component: 'CombinedResendWebhookSideEffect' });

  return {
    async handle(input) {
      const failures: Error[] = [];

      for (const [index, sideEffect] of sideEffects.entries()) {
        try {
          await sideEffect.handle(input);
        } catch (error) {
          const normalizedError = toError(error);
          log.error(
            {
              index,
              error: normalizedError,
            },
            'Resend webhook side effect failed'
          );
          failures.push(normalizedError);
        }
      }

      if (failures.length === 0) {
        return;
      }

      if (failures.length === 1) {
        const firstFailure = failures[0];
        if (firstFailure !== undefined) {
          throw firstFailure;
        }
      }

      throw new Error(
        `${String(failures.length)} resend webhook side effects failed: ${failures
          .map((failure) => failure.message)
          .join('; ')}`
      );
    },
  };
};
