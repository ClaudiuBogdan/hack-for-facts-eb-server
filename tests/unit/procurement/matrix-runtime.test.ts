import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PROCUREMENT_MATRIX_ARTIFACT_URL,
  assertProcurementMatrixArtifact,
  assertProcurementMatrixBytes,
} from '@/modules/procurement/shell/matrix-artifact.js';

describe('procurement matrix runtime integrity', () => {
  it('accepts the vendored artifact bytes', () => {
    expect(() => {
      assertProcurementMatrixArtifact();
    }).not.toThrow();
  });

  it('fails boot validation on local byte corruption', () => {
    const bytes = readFileSync(PROCUREMENT_MATRIX_ARTIFACT_URL);
    const corrupted = Buffer.concat([bytes, Buffer.from(' ')]);
    expect(() => {
      assertProcurementMatrixBytes(corrupted);
    }).toThrow(/artifact hash mismatch/u);
  });
});
