import { expect, it } from 'vitest';

import { ALL_USER_DATA_CATEGORIES } from '@/modules/user-data/core/registry/categories/index.js';
import { makeCategoryRegistry } from '@/modules/user-data/core/registry/registry.js';
import { type CategoryDefinition } from '@/modules/user-data/core/registry/types.js';

import { makeDefinition } from './fixtures.js';
import { expectErr, expectOk } from '../../support/result.js';

it('boots with the real categories and their declared hashes', () => {
  expect(expectOk(makeCategoryRegistry(ALL_USER_DATA_CATEGORIES)).list()).toHaveLength(2);
});

it('fails fast on a schema hash mismatch', () => {
  const category = makeDefinition();
  const wrong: CategoryDefinition = {
    ...category,
    schemaVersions: [{ ...category.schemaVersions[0]!, schemaHash: 'wrong' }],
  };
  expect(expectErr(makeCategoryRegistry([wrong]))).toContain('schema hash mismatch');
});

it('fails fast on duplicate category ids', () => {
  const category = makeDefinition();
  expect(expectErr(makeCategoryRegistry([category, category]))).toContain('duplicate category id');
});

it('fails fast when owner is allowed to write an annotation namespace', () => {
  const category = makeDefinition();
  const unsafe = {
    ...category,
    annotationNamespaces: [{ ...category.annotationNamespaces[0]!, allowedActorTypes: ['owner'] }],
  } as unknown as CategoryDefinition;
  expect(expectErr(makeCategoryRegistry([unsafe]))).toContain('owner cannot write');
});
