/**
 * Legal module — MCP tool I/O shapes (plan §8). The Zod input shapes + the
 * `McpToolOutput` kinds each tool returns. The handlers (in `tools.ts`) call the
 * SAME usecase the GraphQL resolvers do (tri-surface equivalence, §14.7); output
 * is the kernel `{ ok, kind, query?, link?, item|items?, summary? }` object.
 *
 * Tools (two families minimum — discovery + query, §6.3):
 *   resolve_legal_filters    (discovery) → kind 'filter_resolution'
 *   get_legal_act            (query)     → kind 'legal_act_card'
 *   search_legal_acts        (query)     → kind 'legal_search'
 *   get_legal_act_links      (query)     → kind 'legal_links'
 *   get_legal_act_timeline   (query)     → kind 'legal_timeline'
 *   get_legal_node           (query)     → kind 'legal_node' (label+kind+char range+deep link; NO node text)
 *   count_legal_acts         (query)     → kind 'legal_act_counts'
 *   get_legal_recent_changes (query)     → kind 'legal_recent_changes'
 *
 * Naming follows `<verb>_legal_<noun>` (§6.3). All inputs accept `actId` OR
 * `citation` where an act is addressed (resolved via `resolveActRef` → keys/aliases).
 */

import { z } from 'zod';

export const LEGAL_MCP_KINDS = {
  resolve: 'filter_resolution',
  actCard: 'legal_act_card',
  search: 'legal_search',
  links: 'legal_links',
  timeline: 'legal_timeline',
  node: 'legal_node',
  counts: 'legal_act_counts',
  changes: 'legal_recent_changes',
} as const;

export const resolveLegalFiltersInput = {
  dim: z
    .enum(['act', 'issuer', 'domain', 'category', 'act_type', 'status'])
    .describe(
      'Dimension to resolve: act (citation→actId), issuer/domain/category/act_type/status (name/label→value).'
    ),
  q: z.string().describe('The free-text query (citation, issuer name, or label).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export const getLegalActInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z
    .string()
    .optional()
    .describe("Free-text citation ('legea 227/2015' | 'codul fiscal')."),
};

export const searchLegalActsInput = {
  q: z.string().describe('The natural-language or provision query.'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('A LegalActs filter object (status/domain/category/actType/year).'),
  channel: z
    .enum(['auto', 'sections', 'docs'])
    .optional()
    .describe('Retrieval channel (default auto — identifier router first).'),
  includeHistorical: z
    .boolean()
    .optional()
    .describe('Include abrogated/repealed acts (default false).'),
  includeSuspicious: z
    .boolean()
    .optional()
    .describe('Include suspicious/stub extractions (default false; RAG-excluded).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
};

export const getLegalActLinksInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z.string().optional().describe('Free-text citation.'),
  direction: z
    .enum(['in', 'out'])
    .describe('in = who cites/amends this act; out = what this act cites.'),
  relation: z
    .array(z.string())
    .optional()
    .describe('Filter by relation(s): modifica/abroga/completeaza/...'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Page size (default 50; effective cap 199 — the +1 probe stays inside the 200-row hub guard).'
    ),
  after: z
    .string()
    .optional()
    .describe(
      'Opaque keyset cursor from a previous call (meta.next); same direction/relations required.'
    ),
};

export const getLegalActTimelineInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z.string().optional().describe('Free-text citation.'),
};

export const getLegalNodeInput = {
  documentId: z.string().describe('The act_documents.document_id (text).'),
  path: z.string().describe("The node materialized path or article number (e.g. 'art. 291')."),
};

export const countLegalActsInput = {
  groupBy: z
    .enum(['domain', 'act_type', 'status', 'issuer', 'year'])
    .describe(
      'Grouping dimension. Bucket keys are RAW DB values; act_type is an open vocabulary (256 live values vs the 18 the filter accepts), so not every key is a valid filter value.'
    ),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('A LegalActs filter object (same semantics as search/list).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Top-N buckets to serve (default 20; max 100, year 300). A cut list is flagged via meta.bucketsTruncated + meta.otherCount.'
    ),
};

export const getLegalRecentChangesInput = {
  since: z
    .string()
    .optional()
    .describe('Inclusive lower bound on effective_date (YYYY-MM-DD). Excludes undated events.'),
  until: z
    .string()
    .optional()
    .describe(
      'Inclusive upper bound on effective_date (YYYY-MM-DD). Pass today to exclude future-dated (not-yet-in-force) events, which otherwise LEAD the feed.'
    ),
  kinds: z
    .array(z.string())
    .optional()
    .describe(
      'Filter by event kind(s): abrogare-totala/modificare/... Omit for all kinds; an explicit empty or blank-only list is rejected.'
    ),
  eventSource: z
    .enum(['portal', 'monitorul-oficial'])
    .optional()
    .describe('Scope to one recording pipeline; omit for both.'),
  undatedOnly: z
    .boolean()
    .optional()
    .describe(
      'Serve ONLY events with no effective_date (25.2% of the table; unreachable via any date window). Cannot be combined with since/until.'
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
  after: z
    .string()
    .optional()
    .describe('Opaque keyset cursor from a previous call (meta.next); same filters required.'),
};
