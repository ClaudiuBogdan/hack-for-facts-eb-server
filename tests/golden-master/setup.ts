/**
 * Golden Master Test Setup
 *
 * This setup file validates the environment configuration before tests run.
 * It ensures either TEST_GM_API_URL or TEST_GM_DATABASE_URL is set.
 *
 * Also provides utilities for normalizing floating-point precision in comparisons.
 */

import { beforeAll, afterAll, expect, inject } from 'vitest';

import { getExecutionMode, getComparisonMode, closeClient } from './client.js';
import { redactEndpoint } from './endpoint.js';
import { COMPARISON_DECIMAL_PLACES, normalizeNumbers } from './normalize.js';

// The number-normalization helpers moved to normalize.ts (so compare.ts can use
// them without this file's vitest hooks); re-exported for existing importers.
export { COMPARISON_DECIMAL_PLACES, normalizeNumbers } from './normalize.js';

// =============================================================================
// Run id (module scope: before the spec files are COLLECTED)
// =============================================================================

// One run id for every spec file of this run, minted in global-setup.ts and
// handed over via `provide`/`inject`. It must be exported BEFORE the spec
// modules evaluate: specs/client-documents.gm.test.ts writes `planned.json`
// at collection time, and a `beforeAll` runs only after collection. In
// cutover mode a missing id is fatal — a locally minted one would bypass the
// exclusive run directory created by global-setup.ts.
{
  const injected: unknown = inject('gmRunId');
  if (typeof injected === 'string' && injected.length > 0) {
    process.env['TEST_GM_RUN_ID'] = injected;
  } else if (process.env['TEST_GM_BASELINE_URL'] !== undefined) {
    throw new Error(
      '[Golden Master] cutover mode without a run id from global-setup.ts — run through vitest.gm.config.ts (globalSetup provides gmRunId)'
    );
  }
}

// =============================================================================
// Custom Vitest Matcher
// =============================================================================

/**
 * Extends Vitest's expect with a custom matcher for normalized snapshot comparison.
 * This rounds all numbers in both actual and expected before comparing.
 */
expect.extend({
  /**
   * Matches a snapshot file with normalized floating-point numbers.
   * Reads the snapshot file, normalizes both actual and expected, then compares.
   *
   * Usage: await expect(data).toMatchNormalizedSnapshot('path/to/snapshot.json')
   */
  async toMatchNormalizedSnapshot(
    received: unknown,
    snapshotPath: string,
    decimalPlaces: number = COMPARISON_DECIMAL_PLACES
  ) {
    const { isNot } = this;

    // CUTOVER mode: the stored snapshots were recorded against a different
    // database, so they cannot be the oracle. Equivalence was already asserted
    // inside `client.query()` (baseline vs target envelope); this matcher only
    // needs to not fail spuriously.
    if (getComparisonMode() === 'cutover') {
      return {
        pass: !isNot,
        message: () =>
          'cutover mode: snapshot comparison skipped, equivalence is asserted by client.query() against the baseline endpoint',
      };
    }

    const fs = await import('node:fs');
    const path = await import('node:path');

    // Resolve the snapshot path relative to the test file
    const testFilePath = this.testPath ?? '';
    const testDir = path.dirname(testFilePath);
    const absoluteSnapshotPath = path.resolve(testDir, snapshotPath);

    // Normalize the received data
    const normalizedReceived = normalizeNumbers(received, decimalPlaces);

    // Read and parse the snapshot file
    let snapshotContent: unknown;
    try {
      const raw = fs.readFileSync(absoluteSnapshotPath, 'utf8');
      // Remove trailing commas (vitest snapshot format uses JS-like syntax)
      const cleaned = raw.replace(/,(\s*[}\]])/g, '$1');
      // eslint-disable-next-line no-restricted-syntax -- Test utility, safe JSON from local files
      snapshotContent = JSON.parse(cleaned) as unknown;
    } catch {
      // If snapshot doesn't exist or can't be parsed, fall back to regular snapshot
      try {
        await expect(normalizedReceived).toMatchFileSnapshot(snapshotPath);
        return {
          pass: true,
          message: () => 'Snapshot created/matched',
        };
      } catch (snapshotError) {
        return {
          pass: false,
          message: () => `Snapshot error: ${(snapshotError as Error).message}`,
        };
      }
    }

    // Normalize the snapshot content
    const normalizedSnapshot = normalizeNumbers(snapshotContent, decimalPlaces);

    // Deep compare the normalized values
    const { equals, utils } = this;
    const pass = equals(normalizedReceived, normalizedSnapshot);

    const precisionStr = String(decimalPlaces);
    if (pass) {
      return {
        pass: true,
        message: () =>
          isNot
            ? `Expected values NOT to match (with ${precisionStr} decimal precision)`
            : `Values matched (with ${precisionStr} decimal precision)`,
      };
    } else {
      // Generate diff for error message
      const diffString = utils.diff(normalizedSnapshot, normalizedReceived, {
        expand: false,
      });

      return {
        pass: false,
        message: () =>
          isNot
            ? 'Expected values NOT to match'
            : `Snapshot mismatch (with ${precisionStr} decimal precision):\n\n${diffString ?? 'Unable to generate diff'}`,
      };
    }
  },
});

// Extend the Vitest types
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Required for module augmentation
  interface Assertion<T> {
    toMatchNormalizedSnapshot(snapshotPath: string, decimalPlaces?: number): Promise<void>;
  }
  interface AsymmetricMatchersContaining {
    toMatchNormalizedSnapshot(snapshotPath: string, decimalPlaces?: number): Promise<void>;
  }
}

// =============================================================================
// Environment Validation
// =============================================================================

beforeAll(() => {
  // Set test environment
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['TZ'] = 'UTC';

  // Validate configuration
  try {
    const mode = getExecutionMode();
    const comparison = getComparisonMode();
    console.log(`\n[Golden Master] Execution mode: ${mode.toUpperCase()}`);
    console.log(`[Golden Master] Comparison mode: ${comparison.toUpperCase()}`);
    if (comparison === 'cutover') {
      console.log(
        `[Golden Master] baseline (expected): ${redactEndpoint(process.env['TEST_GM_BASELINE_URL'] ?? '')} → target (actual): ${redactEndpoint(process.env['TEST_GM_API_URL'] ?? '')}`
      );
      console.log(`[Golden Master] run id: ${process.env['TEST_GM_RUN_ID'] ?? '(none)'}`);
    }
    console.log('[Golden Master] Tests will use historical data from 2016-2025');
    console.log(
      `[Golden Master] Using ${String(COMPARISON_DECIMAL_PLACES)} decimal places for number comparison\n`
    );
  } catch (error) {
    console.error('\n[Golden Master] Configuration Error:');
    console.error((error as Error).message);
    console.error('\nTo run Golden Master tests, set one of:');
    console.error('  - TEST_GM_API_URL    (for snapshot generation from prod)');
    console.error('  - TEST_GM_DATABASE_URL (for CI/local testing)');
    console.error('Optionally, with TEST_GM_API_URL only:');
    console.error(
      '  - TEST_GM_BASELINE_URL (cutover mode: compare baseline vs target envelopes)\n'
    );
    throw error;
  }
});

// =============================================================================
// Cleanup
// =============================================================================

afterAll(async () => {
  await closeClient();
  console.log('\n[Golden Master] Tests completed, resources cleaned up\n');
});
