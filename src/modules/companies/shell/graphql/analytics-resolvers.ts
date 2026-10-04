/**
 * Companies analytics — GraphQL resolvers. Thin: the raw arguments go to the
 * same usecase the MCP tool calls (which validates them), and `ApiError`
 * becomes a `GraphQLError` with `extensions.code` (+ `field` for invalid input).
 *
 * Each served answer (empty stats, series and records included: they still
 * name a release) is registered with the request's EXISTING owning-result
 * guard: when the whole operation settled (a sibling root may have been
 * pending), its release is confirmed once more — still published, same
 * privacy epoch, same ONRC source — or this root is withheld with the typed
 * `release` error. No engine or label work is repeated.
 */

import { GraphQLError, type GraphQLResolveInfo } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  owningResultGuardOf,
  responsePathOf,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
  confirmServedAnalysis,
  type CompanyAnalysisContext,
} from '../../core/analytics-usecases.js';

import type { Result } from 'neverthrow';

export const toAnalysisGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: {
      code: GRAPHQL_ERROR_CODE[error.type],
      type: error.type,
      ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
    },
  });

type Args = Readonly<Record<string, unknown>>;
type Resolver = (
  root: unknown,
  args: Args,
  context?: unknown,
  info?: GraphQLResolveInfo
) => Promise<unknown>;

export const makeCompanyAnalysisResolvers = (
  analytics: CompanyAnalysisContext
): { readonly Query: Record<string, Resolver> } => {
  /** Unwrap, then register the served answer's release for the operation's final decision. */
  const owned = <T extends { readonly release: { readonly releaseId: string } }>(
    result: Result<T, ApiError>,
    context: unknown,
    info: GraphQLResolveInfo | undefined
  ): T => {
    if (result.isErr()) throw toAnalysisGraphqlError(result.error);
    const guard = owningResultGuardOf(context);
    if (guard !== null && info !== undefined) {
      const { releaseId } = result.value.release;
      guard.confirm(responsePathOf(info.path), () => confirmServedAnalysis(analytics, releaseId));
    }
    return result.value;
  };

  return {
    Query: {
      companyAnalysisRelease: async (_root, args, context, info) =>
        owned(await companyAnalysisRelease(analytics, args), context, info),
      companyAnalysisStats: async (_root, args, context, info) =>
        owned(await companyAnalysisStats(analytics, args), context, info),
      companyAnalysisBreakdown: async (_root, args, context, info) =>
        owned(await companyAnalysisBreakdown(analytics, args), context, info),
      companyAnalysisSeries: async (_root, args, context, info) =>
        owned(await companyAnalysisSeries(analytics, args), context, info),
      companyAnalysisRecords: async (_root, args, context, info) =>
        owned(await companyAnalysisRecords(analytics, args), context, info),
    },
  };
};
