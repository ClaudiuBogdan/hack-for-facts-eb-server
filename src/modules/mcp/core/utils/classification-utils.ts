/**
 * MCP Module - Classification Utilities
 *
 * Utilities for normalizing and validating classification codes.
 */

/**
 * Normalizes a classification code by removing trailing .00 segments.
 *
 * Examples:
 * - "65.10.00" → "65.10"
 * - "65.00.00" → "65"
 * - "65.10.03" → "65.10.03" (unchanged)
 * - "65." → "65." (unchanged, prefix)
 *
 * @param code - Classification code to normalize
 * @returns Normalized code with trailing .00 segments removed
 */
export function normalizeClassificationCode(code: string): string {
  // Don't modify codes that end with a dot (prefixes)
  if (code.endsWith('.')) {
    return code;
  }

  // Remove trailing .00 segments
  return code.replace(/(?:\.00)+$/, '');
}

/**
 * Normalizes an array of classification codes.
 *
 * @param codes - Array of classification codes
 * @returns Array of normalized codes
 */
export function normalizeClassificationCodes(codes: string[]): string[] {
  return codes.map(normalizeClassificationCode);
}

/**
 * Checks if a classification code is a prefix (ends with a dot).
 *
 * @param code - Classification code to check
 * @returns True if the code is a prefix
 */
export function isClassificationPrefix(code: string): boolean {
  return code.endsWith('.');
}

/**
 * Extracts the chapter code from a classification code.
 *
 * Examples:
 * - "65.10.03" → "65"
 * - "65.10" → "65"
 * - "65" → "65"
 * - "65." → "65"
 *
 * @param code - Classification code
 * @returns Chapter code (first segment)
 */
export function getChapterCode(code: string): string {
  const normalized = code.replace(/\.$/, ''); // Remove trailing dot
  const parts = normalized.split('.');
  return parts[0] ?? '';
}

/**
 * Extracts the subchapter code from a classification code.
 *
 * Examples:
 * - "65.10.03" → "65.10"
 * - "65.10" → "65.10"
 * - "65" → null
 *
 * @param code - Classification code
 * @returns Subchapter code or null if not applicable
 */
export function getSubchapterCode(code: string): string | null {
  const normalized = code.replace(/\.$/, ''); // Remove trailing dot
  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  const part0 = parts[0];
  const part1 = parts[1];
  if (part0 === undefined || part1 === undefined) return null;
  return `${part0}.${part1}`;
}

/**
 * Gets the depth level of a classification code.
 *
 * Examples:
 * - "65" → 1 (chapter)
 * - "65.10" → 2 (subchapter)
 * - "65.10.03" → 3 (paragraph)
 * - "65." → 1 (chapter prefix)
 *
 * @param code - Classification code
 * @returns Depth level (1-6)
 */
export function getClassificationDepth(code: string): number {
  const normalized = code.replace(/\.$/, ''); // Remove trailing dot
  return normalized.split('.').length;
}
