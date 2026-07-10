/**
 * Parliament module — MCP tool I/O shapes (plan 04 §8). Zod input shapes + the
 * `McpToolOutput` kinds each tool returns. Handlers (in `tools.ts`) call the SAME
 * usecase the GraphQL resolvers do (tri-surface equivalence, §14.7); output is the
 * kernel `{ ok, kind, query?, link?, item|items?, summary? }` object. Naming
 * `<verb>_parliament_<noun>` (§6.3). NEVER emits excluded columns (§2.6).
 *
 * Five tools (discovery + query families, §6.3):
 *   resolve_parliament_filters   (discovery) → kind 'resolution'
 *   get_parliament_law_lineage   (marquee)   → kind 'lineage'
 *   get_parliament_member_activity           → kind 'member_activity'
 *   rank_parliament_vote_cohesion            → kind 'cohesion'
 *   search_parliament_speeches               → kind 'speeches'
 */

import { z } from 'zod';

export const PARLIAMENT_MCP_KINDS = {
  resolve: 'resolution',
  lineage: 'lineage',
  memberActivity: 'member_activity',
  cohesion: 'cohesion',
  speeches: 'speeches',
} as const;

export const resolveParliamentFiltersInput = {
  dim: z
    .enum(['group', 'person', 'constituency', 'recipient', 'control_type', 'outcome', 'chamber'])
    .describe(
      'Dimension to resolve: group/person/constituency/recipient (name→value), control_type/outcome/chamber (label→enum).'
    ),
  q: z
    .string()
    .describe('The free-text query (group name, person name, county, ministry, or label).'),
  legislature: z
    .string()
    .optional()
    .describe('Scope group/person resolution to a legislature (e.g. 2024).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
};

/**
 * The kernel `LegalActByIdLoader` loads by `act_id` ONLY (no citation resolver in
 * the kernel — Codex SHOULD-FIX). So lineage takes an `actId`; an agent resolves a
 * free-text citation → act_id FIRST via the legal module's `resolve_legal_filters`
 * (dim=act) tool (the cross-module Entity Resolution Gate), then calls this. We do
 * NOT accept a citation here, because parliament cannot resolve one without
 * importing legal (forbidden, §2).
 */
export const getParliamentLawLineageInput = {
  actId: z
    .string()
    .describe(
      'Numeric legal act_id. Resolve a citation (e.g. "legea 423/2023") to an act_id FIRST via the legal resolve_legal_filters tool (dim=act).'
    ),
  roles: z
    .array(z.string())
    .optional()
    .describe('Vote roles to include (default final_adoption, final_rejection).'),
  includeBallots: z
    .boolean()
    .optional()
    .describe('Include per-vote ballot resolution counts (default false).'),
};

export const getParliamentMemberActivityInput = {
  mandateKey: z.string().optional().describe('A single mandate key (e.g. 2:2020:12).'),
  personId: z
    .string()
    .optional()
    .describe('A person_id — fans the activity across ALL the person mandates.'),
  kinds: z
    .array(z.enum(['votes', 'control', 'speeches', 'initiatives']))
    .optional()
    .describe('Which activity kinds to return (default all four).'),
  limit: z.number().int().min(1).max(100).optional().describe('Max items per kind (default 20).'),
};

/**
 * Same boundedness contract as the GraphQL `parliamentSpeeches` root (tri-surface
 * equivalence): the tool calls the SAME `listParliamentSpeeches` usecase, so an
 * unbounded call returns an in-band `{ok:false, error}` — never a silent default.
 */
export const searchParliamentSpeechesInput = {
  q: z
    .string()
    .optional()
    .describe(
      'Free-text substring (case-insensitive, diacritic-sensitive) over speech title + summary; with a mandateKey (or a window of at most 92 days) it also searches the verbatim transcript. Does NOT bound the scan by itself.'
    ),
  mandateKey: z
    .string()
    .optional()
    .describe(
      'Speaker mandate key (e.g. 2:2020:12). BOUNDS the query — required unless BOTH from and to are given.'
    ),
  chamber: z
    .enum(['camera_deputatilor', 'senat', 'comun'])
    .optional()
    .describe(
      'Assembly of the sitting (comun = a joint sitting). Does NOT bound the scan by itself.'
    ),
  from: z
    .string()
    .optional()
    .describe(
      'Window start date (YYYY-MM-DD). Without a mandateKey the tool REQUIRES both from and to, at most 366 days apart (at most 92 days for transcript-deep q search).'
    ),
  to: z.string().optional().describe('Window end date (YYYY-MM-DD), inclusive. See from.'),
  limit: z.number().int().min(1).max(100).optional().describe('Max speeches (default 20).'),
  after: z
    .string()
    .optional()
    .describe(
      'Opaque pagination cursor from a previous call (meta.nextCursor). MUST be replayed with the SAME q/mandateKey/chamber/from/to — a changed query invalidates the cursor.'
    ),
};

export const rankParliamentVoteCohesionInput = {
  billKey: z.string().optional().describe('A single bill — its votes form the bounded set.'),
  chamber: z
    .enum(['camera_deputatilor', 'senat', 'comun'])
    .optional()
    .describe('Chamber for a date-window vote set (with from + to).'),
  from: z.string().optional().describe('Window start date (YYYY-MM-DD).'),
  to: z.string().optional().describe('Window end date (YYYY-MM-DD).'),
  group: z.string().optional().describe('Restrict cohesion to one parliamentary group.'),
};
