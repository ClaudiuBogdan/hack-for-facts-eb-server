/**
 * Functional/Economic Classification Utilities
 *
 * This module provides helpers to build a chapter map (2-digit prefix -> chapter name).
 *
 * The data source is a hierarchical JSON tree stored in
 * `functional-classificatinos-general.json`. We lazily build and cache lookup maps
 * to keep lookups fast at runtime.
 */

import { functionalTree } from "./functional-classificatinos-general";

interface BudgetNode {
    description: string;
    code?: string;
    children?: BudgetNode[];
}

/**
 * Normalizes incoming text by removing odd unicode whitespace and BOMs,
 * then trimming. This helps stabilize comparisons and map keys.
 */
const normalizeText = (text: string | null | undefined): string =>
    (text ?? "")
        .replace(/\u00A0/g, " ")
        .replace(/[\u200B-\u200D\u2060]/g, "")
        .replace(/\uFEFF/g, "")
        .trim();

/**
 * Removes a trailing dot from a code if present (e.g., "65." -> "65").
 */
const removeTrailingDot = (code: string): string => normalizeText(code).replace(/\.$/, "");

/**
 * Extracts the two-digit chapter prefix from a functional/economic code.
 * Returns null if the input does not start with two digits.
 */
const extractTwoDigitChapterPrefix = (codeLike: string | null | undefined): string | null => {
    if (!codeLike) return null;
    const raw = removeTrailingDot(codeLike);
    const match = raw.match(/^(\d{2})/);
    return match ? match[1] : null;
};

/**
 * Builds a map from two-digit chapter prefix to the best chapter name found in the tree.
 * Preference order per prefix:
 *  - Exact chapter node (code exactly two digits) over non-exact nodes
 *  - Shallower nodes (smaller depth) if both are exact or both non-exact
 */
const buildChapterNameMapFromTree = (roots: BudgetNode[]): Map<string, string> => {
    type Candidate = { name: string; depth: number; isExactTwoDigits: boolean };
    const bestCandidatePerPrefix = new Map<string, Candidate>();

    const visit = (node: BudgetNode, depth: number) => {
        const prefix = node.code ? extractTwoDigitChapterPrefix(node.code) : null;
        if (prefix) {
            const isExactTwoDigits = /^\d{2}$/.test(normalizeText(node.code!));
            const name = normalizeText(node.description) || prefix;

            const existing = bestCandidatePerPrefix.get(prefix);
            if (!existing) {
                bestCandidatePerPrefix.set(prefix, { name, depth, isExactTwoDigits });
            } else {
                const shouldReplace =
                    (!existing.isExactTwoDigits && isExactTwoDigits) ||
                    (existing.isExactTwoDigits === isExactTwoDigits && depth < existing.depth);
                if (shouldReplace) bestCandidatePerPrefix.set(prefix, { name, depth, isExactTwoDigits });
            }
        }
        if (node.children?.length) for (const child of node.children) visit(child, depth + 1);
    };

    for (const root of roots) visit(root, 0);

    const map = new Map<string, string>();
    bestCandidatePerPrefix.forEach((candidate, prefix) => map.set(prefix, candidate.name));
    return map;
};

// Lazy singleton cache for chapter map
let chapterMapCache: Map<string, string> | null = null;

/**
 * Returns a memoized chapter name map: 2-digit prefix -> chapter description.
 */
export const getChapterMap = (): Map<string, string> => {
    if (chapterMapCache) return chapterMapCache;
    const tree: BudgetNode[] = Array.isArray(functionalTree) ? functionalTree : [];
    chapterMapCache = buildChapterNameMapFromTree(tree);
    return chapterMapCache;
};

export const getFilterDescription = (filteredBy?: { fnCode?: string, ecCode?: string }): string => {
    if (!filteredBy || (!filteredBy.fnCode && !filteredBy.ecCode)) return "";
    const filterDescription = " filtered by";
    const fnDescription = filteredBy.fnCode ? ` functional category "${filteredBy.fnCode}"` : "";
    const ecDescription = filteredBy.ecCode ? ` economic category "${filteredBy.ecCode}"` : "";
    return `${filterDescription}${fnDescription}${ecDescription}`;
};

/**
 * Normalizes classification codes by removing trailing .00 segments.
 * This converts codes to their prefix form by removing unnecessary trailing zeros.
 *
 * Examples:
 * - "70.00.00" -> "70."
 * - "10.01.00" -> "10.01."
 * - "50." -> "50."
 * - "65.02.01" -> "65.02.01."
 *
 * @param code The classification code to normalize
 * @returns The normalized code with trailing .00 segments removed and ending with a dot
 */
export const normalizeClassificationCode = (code: string): string => {
    if (!code) return code;

    // Remove trailing dot if present for processing
    let normalized = code.endsWith('.') ? code.slice(0, -1) : code;

    // Remove trailing .00 segments repeatedly
    while (normalized.endsWith('.00')) {
        normalized = normalized.slice(0, -3);
    }

    // Ensure it ends with a dot for prefix codes
    if (!normalized.endsWith('.')) {
        normalized += '.';
    }

    return normalized;
};