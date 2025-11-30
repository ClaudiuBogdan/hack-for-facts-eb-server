import fs from 'node:fs/promises';

import { TypeCompiler } from '@sinclair/typebox/compiler';
import { err, ok, type Result } from 'neverthrow';
import { parse as parseYaml } from 'yaml';

import { LruCache } from './cache.js';
import { listDatasetFiles, type DatasetFileEntry } from './discovery.js';
import { formatSchemaErrors, type DatasetRepoError } from '../../core/errors.js';
import { parseDataset } from '../../core/logic.js';
import { DatasetFileSchema, type Dataset, type DatasetFileDTO } from '../../core/types.js';

const validator = TypeCompiler.Compile(DatasetFileSchema);

export interface DatasetRepoOptions {
  rootDir: string;
  cacheMax?: number;
  cacheTtlMs?: number;
}

export interface DatasetRepo {
  getById(id: string): Promise<Result<Dataset, DatasetRepoError>>;
  listAvailable(): Promise<Result<DatasetFileEntry[], DatasetRepoError>>;
}

const readDatasetFile = async (
  filePath: string
): Promise<Result<DatasetFileDTO, DatasetRepoError>> => {
  let contents: string;

  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return err({
        type: 'NotFound',
        message: `Dataset file not found at ${filePath}`,
      });
    }

    return err({
      type: 'ReadError',
      message: `Failed to read dataset file at ${filePath}: ${(error as Error).message}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(contents);
  } catch (error) {
    return err({
      type: 'ParseError',
      message: `Failed to parse YAML at ${filePath}: ${(error as Error).message}`,
    });
  }

  if (!validator.Check(parsed)) {
    const details = formatSchemaErrors(validator.Errors(parsed));
    return err({
      type: 'SchemaValidationError',
      message: `Schema validation failed for ${filePath}`,
      details,
    });
  }

  return ok(parsed);
};

export const createDatasetRepo = (options: DatasetRepoOptions): DatasetRepo => {
  const cache = new LruCache<string, Dataset>({
    max: options.cacheMax ?? 50,
    ttlMs: options.cacheTtlMs ?? 60 * 60 * 1000, // default 1 hour
  });

  interface DatasetIndex {
    entries: DatasetFileEntry[];
    map: Map<string, DatasetFileEntry>;
  }

  let index: DatasetIndex | null = null;
  let indexPromise: Promise<Result<DatasetIndex, DatasetRepoError>> | null = null;

  const buildIndex = async (): Promise<Result<DatasetIndex, DatasetRepoError>> => {
    let entries: DatasetFileEntry[];

    try {
      entries = await listDatasetFiles(options.rootDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return err({
          type: 'NotFound',
          message: `Datasets directory not found at ${options.rootDir}`,
        });
      }

      return err({
        type: 'ReadError',
        message: `Failed to read datasets under ${options.rootDir}: ${(error as Error).message}`,
      });
    }

    const map = new Map<string, DatasetFileEntry>();

    for (const entry of entries) {
      const existing = map.get(entry.id);
      if (existing !== undefined) {
        return err({
          type: 'DuplicateId',
          message: `Dataset id '${entry.id}' is defined in multiple files: ${existing.relativePath} and ${entry.relativePath}`,
          id: entry.id,
          files: [existing.absolutePath, entry.absolutePath],
        });
      }

      map.set(entry.id, entry);
    }

    return ok({ entries, map });
  };

  const ensureIndex = async (): Promise<Result<DatasetIndex, DatasetRepoError>> => {
    if (index !== null) {
      return ok(index);
    }

    indexPromise ??= buildIndex();

    const result = await indexPromise;
    if (result.isOk()) {
      index = result.value;
    } else {
      indexPromise = null;
    }

    return result;
  };

  return {
    async getById(id: string): Promise<Result<Dataset, DatasetRepoError>> {
      const cached = cache.get(id);
      if (cached !== undefined) {
        return ok(cached);
      }

      const indexResult = await ensureIndex();
      if (indexResult.isErr()) {
        return err(indexResult.error);
      }

      const entry = indexResult.value.map.get(id);
      if (entry === undefined) {
        return err({
          type: 'NotFound',
          message: `Dataset id '${id}' not found under ${options.rootDir}`,
        });
      }

      const readResult = await readDatasetFile(entry.absolutePath);

      if (readResult.isErr()) {
        return err(readResult.error);
      }

      const dto = readResult.value;

      if (dto.metadata.id !== id) {
        return err({
          type: 'IdMismatch',
          message: `metadata.id '${dto.metadata.id}' does not match requested id '${id}'`,
          expected: id,
          actual: dto.metadata.id,
        });
      }

      const parsed = parseDataset(dto);
      if (parsed.isErr()) {
        return err(parsed.error);
      }

      cache.set(id, parsed.value);
      return ok(parsed.value);
    },

    async listAvailable(): Promise<Result<DatasetFileEntry[], DatasetRepoError>> {
      const indexResult = await ensureIndex();
      if (indexResult.isErr()) {
        return err(indexResult.error);
      }

      return ok(indexResult.value.entries);
    },
  };
};
