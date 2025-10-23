import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDatasetsDirectory } from './validation';

test('filesystem datasets adhere to the schema', () => {
  const result = validateDatasetsDirectory();
  assert.ok(result.datasetCount > 0, 'Expected at least one dataset file');
});
