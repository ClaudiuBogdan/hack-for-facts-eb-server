import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { createFilesystemError, type AdminEventError } from '../../core/errors.js';
import { AdminEventExportBundleSchema } from '../../core/schemas.js';
import { validateSchema } from '../../core/validation.js';

import type { AdminEventBundleStore } from '../../core/ports.js';
import type { AdminEventExportManifest } from '../../core/types.js';

const INPUT_FILENAME = 'input.json';
const OUTCOME_FILENAME = 'outcome.json';
const MANIFEST_FILENAME = 'manifest.json';

const sanitizeDirectoryName = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-');
};

const toFilesystemError = (message: string, error: unknown): AdminEventError => {
  return createFilesystemError(
    `${message}: ${error instanceof Error ? error.message : 'Unknown filesystem error'}`,
    true
  );
};

const safeJsonParse = fromThrowable(JSON.parse);

export const makeLocalAdminEventBundleStore = (): AdminEventBundleStore => {
  return {
    async writeExport(input): Promise<Result<AdminEventExportManifest, AdminEventError>> {
      try {
        const exportRoot = path.resolve(input.outputDir, input.exportId);
        await mkdir(exportRoot, { recursive: true });

        const jobs = input.bundles.map((bundle) => {
          const bundleDir = path.join(exportRoot, sanitizeDirectoryName(bundle.jobId));
          return {
            bundle,
            bundleDir,
          };
        });

        for (const job of jobs) {
          await mkdir(job.bundleDir, { recursive: true });
          await writeFile(
            path.join(job.bundleDir, INPUT_FILENAME),
            `${JSON.stringify(job.bundle, null, 2)}\n`,
            'utf8'
          );
          await writeFile(path.join(job.bundleDir, OUTCOME_FILENAME), '{}\n', 'utf8');
        }

        const manifest: AdminEventExportManifest = {
          exportId: input.exportId,
          exportedAt: input.bundles[0]?.exportMetadata.exportedAt ?? new Date().toISOString(),
          workspace: exportRoot,
          jobs: jobs.map((job) => ({
            jobId: job.bundle.jobId,
            eventType: job.bundle.eventType,
            bundleDir: job.bundleDir,
          })),
          skippedJobs: [],
        };

        await writeFile(
          path.join(exportRoot, MANIFEST_FILENAME),
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf8'
        );

        return ok(manifest);
      } catch (error) {
        return err(toFilesystemError('Failed to write admin event export bundle', error));
      }
    },

    async readInput(bundleDir) {
      try {
        const raw = await readFile(path.join(bundleDir, INPUT_FILENAME), 'utf8');
        const parsedResult = safeJsonParse(raw);
        if (parsedResult.isErr()) {
          return err(toFilesystemError(`Failed to parse ${INPUT_FILENAME}`, parsedResult.error));
        }

        const parsed = parsedResult.value as unknown;
        return validateSchema(
          AdminEventExportBundleSchema,
          parsed,
          'Invalid admin event input bundle'
        );
      } catch (error) {
        return err(toFilesystemError(`Failed to read ${INPUT_FILENAME}`, error));
      }
    },

    async readOutcome(bundleDir) {
      try {
        const raw = await readFile(path.join(bundleDir, OUTCOME_FILENAME), 'utf8');
        const parsedResult = safeJsonParse(raw);
        if (parsedResult.isErr()) {
          return err(toFilesystemError(`Failed to parse ${OUTCOME_FILENAME}`, parsedResult.error));
        }

        return ok(parsedResult.value as unknown);
      } catch (error) {
        return err(toFilesystemError(`Failed to read ${OUTCOME_FILENAME}`, error));
      }
    },
  };
};
