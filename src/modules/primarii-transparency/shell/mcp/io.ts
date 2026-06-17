/**
 * Primarii-transparency module — MCP tool I/O shapes (plan §8). The Zod input
 * shapes + the `McpToolOutput` kinds each tool returns. The handlers (in `tools.ts`)
 * call the SAME usecases the GraphQL resolvers do (tri-surface equivalence, §14.7);
 * output is the kernel `{ ok, kind, query?, link?, item|items?, summary?, coverage?,
 * caveats? }` object.
 *
 * Four tools (discovery + 3 query, §6.3):
 *   resolve_primarii_filters         (discovery) → kind 'filter_values'
 *   get_primarii_entity_transparency (query)     → kind 'entity_transparency'
 *   list_primarii_entities           (query)     → kind 'entity_list'
 *   aggregate_primarii_transparency  (query)     → kind 'aggregate'
 *
 * Naming follows `<verb>_primarii_<noun>` (§6.3). Raw/excerpt columns are NEVER
 * returned by any tool (§8 / privacy).
 */

import { z } from 'zod';

export const PRIMARII_MCP_KINDS = {
  resolve: 'filter_values',
  entity: 'entity_transparency',
  list: 'entity_list',
  aggregate: 'aggregate',
} as const;

export const resolvePrimariiFiltersInput = {
  dim: z
    .enum(['entity', 'county', 'status', 'siruta'])
    .describe(
      'Dimension to resolve: entity (name→CUI), county (name normalize), status (Romanian label→enum), siruta (locality→SIRUTA, kernel territory hub).'
    ),
  q: z.string().describe('The free-text query (entity name, county name, or status label).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export const getPrimariiEntityTransparencyInput = {
  cui: z.string().describe('The UAT CUI (digits only).'),
};

export const listPrimariiEntitiesInput = {
  /** The primarii_entity filter fragment (see the GraphQL PrimariiEntityFilter / spec §7). */
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'A PrimariiEntity filter object: dataQualityStatus/resultStatus/entityType/county (+ exclude), missingCategory, publishesCategory(+categoryState), hasIssues, minConfidence/minEvidenceCoverage. Territory filters (region/siruta/isUat/population) are capability-gated.'
    ),
  sort: z
    .enum(['data_quality', 'confidence', 'evidence_coverage', 'issue_count', 'entity_name', 'updated_at'])
    .optional()
    .describe('Sort key (default data_quality — best-known first).'),
  limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20).'),
  after: z.string().optional().describe('Opaque cursor from a previous page.'),
};

export const aggregatePrimariiTransparencyInput = {
  groupBy: z
    .enum(['county', 'region', 'data_quality_status', 'result_status', 'entity_type', 'category_coverage'])
    .describe(
      "Rollup dimension. 'category_coverage' answers 'which UATs publish organigrame/headcount/salaries?' (routes to the per-category coverage rollup — found/not_found/unknown/blocked + coverage); the others are status counts. 'region' requires the kernel cui→territory resolver (capability-gated, attaches a coverage caveat)."
    ),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('A PrimariiEntity filter object scoping the rollup (same shape as list).'),
};
