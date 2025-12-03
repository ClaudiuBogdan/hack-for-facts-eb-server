export { createDatasetRepo, type DatasetRepoOptions } from './shell/repo/fs-repo.js';
export type { DatasetRepo } from './core/ports.js';
export { parseDataset } from './core/usecases/parse-dataset.js';
export type { Dataset, DatasetFileDTO, DataPoint } from './core/types.js';
export type { DatasetValidationError, DatasetRepoError } from './core/errors.js';
