import fs from 'node:fs';
import path from 'node:path';
import { datasetSchema } from './index';

export interface DatasetValidationOptions {
  datasetDirectory?: string;
  strictFilenameMatch?: boolean;
}

export interface DatasetValidationResult {
  datasetCount: number;
  datasetIds: string[];
}

export const DATASETS_DIRECTORY_DEFAULT =
  process.env.DATASET_DIRECTORY ?? path.join(process.cwd(), 'datasets');

export function validateDatasetsDirectory(
  options: DatasetValidationOptions = {},
): DatasetValidationResult {
  const datasetDirectory = options.datasetDirectory ?? DATASETS_DIRECTORY_DEFAULT;
  const strictFilenameMatch = options.strictFilenameMatch ?? true;

  if (!fs.existsSync(datasetDirectory)) {
    throw new Error(`Dataset directory "${datasetDirectory}" does not exist`);
  }

  const datasetFiles = fs
    .readdirSync(datasetDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .sort();

  if (datasetFiles.length === 0) {
    throw new Error(`No dataset files found in "${datasetDirectory}"`);
  }

  const seenIds = new Set<string>();

  for (const fileName of datasetFiles) {
    const filePath = path.join(datasetDirectory, fileName);
    const raw = fs.readFileSync(filePath, 'utf-8');

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Dataset file "${fileName}" contains invalid JSON: ${(error as Error).message}`,
      );
    }

    const parsed = datasetSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(
        `Dataset file "${fileName}" failed schema validation: ${parsed.error.message}`,
      );
    }

    const dataset = parsed.data;

    if (strictFilenameMatch) {
      const idFromFilename = fileName.replace(/\.json$/, '');
      if (dataset.id !== idFromFilename) {
        throw new Error(
          `Dataset id "${dataset.id}" must match its filename "${fileName}"`,
        );
      }
    }

    if (seenIds.has(dataset.id)) {
      throw new Error(`Duplicate dataset id "${dataset.id}" encountered`);
    }
    seenIds.add(dataset.id);
  }

  return {
    datasetCount: datasetFiles.length,
    datasetIds: Array.from(seenIds),
  };
}
