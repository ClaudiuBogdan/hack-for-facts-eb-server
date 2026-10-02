/**
 * Companies analytics — GraphQL resolvers. Thin: the raw arguments go to the
 * same usecase the MCP tool calls (which validates them), and `ApiError`
 * becomes a `GraphQLError` with `extensions.code` (+ `field` for invalid input).
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
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

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toAnalysisGraphqlError(result.error);
  return result.value;
};

type Args = Readonly<Record<string, unknown>>;

export const makeCompanyAnalysisResolvers = (
  analytics: CompanyAnalysisContext
): { readonly Query: Record<string, (root: unknown, args: Args) => Promise<unknown>> } => ({
  Query: {
    companyAnalysisRelease: async (_root, args) =>
      unwrap(await companyAnalysisRelease(analytics, args)),
    companyAnalysisStats: async (_root, args) =>
      unwrap(await companyAnalysisStats(analytics, args)),
    companyAnalysisBreakdown: async (_root, args) =>
      unwrap(await companyAnalysisBreakdown(analytics, args)),
    companyAnalysisSeries: async (_root, args) =>
      unwrap(await companyAnalysisSeries(analytics, args)),
    companyAnalysisRecords: async (_root, args) =>
      unwrap(await companyAnalysisRecords(analytics, args)),
  },
});
