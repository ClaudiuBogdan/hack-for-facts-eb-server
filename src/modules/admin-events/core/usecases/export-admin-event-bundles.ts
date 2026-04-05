import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type AdminEventError } from '../errors.js';
import { listAdminEventJobs } from './list-admin-event-jobs.js';

import type { AdminEventBundleStore, AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';
import type { AdminEventExportManifest, AdminEventPendingJob } from '../types.js';

export interface ExportAdminEventBundlesDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
  bundleStore: AdminEventBundleStore;
}

export interface ExportAdminEventBundlesInput {
  outputDir: string;
  exportId: string;
  workspace: string;
  environment?: string;
  limit?: number;
  eventTypes?: readonly string[];
  jobIds?: readonly string[];
}

export const exportAdminEventBundles = async (
  deps: ExportAdminEventBundlesDeps,
  input: ExportAdminEventBundlesInput
): Promise<Result<AdminEventExportManifest, AdminEventError>> => {
  const jobsResult = await listAdminEventJobs(
    {
      registry: deps.registry,
      queue: deps.queue,
    },
    {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      ...(input.jobIds !== undefined ? { jobIds: input.jobIds } : {}),
    }
  );
  if (jobsResult.isErr()) {
    return err(jobsResult.error);
  }

  const jobs = jobsResult.value;
  if (jobs.length === 0) {
    return err(createNotFoundError('No admin event jobs matched the export request.'));
  }

  const exportedAt = new Date().toISOString();
  const bundles: {
    job: AdminEventPendingJob;
    bundle: import('../types.js').AdminEventExportBundle<Record<string, unknown>, unknown>;
  }[] = [];
  const skippedJobs: {
    jobId: string;
    eventType: string;
    reason: string;
  }[] = [];

  for (const job of jobs) {
    const definitionResult = deps.registry.get(job.envelope.eventType);
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }

    const definition = definitionResult.value;
    const contextResult = await definition.loadContext(job.envelope.payload);
    if (contextResult.isErr()) {
      return err(contextResult.error);
    }

    if (contextResult.value === null) {
      skippedJobs.push({
        jobId: job.jobId,
        eventType: job.envelope.eventType,
        reason: 'Referenced canonical row is missing.',
      });
      continue;
    }

    const baseBundle = definition.buildExportBundle({
      jobId: job.jobId,
      payload: job.envelope.payload,
      context: contextResult.value,
    });

    bundles.push({
      job,
      bundle: {
        ...baseBundle,
        exportMetadata: {
          exportId: input.exportId,
          exportedAt,
          workspace: input.workspace,
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        },
        outcomeSchema: definition.outcomeSchema,
      },
    });
  }

  const writeResult = await deps.bundleStore.writeExport({
    exportId: input.exportId,
    outputDir: input.outputDir,
    bundles: bundles.map((entry) => entry.bundle),
  });
  if (writeResult.isErr()) {
    return err(writeResult.error);
  }

  return ok({
    ...writeResult.value,
    skippedJobs,
  });
};
