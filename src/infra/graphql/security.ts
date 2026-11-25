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

/**
 * Error codes whose messages are user-facing and pass through unredacted in
 * production. Every message emitted under one of these codes must be static
 * text written for the client; never interpolate a driver, upstream or
 * dependency error into it (`SERVICE_UNAVAILABLE` carries the fail-closed
 * normalization/population explanations the client shows verbatim).
 */
const SAFE_ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'INVALID_INPUT',
  'NOT_FOUND',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
]);

/**
 * Runs of 11+ digits, each joined by at most one white-space character or dash (a personal
 * numeric code, also as written with separators), and e-mail addresses, in the NFKC form.
 */
const LOGGED_CODE_RUN = /[0-9](?:[\s\u0085\p{Pd}\u2212]?[0-9]){10,}/gu;
const LOGGED_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/gu;

/**
 * Text as it may be logged: a GraphQL error message can quote a value the caller sent (a
 * variable-coercion error quotes it whole), so personal codes and e-mail addresses are redacted.
 */
export const redactLoggedText = (text: string): string =>
  text.normalize('NFKC').replace(LOGGED_EMAIL, '[email]').replace(LOGGED_CODE_RUN, '[digits]');

export interface LoggedGraphQLError {
  readonly code: string | null;
  readonly path: readonly (string | number)[] | null;
  readonly message: string;
}

/** What is logged of GraphQL errors: code, path and the redacted message (never the error object). */
export const loggedGraphQLErrors = (
  errors: readonly GraphQLError[] | undefined
): LoggedGraphQLError[] =>
  (errors ?? []).flatMap((error) => {
    // Mercurius wraps a validation failure's errors in one error (MER_ERR_GQL_VALIDATION).
    const nested: unknown = (error.originalError as { errors?: unknown } | undefined)?.errors;
    const all: readonly GraphQLError[] = Array.isArray(nested)
      ? (nested as GraphQLError[])
      : [error];
    return all.map((each) => {
      const code = (each.extensions as Record<string, unknown> | undefined)?.['code'];
      return {
        code: typeof code === 'string' ? code : null,
        path: Array.isArray(each.path) ? each.path : null,
        message: redactLoggedText(each.message),
      };
    });
  });

const noop = (): void => undefined;
/** Mercurius's default formatter logs each error's message whole; it gets this logger instead. */
const SILENT_LOG = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => SILENT_LOG,
};

/**
 * Shared error formatting for every public GraphQL surface: errors are logged redacted
 * (`loggedGraphQLErrors`), and in production the response is redacted too.
 */
export const makeGraphQLErrorFormatter =
  (isProduction: boolean): NonNullable<MercuriusOptions['errorFormatter']> =>
  (execution, context) => {
    const log =
      (context.reply as { log?: typeof context.app.log } | undefined)?.log ?? context.app.log;
    for (const error of loggedGraphQLErrors(execution.errors))
      log.info({ graphqlError: error }, 'GraphQL error');
    // The default formatter shapes the response as before; only its own logging is silenced.
    const quiet = Object.create(context, {
      reply: { value: { log: SILENT_LOG } },
      app: { value: { log: SILENT_LOG } },
    }) as typeof context;
    const response = mercuriusPlugin.defaultErrorFormatter(execution, quiet);

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
