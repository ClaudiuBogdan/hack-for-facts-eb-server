import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type AdminEventError } from '../errors.js';
import { validateSchema } from '../validation.js';

import type { AdminEventBundleStore, AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';
import type { AdminEventApplyResult } from '../types.js';

export interface ApplyAdminEventOutcomeDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
  bundleStore: AdminEventBundleStore;
}

export interface ApplyAdminEventOutcomeInput {
  bundleDir: string;
}

export const applyAdminEventOutcome = async (
  deps: ApplyAdminEventOutcomeDeps,
  input: ApplyAdminEventOutcomeInput
): Promise<Result<AdminEventApplyResult, AdminEventError>> => {
  const inputResult = await deps.bundleStore.readInput(input.bundleDir);
  if (inputResult.isErr()) {
    return err(inputResult.error);
  }

  const exportBundle = inputResult.value;
  const definitionResult = deps.registry.get(exportBundle.eventType);
  if (definitionResult.isErr()) {
    return err(definitionResult.error);
  }

  const definition = definitionResult.value;
  const payloadResult = validateSchema(
    definition.payloadSchema,
    exportBundle.payload,
    `Invalid admin event payload for "${exportBundle.eventType}"`
  );
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }
  const payload = payloadResult.value as Record<string, unknown>;

  const outcomeRawResult = await deps.bundleStore.readOutcome(input.bundleDir);
  if (outcomeRawResult.isErr()) {
    return err(outcomeRawResult.error);
  }

  const outcomeResult = validateSchema(
    definition.outcomeSchema,
    outcomeRawResult.value,
    `Invalid admin event outcome for "${exportBundle.eventType}"`
  );
  if (outcomeResult.isErr()) {
    return err(outcomeResult.error);
  }
  const outcome = outcomeResult.value as Record<string, unknown>;

  const jobResult = await deps.queue.get(exportBundle.jobId);
  if (jobResult.isErr()) {
    return err(jobResult.error);
  }

  if (jobResult.value === null) {
    return err(createNotFoundError(`Admin event job "${exportBundle.jobId}" was not found.`));
  }

  const liveContextResult = await definition.loadContext(payload);
  if (liveContextResult.isErr()) {
    return err(liveContextResult.error);
  }

  const classifiedState = definition.classifyState({
    payload,
    context: liveContextResult.value,
    outcome,
    exportBundle,
  });

  if (classifiedState === 'already_applied') {
    const removeResult = await deps.queue.remove(exportBundle.jobId);
    if (removeResult.isErr()) {
      return ok({
        status: 'already_applied',
        jobId: exportBundle.jobId,
        eventType: exportBundle.eventType,
        queueJobRemoved: false,
        queueCleanupPending: true,
        message: removeResult.error.message,
      });
    }

    return ok({
      status: 'already_applied',
      jobId: exportBundle.jobId,
      eventType: exportBundle.eventType,
      queueJobRemoved: removeResult.value,
      queueCleanupPending: !removeResult.value,
      message: 'Admin event outcome was already applied; queue cleanup attempted.',
    });
  }

  if (classifiedState === 'stale') {
    return ok({
      status: 'stale',
      jobId: exportBundle.jobId,
      eventType: exportBundle.eventType,
      queueJobRemoved: false,
      queueCleanupPending: false,
      message: 'Admin event export is stale and must be refreshed before apply.',
    });
  }

  if (classifiedState === 'not_actionable') {
    return ok({
      status: 'not_actionable',
      jobId: exportBundle.jobId,
      eventType: exportBundle.eventType,
      queueJobRemoved: false,
      queueCleanupPending: false,
      message: 'Admin event is no longer actionable.',
    });
  }

  if (liveContextResult.value === null) {
    return ok({
      status: 'not_actionable',
      jobId: exportBundle.jobId,
      eventType: exportBundle.eventType,
      queueJobRemoved: false,
      queueCleanupPending: false,
      message: 'Admin event is no longer actionable because the referenced row is missing.',
    });
  }

  const applyResult = await definition.applyOutcome({
    payload,
    context: liveContextResult.value,
    outcome,
  });
  if (applyResult.isErr()) {
    return err(applyResult.error);
  }

  const removeResult = await deps.queue.remove(exportBundle.jobId);
  if (removeResult.isErr()) {
    return ok({
      status: 'applied',
      jobId: exportBundle.jobId,
      eventType: exportBundle.eventType,
      queueJobRemoved: false,
      queueCleanupPending: true,
      message: removeResult.error.message,
    });
  }

  return ok({
    status: 'applied',
    jobId: exportBundle.jobId,
    eventType: exportBundle.eventType,
    queueJobRemoved: removeResult.value,
    queueCleanupPending: !removeResult.value,
    message: 'Admin event outcome applied successfully.',
  });
};
