import {
  GraphQLError,
  NoSchemaIntrospectionCustomRule,
  type ASTNode,
  type GraphQLFormattedError,
  type ValidationRule,
} from 'graphql';
import depthLimit from 'graphql-depth-limit';
import mercuriusPlugin, { type MercuriusOptions } from 'mercurius';

/** Maximum nesting allowed for a GraphQL operation. */
const MAX_QUERY_DEPTH = 10;

/**
 * A depth limit does not stop a shallow query from repeating an expensive
 * field through hundreds of aliases. Keep both the total document size and
 * the alias fan-out bounded before execution starts.
 */
const MAX_QUERY_FIELDS = 500;
const MAX_QUERY_ALIASES = 50;
const MAX_HEAVY_BUDGET_FIELDS = 2;
export const HEAVY_BUDGET_FIELD_NAMES = [
  'budgetAggregateByClassification',
  'budgetAggregateTimeseries',
  'budgetEntityRanking',
  'budgetEntityRankingPage',
  'budgetUatHeatmap',
  'budgetCountyHeatmap',
] as const;
const HEAVY_BUDGET_FIELDS = new Set<string>(HEAVY_BUDGET_FIELD_NAMES);

const validationError = (message: string, node: ASTNode | readonly ASTNode[]) =>
  new GraphQLError(message, { nodes: node });

const makeDocumentSizeRule = (): ValidationRule => (context) => {
  let fieldCount = 0;
  let aliasCount = 0;
  let heavyBudgetFieldCount = 0;
  let fieldErrorReported = false;
  let aliasErrorReported = false;
  let heavyBudgetFieldErrorReported = false;

  return {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL AST visitor keys use node-kind names.
    Field(node) {
      fieldCount += 1;
      if (fieldCount > MAX_QUERY_FIELDS && !fieldErrorReported) {
        fieldErrorReported = true;
        context.reportError(
          validationError(`Query exceeds maximum field count of ${String(MAX_QUERY_FIELDS)}.`, node)
        );
      }

      if (node.alias !== undefined) {
        aliasCount += 1;
        if (aliasCount > MAX_QUERY_ALIASES && !aliasErrorReported) {
          aliasErrorReported = true;
          context.reportError(
            validationError(
              `Query exceeds maximum alias count of ${String(MAX_QUERY_ALIASES)}.`,
              node
            )
          );
        }
      }

      if (HEAVY_BUDGET_FIELDS.has(node.name.value)) {
        heavyBudgetFieldCount += 1;
        if (heavyBudgetFieldCount > MAX_HEAVY_BUDGET_FIELDS && !heavyBudgetFieldErrorReported) {
          heavyBudgetFieldErrorReported = true;
          context.reportError(
            validationError(
              `Query exceeds maximum heavy budget field count of ${String(MAX_HEAVY_BUDGET_FIELDS)}.`,
              node
            )
          );
        }
      }
    },
  };
};

/** Shared validation policy for every public GraphQL surface. */
export const makeGraphQLValidationRules = (isProduction: boolean): ValidationRule[] => [
  depthLimit(MAX_QUERY_DEPTH) as ValidationRule,
  makeDocumentSizeRule(),
  ...(isProduction ? [NoSchemaIntrospectionCustomRule] : []),
];

const SAFE_ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'INVALID_INPUT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
]);

/** Shared production error redaction for every public GraphQL surface. */
export const makeGraphQLErrorFormatter =
  (isProduction: boolean): NonNullable<MercuriusOptions['errorFormatter']> =>
  (execution, context) => {
    const response = mercuriusPlugin.defaultErrorFormatter(execution, context);

    if (!isProduction) return response;

    const errors = response.response.errors;
    if (Array.isArray(errors)) {
      response.response.errors = errors.map((error) => {
        const next = { ...error } as Record<string, unknown>;
        const extensionsRaw = (error as Record<string, unknown>)['extensions'];
        const extensions =
          typeof extensionsRaw === 'object' && extensionsRaw !== null
            ? { ...(extensionsRaw as Record<string, unknown>) }
            : undefined;

        if (extensions !== undefined) {
          delete extensions['exception'];
          next['extensions'] = extensions;
        }

        const code = extensions?.['code'];
        const isSafeCode = typeof code === 'string' && SAFE_ERROR_CODES.has(code);
        const hasPath = Array.isArray((error as Record<string, unknown>)['path']);
        const hasLocations = Array.isArray((error as Record<string, unknown>)['locations']);
        const isValidationStyleGraphQLError = !hasPath && hasLocations;

        if (!isSafeCode && !isValidationStyleGraphQLError) {
          next['message'] = 'Internal server error';
        }

        return next as unknown as GraphQLFormattedError;
      });
    }

    return response;
  };
