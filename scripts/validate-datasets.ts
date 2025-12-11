import path from 'node:path';

import { createDatasetRepo } from '../src/modules/datasets/shell/repo/fs-repo.js';

const DATASETS_DIR = path.resolve(process.cwd(), 'datasets/yaml');

const errorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') {
      return maybeMessage;
    }
  }

  return String(error);
};

const formatError = (datasetId: string, relativePath: string, error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return `${datasetId} (${relativePath}): ${errorMessage(error)}`;
  }

  const { type } = error as { type?: string };
  if (type === 'SchemaValidationError') {
    const details = Array.isArray((error as { details?: unknown }).details)
      ? ((error as { details?: unknown[] }).details ?? []).map((d) => String(d))
      : [];
    const message = errorMessage(error);
    if (details.length > 0) {
      return `${datasetId} (${relativePath}): ${message}\n  - ${details.join('\n  - ')}`;
    }
    return `${datasetId} (${relativePath}): ${message}`;
  }

  return `${datasetId} (${relativePath}): ${errorMessage(error)}`;
};

const main = async (): Promise<void> => {
  const repo = createDatasetRepo({ rootDir: DATASETS_DIR });
  const listResult = await repo.listAvailable();

  if (listResult.isErr()) {
    console.error(listResult.error.message);
    process.exit(1);
  }

  const files = listResult.value;

  if (files.length === 0) {
    console.warn('No dataset files found under datasets/yaml');
    return;
  }

  const errors: string[] = [];
  const metadataIds = new Map<string, string>();

  for (const file of files) {
    const result = await repo.getById(file.id);

    if (result.isErr()) {
      if (result.error.type === 'IdMismatch') {
        const metadataId = result.error.actual;
        const existingPath = metadataIds.get(metadataId);
        if (typeof existingPath === 'string') {
          errors.push(
            `Duplicate metadata.id '${metadataId}' found in ${existingPath} and ${file.relativePath}`
          );
        } else {
          metadataIds.set(metadataId, file.relativePath);
        }
      }

      errors.push(formatError(file.id, file.relativePath, result.error));
      continue;
    }

    const metadataId = result.value.metadata.id;
    const existingPath = metadataIds.get(metadataId);
    if (typeof existingPath === 'string') {
      errors.push(
        `Duplicate metadata.id '${metadataId}' found in ${existingPath} and ${file.relativePath}`
      );
    } else {
      metadataIds.set(metadataId, file.relativePath);
    }
  }

  if (errors.length > 0) {
    console.error('Dataset validation failed:\n');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${String(files.length)} dataset(s) successfully.`);
};

await main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
