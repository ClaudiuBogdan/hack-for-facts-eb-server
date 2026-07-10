/**
 * Judicial module — MCP tool I/O shapes (plan 08 §8). Zod input shapes + the
 * `McpToolOutput` kinds. Handlers (in `tools.ts`) call the SAME usecase the
 * GraphQL resolvers do (tri-surface equivalence, §14.7).
 *
 * PRIVACY: NO tool input or output names a party. Outputs OMIT `display_name`
 * (except gated company names via the dictionary), `solution_summary`, `solution`,
 * and the candidate `evidence`/`candidates`/`reviewed_by` jsonb/PII. No tool
 * returns party rows — person/unknown parties surface only as `personPartyCount`.
 *
 * Tools (two families — discovery + query, §6.3):
 *   resolve_judicial_filters   (discovery) → kind 'filter_resolution'
 *   get_judicial_case          (query)     → kind 'judicial_case'
 *   get_court_caseload         (query)     → kind 'judicial_caseload'
 *   get_company_litigation     (query)     → kind 'judicial_company_litigation'
 *   get_case_legal_references  (query)     → kind 'judicial_legal_refs'
 */

import { z } from 'zod';

export const JUDICIAL_MCP_KINDS = {
  resolve: 'filter_resolution',
  caseDetail: 'judicial_case',
  caseload: 'judicial_caseload',
  companyLitigation: 'judicial_company_litigation',
  legalRefs: 'judicial_legal_refs',
} as const;

export const resolveJudicialFiltersInput = {
  dim: z
    .enum(['court', 'courtLevel', 'companyName', 'category'])
    .describe(
      'Dimension to resolve: court (name→institution_code), courtLevel (label→enum), companyName (name→name_key_id; company/public dictionary ONLY — a person name returns zero rows), category (label→code).'
    ),
  q: z
    .string()
    .describe('The free-text query (court name, level label, company name, or category label).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

export const getJudicialCaseInput = {
  caseId: z.string().optional().describe('Numeric case_id.'),
  institutionCode: z
    .string()
    .optional()
    .describe('Court institution code (with caseNumber, natural-key lookup).'),
  caseNumber: z
    .string()
    .optional()
    .describe('Case number (with institutionCode, natural-key lookup).'),
};

export const getCourtCaseloadInput = {
  groupBy: z.enum(['court', 'category', 'year', 'courtLevel']).describe('Aggregate dimension.'),
  institutionCode: z.array(z.string()).optional().describe('Bound to court institution code(s).'),
  courtLevel: z
    .array(
      z.enum([
        'judecatorie',
        'tribunal',
        'tribunal_militar',
        'curte_de_apel',
        'curte_militara_apel',
      ])
    )
    .optional()
    .describe('Bound to court level(s).'),
  category: z.array(z.string()).optional().describe('Bound to category code(s).'),
  yearFrom: z.number().int().optional().describe('Opened-year lower bound.'),
  yearTo: z.number().int().optional().describe('Opened-year upper bound.'),
  // A court/level/period bound is REQUIRED (else InvalidInput — no unbounded scan).
};

export const getCompanyLitigationInput = {
  cui: z
    .string()
    .describe('Company CUI (resolved via the identity hub). Published-only; empty in v1.'),
  courtLevel: z
    .array(
      z.enum([
        'judecatorie',
        'tribunal',
        'tribunal_militar',
        'curte_de_apel',
        'curte_militara_apel',
      ])
    )
    .optional()
    .describe('Optional court-level narrowing (§7.3).'),
  yearFrom: z.number().int().optional().describe('Optional opened-year lower bound.'),
  yearTo: z.number().int().optional().describe('Optional opened-year upper bound.'),
  category: z.array(z.string()).optional().describe('Optional category narrowing.'),
};

export const getCaseLegalReferencesInput = {
  caseId: z.string().describe('Numeric case_id.'),
};
