/**
 * MCP (Model Context Protocol) Authentication
 *
 * Provides authentication for MCP server handlers.
 */

import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { mcpSessionExtractor, type MCPRequest } from '../extractors/mcp-extractor.js';

import type { AuthError } from '../../core/errors.js';
import type { AuthContext, UserId } from '../../core/types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP handler with authentication context.
 */
export interface AuthenticatedMCPContext {
  auth: AuthContext;
  request: MCPRequest;
}

/**
 * MCP tool handler function type (without auth).
 */
export type MCPToolHandler<TInput, TOutput> = (
  input: TInput,
  context: AuthenticatedMCPContext
) => Promise<TOutput>;

/**
 * MCP tool handler function type (with userId).
 */
export type AuthenticatedMCPToolHandler<TInput, TOutput> = (
  input: TInput,
  context: AuthenticatedMCPContext,
  userId: UserId
) => Promise<TOutput>;

/**
 * Dependencies for creating MCP auth service.
 */
export type MakeMCPAuthServiceDeps = AuthenticateDeps;

/**
 * MCP authentication service interface.
 */
export interface MCPAuthService {
  /**
   * Authenticate an MCP request and return auth context.
   */
  authenticate(request: MCPRequest): Promise<Result<AuthContext, AuthError>>;

  /**
   * Wrap a tool handler with authentication context.
   * Does not require authentication - just provides context.
   */
  withContext<TInput, TOutput>(
    handler: MCPToolHandler<TInput, TOutput>
  ): (input: TInput, request: MCPRequest) => Promise<TOutput>;

  /**
   * Wrap a tool handler with authentication requirement.
   * Throws if user is not authenticated.
   */
  withAuth<TInput, TOutput>(
    handler: AuthenticatedMCPToolHandler<TInput, TOutput>
  ): (input: TInput, request: MCPRequest) => Promise<TOutput>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates MCP authentication service.
 *
 * @example
 * // Setup
 * const mcpAuth = makeMCPAuthService({ authProvider });
 *
 * // Public tool (auth context available but not required)
 * const getEntityTool = mcpAuth.withContext(async (input, ctx) => {
 *   console.log('Authenticated:', ctx.auth.userId !== null);
 *   const entity = await entityRepo.getById(input.cui);
 *   return { entity };
 * });
 *
 * // Protected tool (requires authentication)
 * const createNotificationTool = mcpAuth.withAuth(async (input, ctx, userId) => {
 *   // userId is guaranteed to be valid here
 *   const notification = await notificationRepo.create({ userId, ...input });
 *   return { notification };
 * });
 */
export const makeMCPAuthService = (deps: MakeMCPAuthServiceDeps): MCPAuthService => {
  return {
    async authenticate(request: MCPRequest): Promise<Result<AuthContext, AuthError>> {
      const token = mcpSessionExtractor.extractToken(request);
      return authenticate(deps, { token });
    },

    withContext<TInput, TOutput>(handler: MCPToolHandler<TInput, TOutput>) {
      return async (input: TInput, request: MCPRequest): Promise<TOutput> => {
        const authResult = await authenticate(deps, {
          token: mcpSessionExtractor.extractToken(request),
        });

        // For context-only wrapper, use anonymous if auth fails
        const auth: AuthContext = authResult.isOk()
          ? authResult.value
          : { userId: null, isAnonymous: true as const };

        const context: AuthenticatedMCPContext = {
          auth,
          request,
        };

        return handler(input, context);
      };
    },

    withAuth<TInput, TOutput>(handler: AuthenticatedMCPToolHandler<TInput, TOutput>) {
      return async (input: TInput, request: MCPRequest): Promise<TOutput> => {
        const authResult = await authenticate(deps, {
          token: mcpSessionExtractor.extractToken(request),
        });

        if (authResult.isErr()) {
          throw new Error(`Authentication failed: ${authResult.error.message}`);
        }

        const auth = authResult.value;
        const userIdResult = requireAuth(auth);

        if (userIdResult.isErr()) {
          throw new Error(`Authentication required: ${userIdResult.error.message}`);
        }

        const context: AuthenticatedMCPContext = {
          auth,
          request,
        };

        return handler(input, context, userIdResult.value);
      };
    },
  };
};
