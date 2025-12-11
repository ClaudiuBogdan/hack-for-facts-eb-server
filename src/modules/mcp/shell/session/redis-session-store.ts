/**
 * Redis Session Store for MCP
 *
 * Stores MCP sessions in Redis with TTL-based expiration.
 */

import type { McpSessionStore } from '../../core/ports.js';
import type { McpSession } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Safe Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely parses a JSON string into an McpSession.
 * Returns null if parsing fails or data is invalid.
 */
function safeParseSession(data: string): McpSession | null {
  let parsed: unknown;
  try {
    // eslint-disable-next-line no-restricted-syntax -- This IS the safe parsing implementation
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }

  // Basic structure validation
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'id' in parsed &&
    'lastAccessedAt' in parsed
  ) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['id'] === 'string' && typeof obj['lastAccessedAt'] === 'number') {
      return parsed as McpSession;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic Redis client interface.
 * Compatible with ioredis or node-redis.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Options for creating the Redis session store.
 */
export interface RedisSessionStoreOptions {
  /** Redis client instance */
  redis: RedisClient;
  /** Cache key prefix */
  keyPrefix?: string;
  /** Session TTL in seconds */
  ttlSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis-based MCP session store.
 */
class RedisSessionStore implements McpSessionStore {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisSessionStoreOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? 'mcp:session:';
    this.ttlSeconds = options.ttlSeconds;
  }

  private getKey(sessionId: string): string {
    return this.keyPrefix + sessionId;
  }

  async get(sessionId: string): Promise<McpSession | null> {
    const key = this.getKey(sessionId);
    try {
      const data = await this.redis.get(key);
      if (data === null) {
        return null;
      }
      return safeParseSession(data);
    } catch {
      // Session errors should not break functionality
      return null;
    }
  }

  async set(session: McpSession): Promise<void> {
    const key = this.getKey(session.id);
    try {
      const data = JSON.stringify(session);
      await this.redis.set(key, data, 'EX', this.ttlSeconds);
    } catch {
      // Session errors should not break functionality
    }
  }

  async delete(sessionId: string): Promise<void> {
    const key = this.getKey(sessionId);
    try {
      await this.redis.del(key);
    } catch {
      // Session errors should not break functionality
    }
  }

  async touch(sessionId: string): Promise<void> {
    const key = this.getKey(sessionId);
    try {
      // Get current session
      const data = await this.redis.get(key);
      if (data === null) {
        return;
      }

      // Update last accessed time
      const session = safeParseSession(data);
      if (session === null) {
        return;
      }
      session.lastAccessedAt = Date.now();

      // Re-set with fresh TTL
      await this.redis.set(key, JSON.stringify(session), 'EX', this.ttlSeconds);
    } catch {
      // Session errors should not break functionality
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Redis-based MCP session store.
 */
export const makeRedisSessionStore = (options: RedisSessionStoreOptions): McpSessionStore => {
  return new RedisSessionStore(options);
};

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Session Store (for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory session store for testing and development.
 * Sessions are NOT persisted and expire based on TTL check.
 */
class InMemorySessionStore implements McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  private isExpired(session: McpSession): boolean {
    return Date.now() - session.lastAccessedAt > this.ttlMs;
  }

  get(sessionId: string): Promise<McpSession | null> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return Promise.resolve(null);
    }
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return Promise.resolve(null);
    }
    return Promise.resolve(session);
  }

  set(session: McpSession): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  touch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined && !this.isExpired(session)) {
      session.lastAccessedAt = Date.now();
    }
    return Promise.resolve();
  }

  /**
   * Clean up expired sessions (call periodically in long-running tests).
   */
  cleanup(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Clear all sessions (for test teardown).
   */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Creates an in-memory session store for testing.
 */
export const makeInMemorySessionStore = (
  ttlSeconds: number
): McpSessionStore & {
  cleanup(): void;
  clear(): void;
} => {
  return new InMemorySessionStore(ttlSeconds);
};
