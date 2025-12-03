import { Result } from 'neverthrow';

import { DatasetRepoError } from './errors.js';
import { Dataset, DatasetFileEntry } from './types.js';

export interface DatasetRepo {
  getById(id: string): Promise<Result<Dataset, DatasetRepoError>>;
  listAvailable(): Promise<Result<DatasetFileEntry[], DatasetRepoError>>;
}
