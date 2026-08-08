/**
 * Outline grammar — which `document_nodes` rows are TOC headings and how deep
 * each one indents.
 *
 * Keyed on `node_type` (the closed grammar vocabulary), NOT on `node_kind`.
 * `node_kind` is many-to-one over `node_type` and loses the distinction that
 * decides TOC membership: `S_PRT` and `S_POR` both write `node_kind='parte'`,
 * but they are not the same object (measured 2026-08-08, prod, current
 * generation — prod-db/LEGAL_NODES_V41_SERVING_AUDIT_2026-08-08.md §3 D2):
 *
 *   PRT   2,111 containers · 2,111 labeled · 2,111 with a title child · ≤49/doc
 *   POR  43,526 containers ·   212 labeled ·     0 with a title child · ≤3,064/doc
 *
 * PRT is a titled Part. POR is a within-document portion wrapper — it carries
 * no title, and a document does not have 3,064 Parts. Including it put blank
 * TOC rows in the DEFAULT outline of 5,031 documents. POR is therefore absent
 * from the table below on purpose; do not add it back without new evidence.
 *
 * The depth is a FIXED rank per type from the portal structure grammar
 * (scrapper `prod-db/TLDF_SCHEMA_SPEC.md` §2: carte > parte > titlu > capitol >
 * subcapitol > sectiune > articol; anexa/apendice restart a root-level
 * program). It is deliberately NOT derived from the materialized path:
 * `unmarked:N` keys carry no hierarchy in the string, and path-shape parsing is
 * exactly the defect that made the old tree repo lie.
 *
 * Only `role IS NULL` rows are outline candidates — role-bearing rows are
 * heading/label runs INSIDE a node, and counting them multiplied articles ~4x
 * in the old tree queries.
 */

/** Grammar token → the `node_kind` the projection lane writes alongside it. */
export const OUTLINE_HEADING_TYPES = [
  'CRT', // carte
  'PRT', // parte  (titled Part — NOT POR, see the header)
  'TTL', // titlu
  'CAP', // capitol
  'SBC', // subcapitol
  'SEC', // sectiune
  'ART', // articol
  'ANX', // anexa
  'APN', // apendice
] as const;

export type OutlineHeadingType = (typeof OUTLINE_HEADING_TYPES)[number];

/** Grammar rank → TOC indent depth (1 = top level). */
export const OUTLINE_DEPTH_RANK: Readonly<Record<OutlineHeadingType, number>> = {
  CRT: 1,
  PRT: 2,
  TTL: 3,
  CAP: 4,
  SBC: 5,
  SEC: 6,
  ART: 7,
  // Annexes restart the hierarchy: an annex is a root-level program of its own,
  // not a leaf under the last section that happened to precede it.
  ANX: 1,
  APN: 2,
};

export const OUTLINE_MAX_DEPTH_DEFAULT = 3;

/**
 * Types visible at a requested maxDepth: every type whose grammar rank falls
 * within the budget. The repo filters server-side so a depth-3 outline of the
 * Codul Fiscal never drags its articles across the wire.
 */
export function outlineTypesForDepth(maxDepth: number): OutlineHeadingType[] {
  return OUTLINE_HEADING_TYPES.filter((type) => OUTLINE_DEPTH_RANK[type] <= maxDepth);
}
