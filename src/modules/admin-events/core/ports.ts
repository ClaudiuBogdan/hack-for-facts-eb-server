import type { AdminEventError } from './errors.js';
import type {
  AdminEventExportBundle,
  AdminEventExportManifest,
  AdminEventPendingJob,
} from './types.js';
import type { Result } from 'neverthrow';

export interface AdminEventQueuePort {
  enqueue(input: {
    jobId: string;
    envelope: {
      eventType: string;
      schemaVersion: number;
      payload: Record<string, unknown>;
    };
  }): Promise<Result<void, AdminEventError>>;
  enqueueMany(
    input: readonly {
      jobId: string;
      envelope: {
        eventType: string;
        schemaVersion: number;
        payload: Record<string, unknown>;
      };
    }[]
  ): Promise<Result<void, AdminEventError>>;
  get(jobId: string): Promise<Result<AdminEventPendingJob | null, AdminEventError>>;
  listPending(limit?: number): Promise<Result<readonly AdminEventPendingJob[], AdminEventError>>;
  remove(jobId: string): Promise<Result<boolean, AdminEventError>>;
}

export interface AdminEventBundleStore {
  writeExport(input: {
    exportId: string;
    outputDir: string;
    bundles: readonly AdminEventExportBundle<Record<string, unknown>, unknown>[];
  }): Promise<Result<AdminEventExportManifest, AdminEventError>>;
  readInput(
    bundleDir: string
  ): Promise<Result<AdminEventExportBundle<Record<string, unknown>, unknown>, AdminEventError>>;
  readOutcome(bundleDir: string): Promise<Result<unknown, AdminEventError>>;
}
