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
 * What is logged of one GraphQL error: fixed categories only, never its message, path keys or
 * any other text. A message can quote a value the caller sent (a variable-coercion error quotes
 * it whole, in any spelling: escaped, encoded, as a number), and a path key can be a
 * caller-chosen alias, so no redaction of free text is attempted.
 */
export interface LoggedGraphQLError {
  /** The error's code when it has a code's shape (A-Z and _), else its class name, else `unknown`. */
  readonly category: string;
  /** execution (it has a path), validation (locations, no path) or request. */
  readonly kind: 'execution' | 'validation' | 'request';
  /** How deep in the response the error sits; null outside execution. */
  readonly pathDepth: number | null;
}

/**
 * The error codes the API and Mercurius emit (static text in code); any other code is logged as
 * `other_code`, so a code built from caller text can never reach a log line.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  'BAD_USER_INPUT',
  'INVALID_INPUT',
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'UPGRADE_REQUIRED',
  'RELEASE_MISMATCH',
  'IDEMPOTENCY_KEY_REUSED',
  'NOT_PORTED',
  'PNRR_UNAVAILABLE',
  'RENDER_UNAVAILABLE',
  'RENDER_RESTRICTED',
  'RENDER_INCONSISTENT',
  'IMPLAUSIBLE_REVENUE',
  'REVENUE_EQUALS_FIXED_ASSETS',
]);
const MERCURIUS_CODE = /^MER_ERR_[A-Z_]{1,60}$/u;
/** The error classes logged by name; any other class is `other_error`. */
const KNOWN_CLASSES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'AggregateError',
  'GraphQLError',
]);

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const categoryOf = (error: unknown): string => {
  const code = field(field(error, 'extensions'), 'code');
  if (typeof code === 'string')
    return KNOWN_CODES.has(code) || MERCURIUS_CODE.test(code) ? code : 'other_code';
  const original = field(error, 'originalError');
  const name = field(original ?? error, 'name');
  if (typeof name !== 'string') return 'unknown';
  return KNOWN_CLASSES.has(name) ? name : 'other_error';
};

const UNREADABLE: LoggedGraphQLError = { category: 'unknown', kind: 'request', pathDepth: null };

const loggedError = (error: unknown): LoggedGraphQLError => {
  // An error value can have throwing getters: logging never interrupts formatting.
  try {
    const path = field(error, 'path');
    const locations = field(error, 'locations');
    return {
      category: categoryOf(error),
      kind: Array.isArray(path) ? 'execution' : Array.isArray(locations) ? 'validation' : 'request',
      pathDepth: Array.isArray(path) ? path.length : null,
    };
  } catch {
    return UNREADABLE;
  }
};

/** What is logged of GraphQL errors (`LoggedGraphQLError`); never throws on an unusual error value. */
export const loggedGraphQLErrors = (errors: readonly unknown[] | undefined): LoggedGraphQLError[] =>
  (errors ?? []).flatMap((error) => {
    // Mercurius wraps a validation failure's errors in one error (MER_ERR_GQL_VALIDATION).
    let nested: unknown;
    try {
      nested = field(field(error, 'originalError'), 'errors');
    } catch {
      nested = undefined;
    }
    return Array.isArray(nested) ? nested.map(loggedError) : [loggedError(error)];
  });

/** An operation type as logged: one of GraphQL's three, else `unknown` (never caller text). */
export const loggedOperationType = (type: string): string =>
  type === 'query' || type === 'mutation' || type === 'subscription' ? type : 'unknown';

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
 * Shared error formatting for every public GraphQL surface: errors are logged as fixed categories
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
