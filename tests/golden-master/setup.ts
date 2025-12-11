/**
 * Golden Master Test Setup
 *
 * This setup file validates the environment configuration before tests run.
 * It ensures either TEST_GM_API_URL or TEST_GM_DATABASE_URL is set.
 *
 * Also provides utilities for normalizing floating-point precision in comparisons.
 */

import { beforeAll, afterAll, expect } from 'vitest';

import { getExecutionMode, closeClient } from './client.js';

// =============================================================================
// Floating Point Precision Configuration
// =============================================================================

/**
 * Number of decimal places to round floating-point numbers for comparison.
 * This is a temporary fix until precision can be configured from the API.
 *
 * FIXME: In the future, precision should come from the API response metadata.
 * For now, we use 2 decimal places which is sufficient for financial data display.
 */
export const COMPARISON_DECIMAL_PLACES = 2;

// =============================================================================
// Number Normalization Utility
// =============================================================================

/**
 * Recursively rounds all numbers in an object to the specified decimal places.
 * This normalizes floating-point precision differences between prod and local.
 *
 * @param obj - The object to normalize
 * @param decimalPlaces - Number of decimal places (default: COMPARISON_DECIMAL_PLACES)
 * @returns A new object with all numbers rounded
 */
export function normalizeNumbers<T>(obj: T, decimalPlaces: number = COMPARISON_DECIMAL_PLACES): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'number') {
    // Round to specified decimal places
    const factor = Math.pow(10, decimalPlaces);
    return (Math.round(obj * factor) / factor) as T;
  }

  if (Array.isArray(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Generic recursion requires any
    return obj.map((item) => normalizeNumbers(item, decimalPlaces)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = normalizeNumbers(value, decimalPlaces);
    }
    return result as T;
  }

  return obj;
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
  process.env.TZ = 'UTC';

  // Validate configuration
  try {
    const mode = getExecutionMode();
    console.log(`\n[Golden Master] Execution mode: ${mode.toUpperCase()}`);
    console.log('[Golden Master] Tests will use historical data from 2016-2024');
    console.log(
      `[Golden Master] Using ${String(COMPARISON_DECIMAL_PLACES)} decimal places for number comparison\n`
    );
  } catch (error) {
    console.error('\n[Golden Master] Configuration Error:');
    console.error((error as Error).message);
    console.error('\nTo run Golden Master tests, set one of:');
    console.error('  - TEST_GM_API_URL    (for snapshot generation from prod)');
    console.error('  - TEST_GM_DATABASE_URL (for CI/local testing)\n');
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
