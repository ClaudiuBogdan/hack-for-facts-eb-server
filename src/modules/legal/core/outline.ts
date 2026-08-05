/**
 * Outline grammar — which `document_nodes` kinds are TOC headings and how
 * deep each one indents.
 *
 * The depth is a FIXED rank per kind from the portal structure grammar
 * (scrapper `prod-db/TLDF_SCHEMA_SPEC.md` §2: carte > parte > titlu >
 * capitol > subcapitol > sectiune > articol; anexa/apendice restart a
 * root-level program). It is deliberately NOT derived from the materialized
 * path: `unmarked:N` keys carry no hierarchy in the string, and path-shape
 * parsing is exactly the defect that made the old tree repo lie.
 *
 * Only `role IS NULL` rows are outline candidates — role-bearing rows are
 * heading/label runs INSIDE a node, and counting them multiplied articles
 * ~4x in the old tree queries.
 */

export const OUTLINE_HEADING_KINDS = [
  'carte',
  'parte',
  'titlu',
  'capitol',
  'subcapitol',
  'sectiune',
  'articol',
  'anexa',
  'apendice',
] as const;

export type OutlineHeadingKind = (typeof OUTLINE_HEADING_KINDS)[number];

/** Grammar rank → TOC indent depth (1 = top level). */
export const OUTLINE_DEPTH_RANK: Readonly<Record<OutlineHeadingKind, number>> = {
  carte: 1,
  parte: 2,
  titlu: 3,
  capitol: 4,
  subcapitol: 5,
  sectiune: 6,
  articol: 7,
  anexa: 1,
  apendice: 2,
};

export const OUTLINE_MAX_DEPTH_DEFAULT = 3;

/**
 * Kinds visible at a requested maxDepth: every kind whose rank, compressed to
 * the distinct ranks actually in the grammar, falls within the budget. The
 * repo filters kinds server-side so a depth-3 outline of the Codul Fiscal
 * never drags its ~600 articles across the wire.
 */
export function outlineKindsForDepth(maxDepth: number): OutlineHeadingKind[] {
  return OUTLINE_HEADING_KINDS.filter((kind) => OUTLINE_DEPTH_RANK[kind] <= maxDepth);
}
