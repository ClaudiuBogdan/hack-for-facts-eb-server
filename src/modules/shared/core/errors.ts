/**
 * Shared Kernel — Error model (foundation §5.1, §14.11).
 *
 * All expected failures are a discriminated `ApiError` union returned via
 * neverthrow `Result`. Core/usecases never throw for expected failures.
 *
 * - REST maps via `HTTP_STATUS`.
 * - GraphQL maps `type` → `extensions.code`.
 * - MCP returns `{ ok: false, error: type, message }`.
 */

export interface NotFoundError {
  readonly type: 'NotFound';
  readonly message: string;
  readonly resource?: string;
}

export interface InvalidInputError {
  readonly type: 'InvalidInput';
  readonly message: string;
  readonly field?: string;
}

export interface DatabaseError {
  readonly type: 'Database';
  readonly message: string;
  readonly cause?: unknown;
}

export interface UpstreamError {
  readonly type: 'Upstream';
  readonly message: string;
  readonly service?: string;
  readonly cause?: unknown;
}

export interface ServiceUnavailableError {
  readonly type: 'ServiceUnavailable';
  readonly message: string;
}

export interface TimeoutError {
  readonly type: 'Timeout';
  readonly message: string;
}

export type ApiError =
  | NotFoundError
  | InvalidInputError
  | DatabaseError
  | UpstreamError
  | ServiceUnavailableError
  | TimeoutError;

export const HTTP_STATUS: Record<ApiError['type'], number> = {
  NotFound: 404,
  InvalidInput: 400,
  Database: 500,
  Upstream: 502,
  ServiceUnavailable: 503,
  Timeout: 504,
};

/** GraphQL `extensions.code` for each error type. */
export const GRAPHQL_ERROR_CODE: Record<ApiError['type'], string> = {
  NotFound: 'NOT_FOUND',
  InvalidInput: 'INVALID_INPUT',
  Database: 'INTERNAL_SERVER_ERROR',
  Upstream: 'BAD_GATEWAY',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  Timeout: 'GATEWAY_TIMEOUT',
};

export const httpStatusFor = (error: ApiError): number => HTTP_STATUS[error.type];

// ─────────────────────────────────────────────────────────────────────────────
// Constructors
// ─────────────────────────────────────────────────────────────────────────────

export const notFound = (message: string, resource?: string): NotFoundError => ({
  type: 'NotFound',
  message,
  ...(resource !== undefined && { resource }),
});

export const invalidInput = (message: string, field?: string): InvalidInputError => ({
  type: 'InvalidInput',
  message,
  ...(field !== undefined && { field }),
});

export const databaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'Database',
  message,
  cause,
});

export const upstreamError = (
  message: string,
  service?: string,
  cause?: unknown
): UpstreamError => ({
  type: 'Upstream',
  message,
  ...(service !== undefined && { service }),
  cause,
});

export const serviceUnavailable = (message: string): ServiceUnavailableError => ({
  type: 'ServiceUnavailable',
  message,
});

export const timeoutError = (message: string): TimeoutError => ({
  type: 'Timeout',
  message,
});
