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
 *
 * API-04 adds twelve thin tools over the SAME usecases (17 in total): the
 * court/case/lineage/company-case/act-citation reads and the stored-decision
 * reads + their discovery. Their flat inputs derive from the ONE transport
 * rule table (filters/transport-input.ts) shared with REST; they are
 * registered with `strictInput` (unknown keys rejected), and list outputs carry
 * the exact repo cursor in `meta.cursor.next`.
 *
 * A3: every OPTIONAL input also accepts null (meaning absent), matching what the
 * handlers normalize; required inputs stay required. Years are original nonzero
 * 32-bit integers (as GraphQL Int); the discovery limit is null/omitted (10) or
 * an integer 1..50. The handlers re-check the same rules for direct calls.
 */

import { z, type ZodRawShape, type ZodType } from 'zod';

import {
  JUDICIAL_AGGREGATE_GROUP_BYS,
  JUDICIAL_COURT_LEVELS,
  JUDICIAL_DECISION_PAGE_MAX,
  JUDICIAL_DECISION_RESOLVE_DIMS,
  JUDICIAL_RESOLVE_DIMS,
  JUDICIAL_RESOLVE_LIMIT_MAX,
  JUDICIAL_YEAR_OPERAND_MAX,
  JUDICIAL_YEAR_OPERAND_MIN,
} from '../../core/types.js';
import {
  CASE_FLAT_RULES,
  COURT_FLAT_RULES,
  DECISION_FLAT_RULES,
  DECISION_LINK_FLAT_RULES,
  type FlatRule,
} from '../filters/transport-input.js';

/** An optional year operand: a nonzero 32-bit integer, or null/omitted (absent). */
const optionalYear = () =>
  z
    .number()
    .int()
    .min(JUDICIAL_YEAR_OPERAND_MIN)
    .max(JUDICIAL_YEAR_OPERAND_MAX)
    .refine((year) => year !== 0, { message: 'year 0 does not exist (1 BC is -1)' })
    .nullable()
    .optional();

export const JUDICIAL_MCP_KINDS = {
  resolve: 'filter_resolution',
  caseDetail: 'judicial_case',
  caseload: 'judicial_caseload',
  companyLitigation: 'judicial_company_litigation',
  legalRefs: 'judicial_legal_refs',
  courts: 'judicial_courts',
  court: 'judicial_court',
  cases: 'judicial_cases',
  lineage: 'judicial_lineage',
  companyCases: 'judicial_company_litigation_cases',
  citingAct: 'judicial_cases_citing_act',
  issuingBodies: 'judicial_issuing_bodies',
  decisions: 'judicial_decisions',
  decision: 'judicial_decision',
  decisionLinks: 'judicial_decision_subject_links',
} as const;

export const resolveJudicialFiltersInput = {
  dim: z
    .enum(JUDICIAL_RESOLVE_DIMS)
    .describe(
      'Dimension to resolve: court (name→institution_code), courtLevel (label→enum), companyName (name→name_key_id; company/public dictionary ONLY — a person name returns zero rows), category (label→code).'
    ),
  q: z
    .string()
    .describe('The free-text query (court name, level label, company name, or category label).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(JUDICIAL_RESOLVE_LIMIT_MAX)
    .nullable()
    .optional()
    .describe('Max hits: an integer 1 to 50; omitted or null means 10.'),
};

export const getJudicialCaseInput = {
  caseId: z
    .string()
    .nullable()
    .optional()
    .describe('Numeric case_id: decimal digits, at most 9223372036854775807.'),
  institutionCode: z
    .string()
    .nullable()
    .optional()
    .describe('Court institution code (with caseNumber, natural-key lookup).'),
  caseNumber: z
    .string()
    .nullable()
    .optional()
    .describe('Case number (with institutionCode, natural-key lookup).'),
};

export const getCourtCaseloadInput = {
  groupBy: z.enum(JUDICIAL_AGGREGATE_GROUP_BYS).describe('Aggregate dimension.'),
  institutionCode: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Bound to court institution code(s).'),
  courtLevel: z
    .array(z.enum(JUDICIAL_COURT_LEVELS))
    .nullable()
    .optional()
    .describe('Bound to court level(s).'),
  category: z.array(z.string()).nullable().optional().describe('Bound to category code(s).'),
  yearFrom: optionalYear().describe(
    'Lower bound on the session calendar year of the source-dependent sourceOpenedAt (Portal Just header data / the ICCJ archive case-date field); not a universal filing year. A nonzero 32-bit integer (1 BC is -1); null or infinite dates never match a year bound.'
  ),
  yearTo: optionalYear().describe(
    'Upper bound on the session calendar year of the source-dependent sourceOpenedAt; not a universal filing year. A nonzero 32-bit integer (1 BC is -1); yearFrom above yearTo matches nothing.'
  ),
  // A court/level/period bound is REQUIRED (else InvalidInput — no unbounded scan).
};

export const getCompanyLitigationInput = {
  cui: z
    .string()
    .describe(
      'Company CUI (resolved via the identity hub). Published-only company litigation; results depend on stored published links.'
    ),
  courtLevel: z
    .array(z.enum(JUDICIAL_COURT_LEVELS))
    .nullable()
    .optional()
    .describe('Optional court-level narrowing (§7.3); an empty list does not narrow.'),
  yearFrom: optionalYear().describe(
    'Optional lower bound on the session calendar year of the source-dependent case date; not a universal filing year. A nonzero 32-bit integer (1 BC is -1).'
  ),
  yearTo: optionalYear().describe(
    'Optional upper bound on the session calendar year of the source-dependent case date; not a universal filing year. A nonzero 32-bit integer (1 BC is -1).'
  ),
  category: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Optional category narrowing; an empty list does not narrow.'),
};

export const getCaseLegalReferencesInput = {
  caseId: z.string().describe('Numeric case_id: decimal digits, at most 9223372036854775807.'),
};

// ── API-04 tool inputs (flat; derived from the shared transport rule table) ────

const enumOf = (values: readonly string[]): ZodType =>
  z.enum(values as unknown as [string, ...string[]]);

/** One optional (nullable) flat argument per rule, typed by its lexical kind. */
const flatShape = (rules: readonly FlatRule[]): ZodRawShape => {
  const shape: Record<string, ZodType> = {};
  for (const r of rules) {
    const scalar = r.enumValues !== undefined ? enumOf(r.enumValues) : z.string();
    const base: ZodType =
      r.kind === 'string'
        ? scalar
        : r.kind === 'stringList'
          ? z.array(scalar)
          : r.kind === 'int'
            ? z.number().int()
            : z.boolean();
    shape[r.key] = base.nullable().optional().describe(r.description);
  }
  return shape;
};

/** The page of a new list tool: an integer 1..50 (omitted/null = 20) + the repo cursor. */
const pageShape = {
  first: z
    .number()
    .int()
    .min(1)
    .max(JUDICIAL_DECISION_PAGE_MAX)
    .nullable()
    .optional()
    .describe('Page size: an integer 1 to 50; omitted or null means 20.'),
  after: z
    .string()
    .nullable()
    .optional()
    .describe('The exact meta.cursor.next of the previous page (same filter).'),
};

export const listJudicialCourtsInput = flatShape(COURT_FLAT_RULES);

export const getJudicialCourtInput = {
  institutionCode: z.string().describe('Court institution code (exact).'),
};

export const listJudicialCasesInput = {
  ...flatShape(CASE_FLAT_RULES),
  sort: z
    .enum(['modifiedAt', 'openedAt'])
    .nullable()
    .optional()
    .describe('Sort key; omitted or null means modifiedAt.'),
  dir: z
    .enum(['ASC', 'DESC'])
    .nullable()
    .optional()
    .describe('Direction; omitted or null means DESC.'),
  ...pageShape,
};

export const getCaseLineageInput = {
  caseId: z.string().describe('Numeric case_id: decimal digits, at most 9223372036854775807.'),
};

export const listCompanyLitigationCasesInput = { ...getCompanyLitigationInput, ...pageShape };

export const listCasesCitingActInput = {
  targetActId: z.string().describe('Legal act id: decimal digits, at most 9223372036854775807.'),
  ...pageShape,
};

export const listJudicialIssuingBodiesInput = {};

export const listJudicialDecisionsInput = { ...flatShape(DECISION_FLAT_RULES), ...pageShape };

export const getJudicialDecisionInput = {
  decisionId: z.string().describe('Native decision_id: a canonical signed int8 decimal string.'),
};

export const getJudicialDecisionBySourceInput = {
  sourceSystem: z.string().describe('Exact stored source system.'),
  sourceRef: z.string().describe('Exact stored source reference.'),
};

export const listJudicialDecisionSubjectLinksInput = {
  ...flatShape(DECISION_LINK_FLAT_RULES),
  ...pageShape,
};

export const resolveJudicialDecisionFiltersInput = {
  dim: z
    .enum(JUDICIAL_DECISION_RESOLVE_DIMS)
    .describe(
      'Dimension: issuingBody (stored bodies), sourceSystem (distinct stored values), subjectKind (the five kinds), validationStatus (the four recorded status labels).'
    ),
  q: z.string().describe('The free-text query (contains match).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(JUDICIAL_RESOLVE_LIMIT_MAX)
    .nullable()
    .optional()
    .describe('Max hits: an integer 1 to 50; omitted or null means 10.'),
};
