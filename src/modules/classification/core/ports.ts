/**
 * Classification Module Ports
 *
 * Repository interfaces for classification data access.
 */

import type { ClassificationError } from './errors.js';
import type {
  EconomicClassification,
  EconomicClassificationConnection,
  EconomicClassificationFilter,
  FunctionalClassification,
  FunctionalClassificationConnection,
  FunctionalClassificationFilter,
} from './types.js';
import type { Result } from 'neverthrow';

/**
 * Repository for functional classifications.
 */
export interface FunctionalClassificationRepository {
  /**
   * Get a single functional classification by code.
   */
  getByCode(code: string): Promise<Result<FunctionalClassification | null, ClassificationError>>;

  /**
   * List functional classifications with filtering and pagination.
   */
  list(
    filter: FunctionalClassificationFilter,
    limit: number,
    offset: number
  ): Promise<Result<FunctionalClassificationConnection, ClassificationError>>;
}

/**
 * Repository for economic classifications.
 */
export interface EconomicClassificationRepository {
  /**
   * Get a single economic classification by code.
   */
  getByCode(code: string): Promise<Result<EconomicClassification | null, ClassificationError>>;

  /**
   * List economic classifications with filtering and pagination.
   */
  list(
    filter: EconomicClassificationFilter,
    limit: number,
    offset: number
  ): Promise<Result<EconomicClassificationConnection, ClassificationError>>;
}
