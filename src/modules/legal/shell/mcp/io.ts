/**
 * Legal module — MCP tool I/O shapes (plan §8). The Zod input shapes + the
 * `McpToolOutput` kinds each tool returns. The handlers (in `tools.ts`) call the
 * SAME usecase the GraphQL resolvers do (tri-surface equivalence, §14.7); output
 * is the kernel `{ ok, kind, query?, link?, item|items?, summary? }` object.
 *
 * Tools (two families minimum — discovery + query, §6.3):
 *   resolve_legal_filters  (discovery) → kind 'filter_resolution'
 *   get_legal_act          (query)     → kind 'legal_act_card'
 *   search_legal_acts      (query)     → kind 'legal_search'
 *   get_legal_act_links    (query)     → kind 'legal_links'
 *   get_legal_act_timeline (query)     → kind 'legal_timeline'
 *   get_legal_node         (query)     → kind 'legal_node' (label+kind+char range+deep link; NO node text)
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
} as const;

export const resolveLegalFiltersInput = {
  dim: z
    .enum(['act', 'issuer', 'domain', 'category', 'act_type', 'status'])
    .describe('Dimension to resolve: act (citation→actId), issuer/domain/category/act_type/status (name/label→value).'),
  q: z.string().describe('The free-text query (citation, issuer name, or label).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export const getLegalActInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z.string().optional().describe("Free-text citation ('legea 227/2015' | 'codul fiscal')."),
};

export const searchLegalActsInput = {
  q: z.string().describe('The natural-language or provision query.'),
  filter: z.record(z.string(), z.unknown()).optional().describe('A LegalActs filter object (status/domain/category/actType/year).'),
  channel: z.enum(['auto', 'sections', 'docs']).optional().describe('Retrieval channel (default auto — identifier router first).'),
  includeHistorical: z.boolean().optional().describe('Include abrogated/repealed acts (default false).'),
  includeSuspicious: z.boolean().optional().describe('Include suspicious/stub extractions (default false; RAG-excluded).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
};

export const getLegalActLinksInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z.string().optional().describe('Free-text citation.'),
  direction: z.enum(['in', 'out']).describe("in = who cites/amends this act; out = what this act cites."),
  relation: z.array(z.string()).optional().describe('Filter by relation(s): modifica/abroga/completeaza/...'),
  limit: z.number().int().min(1).max(200).optional().describe('Max edges (bounded; hub guard). Default 50.'),
};

export const getLegalActTimelineInput = {
  actId: z.string().optional().describe('Numeric act_id.'),
  citation: z.string().optional().describe('Free-text citation.'),
};

export const getLegalNodeInput = {
  documentId: z.string().describe('The act_documents.document_id (text).'),
  path: z.string().describe("The node materialized path or article number (e.g. 'art. 291')."),
};
