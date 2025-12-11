/**
 * MCP Module - Error Definitions
 *
 * Domain errors specific to MCP tools.
 * All errors are minimal: code + short message.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Interface
// ─────────────────────────────────────────────────────────────────────────────

/** MCP error structure (minimal for AI consumers) */
export interface McpError {
  readonly code: string;
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_ERROR_CODES = {
  // Entity errors
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  ENTITY_SEARCH_FAILED: 'ENTITY_SEARCH_FAILED',

  // UAT errors
  UAT_NOT_FOUND: 'UAT_NOT_FOUND',

  // Classification errors
  CLASSIFICATION_NOT_FOUND: 'CLASSIFICATION_NOT_FOUND',

  // Input validation errors
  INVALID_PERIOD: 'INVALID_PERIOD',
  INVALID_FILTER: 'INVALID_FILTER',
  INVALID_CATEGORY: 'INVALID_CATEGORY',
  INVALID_INPUT: 'INVALID_INPUT',

  // Infrastructure errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  SHARE_LINK_ERROR: 'SHARE_LINK_ERROR',

  // Auth/Rate limit errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',

  // Generic errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an MCP error with code and message.
 */
export const createMcpError = (code: McpErrorCode, message: string): McpError => ({
  code,
  message,
});

// Specific error constructors for common cases

export const entityNotFoundError = (cui: string): McpError =>
  createMcpError(MCP_ERROR_CODES.ENTITY_NOT_FOUND, `Entity with CUI '${cui}' not found`);

export const entitySearchNotFoundError = (search: string): McpError =>
  createMcpError(MCP_ERROR_CODES.ENTITY_NOT_FOUND, `No entity found matching '${search}'`);

export const uatNotFoundError = (id: string): McpError =>
  createMcpError(MCP_ERROR_CODES.UAT_NOT_FOUND, `UAT with ID '${id}' not found`);

export const classificationNotFoundError = (
  code: string,
  type: 'functional' | 'economic'
): McpError =>
  createMcpError(
    MCP_ERROR_CODES.CLASSIFICATION_NOT_FOUND,
    `${type === 'functional' ? 'Functional' : 'Economic'} classification '${code}' not found`
  );

export const invalidPeriodError = (reason: string): McpError =>
  createMcpError(MCP_ERROR_CODES.INVALID_PERIOD, reason);

export const invalidFilterError = (reason: string): McpError =>
  createMcpError(MCP_ERROR_CODES.INVALID_FILTER, reason);

export const invalidCategoryError = (category: string): McpError =>
  createMcpError(MCP_ERROR_CODES.INVALID_CATEGORY, `Unsupported category: ${category}`);

export const invalidInputError = (reason: string): McpError =>
  createMcpError(MCP_ERROR_CODES.INVALID_INPUT, reason);

export const databaseError = (detail?: string): McpError =>
  createMcpError(
    MCP_ERROR_CODES.DATABASE_ERROR,
    detail !== undefined ? `Query failed: ${detail}` : 'Query failed'
  );

export const timeoutError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.TIMEOUT_ERROR, 'Query timed out');

export const shareLinkError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.SHARE_LINK_ERROR, 'Failed to create shareable link');

export const unauthorizedError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.UNAUTHORIZED, 'Authentication required');

export const rateLimitExceededError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.RATE_LIMIT_EXCEEDED, 'Too many requests');

export const sessionNotFoundError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.SESSION_NOT_FOUND, 'Session not found');

export const sessionExpiredError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.SESSION_EXPIRED, 'Session expired');

export const internalError = (): McpError =>
  createMcpError(MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal error');

// ─────────────────────────────────────────────────────────────────────────────
// Error Type Union (for domain errors from other modules)
// ─────────────────────────────────────────────────────────────────────────────

/** Domain error types that can be mapped to MCP errors */
export type DomainErrorType =
  | 'DatabaseError'
  | 'TimeoutError'
  | 'EntityNotFoundError'
  | 'UATNotFoundError'
  | 'InvalidFilterError'
  | 'InvalidPeriodError'
  | 'ClassificationError';

/** Interface for domain errors that have a type field */
export interface DomainError {
  readonly type: string;
  readonly message: string;
}

/**
 * Maps a domain error from another module to an MCP error.
 * This provides consistent error handling across all MCP tools.
 */
export const toMcpError = (error: DomainError): McpError => {
  switch (error.type) {
    case 'EntityNotFoundError':
      return createMcpError(MCP_ERROR_CODES.ENTITY_NOT_FOUND, error.message);
    case 'UATNotFoundError':
      return createMcpError(MCP_ERROR_CODES.UAT_NOT_FOUND, error.message);
    case 'InvalidFilterError':
      return createMcpError(MCP_ERROR_CODES.INVALID_FILTER, error.message);
    case 'InvalidPeriodError':
      return createMcpError(MCP_ERROR_CODES.INVALID_PERIOD, error.message);
    case 'TimeoutError':
      return timeoutError();
    case 'DatabaseError':
      return databaseError(error.message);
    case 'ClassificationError':
      return createMcpError(MCP_ERROR_CODES.CLASSIFICATION_NOT_FOUND, error.message);
    default:
      return internalError();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Response Builder
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a failed MCP tool response */
export const failedResult = (error: McpError): { ok: false; error: McpError } => ({
  ok: false,
  error,
});

/** Builds a successful MCP tool response */
export const successResult = <T>(data: T): { ok: true; data: T; error?: McpError } => ({
  ok: true,
  data,
});
