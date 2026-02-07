/**
 * List latest INS values per dataset for a selected entity.
 */

import { err, ok, type Result } from 'neverthrow';

import { createInvalidFilterError, type InsError } from '../errors.js';

import type { InsRepository } from '../ports.js';
import type {
  InsLatestDatasetValue,
  ListInsLatestDatasetValuesInput,
  InsEntitySelectorInput,
} from '../types.js';

export interface ListInsLatestDatasetValuesDeps {
  insRepo: InsRepository;
}

const normalizeEntitySelector = (
  entity: InsEntitySelectorInput
): Result<InsEntitySelectorInput, InsError> => {
  const sirutaCode = entity.siruta_code?.trim();
  const territoryCode = entity.territory_code?.trim();
  const territoryLevel = entity.territory_level;

  const hasSiruta = sirutaCode !== undefined && sirutaCode !== '';
  const hasTerritory = territoryCode !== undefined && territoryCode !== '';
  const hasTerritoryLevel = territoryLevel !== undefined;

  if (hasSiruta && (hasTerritory || hasTerritoryLevel)) {
    return err(
      createInvalidFilterError(
        'entity',
        'Provide either sirutaCode or territoryCode+territoryLevel, not both'
      )
    );
  }

  if (hasSiruta) {
    return ok({ siruta_code: sirutaCode });
  }

  if (hasTerritory && hasTerritoryLevel) {
    return ok({ territory_code: territoryCode, territory_level: territoryLevel });
  }

  return err(
    createInvalidFilterError('entity', 'Provide either sirutaCode or territoryCode+territoryLevel')
  );
};

export const listInsLatestDatasetValues = async (
  deps: ListInsLatestDatasetValuesDeps,
  input: ListInsLatestDatasetValuesInput
): Promise<Result<InsLatestDatasetValue[], InsError>> => {
  const normalizedCodes = Array.from(
    new Set(input.dataset_codes.map((code) => code.trim()).filter((code) => code !== ''))
  );

  if (normalizedCodes.length === 0) {
    return ok([]);
  }

  const normalizedEntity = normalizeEntitySelector(input.entity);
  if (normalizedEntity.isErr()) {
    return err(normalizedEntity.error);
  }

  const preferredClassificationCodes =
    input.preferred_classification_codes !== undefined
      ? Array.from(
          new Set(
            input.preferred_classification_codes
              .map((code) => code.trim())
              .filter((code) => code !== '')
          )
        )
      : undefined;

  const request: ListInsLatestDatasetValuesInput = {
    entity: normalizedEntity.value,
    dataset_codes: normalizedCodes,
  };

  if (preferredClassificationCodes !== undefined) {
    request.preferred_classification_codes = preferredClassificationCodes;
  }

  return deps.insRepo.listLatestDatasetValues(request);
};
