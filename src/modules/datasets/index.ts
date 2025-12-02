export {
  createDatasetRepo,
  type DatasetRepo,
  type DatasetRepoOptions,
} from './shell/repo/fs-repo.js';
export { parseDataset } from './core/logic.js';
export type { Dataset, DatasetFileDTO, DataPoint } from './core/types.js';
export type { DatasetValidationError, DatasetRepoError } from './core/errors.js';
