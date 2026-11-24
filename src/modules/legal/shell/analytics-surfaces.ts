/**
 * Legislation analytics on GraphQL and MCP: one field and one tool over the
 * SAME usecase the REST routes call (`getLegalAnalytics`), with the same
 * arguments, validation and layer-keyed cache. The answer's data is the REST
 * `data` object, carried as JSON: the views' shapes are typed in
 * `core/analytics/types.ts`, and the page reads them over REST.
 */

import { GraphQLError } from 'graphql';
import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { LEGAL_ANALYTICS_VIEWS, type LegalAnalyticsArgs } from '../core/analytics/types.js';
import { getLegalAnalytics, type LegalAnalyticsDeps } from '../core/analytics/usecases.js';

export const legalAnalyticsTypeDefs = /* GraphQL */ `
  enum LegalAnalyticsView {
    HEAD
    SUMMARY
    BREAKDOWN
    SERIES
    GRID
    LINKS
    ACTS
  }

  "The filter and view arguments of the legislation analytics reads (the REST query parameters)."
  input LegalAnalyticsArgs {
    "flow (every act published, the default) or stock"
    population: String
    from: Int
    to: Int
    "normalised act types"
    type: [String!]
    "an issuer lineage"
    issuer: String
    family: String
    "a Felul group, a kind, uncertain or unplaced (a group or kind counts firm placements only)"
    felul: String
    "version band 0-3"
    versions: Int
    lens: String
    by: String
    limit: Int
    top: Int
    order: String
    cursor: String
  }

  "One answer from the published insights layer: counts with their denominators, never shares."
  type LegalAnalyticsAnswer {
    view: String!
    "the layer read: ids, build and publication times, the release's dates"
    layer: JSON!
    "the canonical arguments (defaults dropped)"
    args: JSON!
    "the view's data, as REST serves it"
    data: JSON!
  }

  extend type Query {
    "Legislation analytics over the published insights layer (one read-only snapshot per call)."
    legalAnalytics(view: LegalAnalyticsView!, args: LegalAnalyticsArgs): LegalAnalyticsAnswer!
  }
`;

const served = (answer: {
  readonly view: string;
  readonly layer: unknown;
  readonly args: unknown;
  readonly data: unknown;
}) => ({ view: answer.view, layer: answer.layer, args: answer.args, data: answer.data });

/** GraphQL/MCP input objects may carry nulls; the usecase takes absent arguments. */
const argsOf = (raw: unknown): LegalAnalyticsArgs =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== null && value !== undefined)
      )
    : {};

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

export const makeLegalAnalyticsResolvers = (deps: LegalAnalyticsDeps) => ({
  Query: {
    legalAnalytics: async (_root: unknown, input: { view: string; args?: unknown }) => {
      const answer = await getLegalAnalytics(deps, input.view.toLowerCase(), argsOf(input.args));
      if (answer.isErr()) throw toGraphqlError(answer.error);
      return served(answer.value);
    },
  },
});

export const LEGAL_ANALYTICS_MCP_KIND = 'legal_analytics';

const queryLegalAnalyticsInput = {
  view: z
    .enum(LEGAL_ANALYTICS_VIEWS)
    .describe(
      'head (the layer, its value lists, totals, types and issuers), summary, breakdown (lens, limit), series (lens, top; by year), grid (lens, by), links (link kinds, amendment flows, most-named targets, days), acts (order, limit, cursor).'
    ),
  args: z
    .object({
      population: z.enum(['flow', 'stock']).optional(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      type: z.array(z.string()).max(25).optional(),
      issuer: z.string().optional(),
      family: z.string().optional(),
      felul: z.string().optional(),
      versions: z.number().int().optional(),
      lens: z.enum(['felul', 'kind', 'issuer', 'family', 'type', 'versions', 'year']).optional(),
      by: z.enum(['felul', 'kind', 'issuer', 'family', 'type', 'versions', 'year']).optional(),
      limit: z.number().int().optional(),
      top: z.number().int().optional(),
      order: z.enum(['amended', 'court', 'versions', 'cited', 'year']).optional(),
      cursor: z.string().optional(),
    })
    .strict()
    .optional()
    .describe(
      'Filters (the same on every view) and the view arguments. felul is a Felul group, kind, "uncertain" or "unplaced"; values come from the head view.'
    ),
};

export const makeLegalAnalyticsMcpTool = (
  deps: LegalAnalyticsDeps,
  clientBaseUrl: string
): KernelMcpTool => ({
  name: 'query_legal_analytics',
  title: 'Legislation analytics',
  description:
    'Counts over Romanian legislation from the published insights layer (rules over act titles, not AI): acts by Felul actului (what the act does), issuer, type, version band and year, flow (every act published) or stock (acts that set rules and stand alone, placed firmly). Every answer gives counts with their denominator (total), the uncertain placements (weak rule matches, in no group) and the unplaced remainder; divide yourself. Links are citations named in titles (amends, approves or rejects an ordinance, promulgates, a court decision names an act), never legal effects. Start with view=head for the value lists.',
  inputShape: queryLegalAnalyticsInput,
  strictInput: true,
  async handler(args): Promise<McpToolOutput> {
    const view = typeof args['view'] === 'string' ? args['view'] : '';
    const input = argsOf(args['args']);
    const answer = await getLegalAnalytics(deps, view, input);
    if (answer.isErr())
      return {
        ok: false,
        kind: LEGAL_ANALYTICS_MCP_KIND,
        errorType: answer.error.type,
        error: answer.error.message,
      };
    const data = answer.value.data as { total?: unknown };
    return {
      ok: true,
      kind: LEGAL_ANALYTICS_MCP_KIND,
      query: { view, args: answer.value.args },
      link: `${clientBaseUrl}/legislation/analytics`,
      item: served(answer.value),
      meta: { layer: answer.value.layer },
      summary:
        typeof data.total === 'number'
          ? `${view} over ${String(data.total)} acts of insights layer ${answer.value.layer.layerId}.`
          : `${view} of insights layer ${answer.value.layer.layerId}.`,
    };
  },
});
