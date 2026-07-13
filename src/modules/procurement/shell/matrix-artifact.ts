import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ANALYSIS_MATRIX_SHA256 } from '../core/combinations.js';

export const PROCUREMENT_MATRIX_ARTIFACT_URL = new URL(
  '../core/procurement-analysis-combinations-v2.json',
  import.meta.url
);

export const assertProcurementMatrixBytes = (bytes: Uint8Array): void => {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== ANALYSIS_MATRIX_SHA256) {
    throw new Error(
      `procurement analysis artifact hash mismatch: local ${actual}, pinned ${ANALYSIS_MATRIX_SHA256}`
    );
  }
};

export const assertProcurementMatrixArtifact = (): void => {
  assertProcurementMatrixBytes(readFileSync(PROCUREMENT_MATRIX_ARTIFACT_URL));
};
