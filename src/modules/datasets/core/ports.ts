import { Result } from 'neverthrow';

import { DatasetRepoError } from './errors.js';
import { Dataset, DatasetFileEntry } from './types.js';

export interface DatasetRepo {
  /**
   * Get a single dataset by ID.
   */
  getById(id: string): Promise<Result<Dataset, DatasetRepoError>>;

  /**
   * List all available dataset file entries (metadata only).
   */
  listAvailable(): Promise<Result<DatasetFileEntry[], DatasetRepoError>>;

  /**
   * Get multiple datasets by IDs.
   * Non-existent IDs are silently omitted from results.
   */
  getByIds(ids: string[]): Promise<Result<Dataset[], DatasetRepoError>>;

  /**
   * Get all datasets with full metadata.
   * Used for search/filter operations.
   */
  getAllWithMetadata(): Promise<Result<Dataset[], DatasetRepoError>>;
}
