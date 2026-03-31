import type { UserEventJobPayload } from './types.js';

export interface UserEventPublisher {
  publish(job: UserEventJobPayload): Promise<void>;
  publishMany(jobs: readonly UserEventJobPayload[]): Promise<void>;
}

export interface UserEventHandler {
  /**
   * Handlers may be retried after partial success when another matched handler fails.
   * Implementations must therefore be idempotent and safe to re-run.
   */
  name: string;
  matches(event: UserEventJobPayload): boolean;
  handle(event: UserEventJobPayload): Promise<void>;
}
