import { err, ok, type Result } from 'neverthrow';

import { hashSchema } from '@/common/canonical-json/index.js';

import {
  createUnknownCategory,
  createUnknownSchemaVersion,
  type UserDataError,
} from '../errors.js';
import { type CategoryDefinition, type ResolvedCategory } from './types.js';

const GLOBAL_BYTE_LIMIT = 65_536;

export interface CategoryRegistry {
  get(category: string): CategoryDefinition | undefined;
  resolve(category: string, schemaVersion: number): Result<ResolvedCategory, UserDataError>;
  list(): readonly CategoryDefinition[];
}

const validateCategory = (category: CategoryDefinition): Result<void, string> => {
  if (category.maxPayloadBytes > GLOBAL_BYTE_LIMIT)
    return err(`${category.category}: maxPayloadBytes exceeds global ceiling`);
  const versions = [...category.schemaVersions].map(({ version }) => version).sort((a, b) => a - b);
  if (versions.length === 0 || versions.some((version, index) => version !== index + 1))
    return err(`${category.category}: schema versions must be unique and dense from 1`);
  for (const version of category.schemaVersions) {
    const hash = hashSchema(version.schema);
    if (hash.isErr() || hash.value !== version.schemaHash)
      return err(
        `${category.category}: schema hash mismatch for version ${String(version.version)}`
      );
  }
  const namespaces = new Set<string>();
  for (const namespace of category.annotationNamespaces) {
    if (namespaces.has(namespace.namespace))
      return err(`${category.category}: duplicate annotation namespace ${namespace.namespace}`);
    namespaces.add(namespace.namespace);
    if ((namespace.allowedActorTypes as readonly string[]).includes('owner'))
      return err(
        `${category.category}: owner cannot write annotation namespace ${namespace.namespace}`
      );
    if (namespace.maxBytes > GLOBAL_BYTE_LIMIT)
      return err(`${category.category}: annotation byte limit exceeds global ceiling`);
    const hash = hashSchema(namespace.schema);
    if (hash.isErr() || hash.value !== namespace.schemaHash)
      return err(
        `${category.category}: annotation schema hash mismatch for ${namespace.namespace}`
      );
  }
  if (category.queryFields.some(({ requiredIndex }) => requiredIndex.length === 0))
    return err(`${category.category}: query field missing required index`);
  return ok(undefined);
};

export const makeCategoryRegistry = (
  categories: readonly CategoryDefinition[]
): Result<CategoryRegistry, string> => {
  const byId = new Map<string, CategoryDefinition>();
  for (const category of categories) {
    if (byId.has(category.category)) return err(`duplicate category id: ${category.category}`);
    const validation = validateCategory(category);
    if (validation.isErr()) return err(validation.error);
    byId.set(category.category, category);
  }
  return ok({
    get: (category) => byId.get(category),
    resolve: (category, schemaVersion) => {
      const definition = byId.get(category);
      if (definition === undefined) return err(createUnknownCategory(category));
      const version = definition.schemaVersions.find(
        (candidate) => candidate.version === schemaVersion
      );
      return version === undefined
        ? err(createUnknownSchemaVersion(category, schemaVersion))
        : ok({ definition, schemaVersion: version });
    },
    list: () => [...categories],
  });
};
