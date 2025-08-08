import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// Export environment variables
export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/budget_db",
  // Optional DB tunables
  dbPoolMax: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : undefined,
  dbPoolIdleMs: process.env.DB_POOL_IDLE_MS ? parseInt(process.env.DB_POOL_IDLE_MS, 10) : undefined,
  dbConnectionTimeoutMs: process.env.DB_CONNECTION_TIMEOUT_MS ? parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) : undefined,
  dbStatementTimeoutMs: process.env.DB_STATEMENT_TIMEOUT_MS ? parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10) : undefined,
  dbIdleInTxTimeoutMs: process.env.DB_IDLE_IN_TX_TIMEOUT_MS ? parseInt(process.env.DB_IDLE_IN_TX_TIMEOUT_MS, 10) : undefined,
  dbUseSSL: (process.env.DB_USE_SSL || '').toLowerCase() === 'true',
  dbRejectUnauthorizedSSL: (process.env.DB_REJECT_UNAUTHORIZED_SSL || '').toLowerCase() === 'true',
  // Rate limit config
  rateLimitMax: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 300,
  rateLimitTimeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute",
  specialRateLimitKey: process.env.SPECIAL_RATE_LIMIT_KEY || "",
  specialRateLimitHeader: (process.env.SPECIAL_RATE_LIMIT_HEADER || "x-api-key").toLowerCase(),
  specialRateLimitMax: process.env.SPECIAL_RATE_LIMIT_MAX ? parseInt(process.env.SPECIAL_RATE_LIMIT_MAX, 10) : 1200,
  // Cache config
  cache: {
    // Defaults chosen for analytics-heavy workloads; override via env
    enabled: (process.env.CACHE_ENABLED || 'true').toLowerCase() === 'true',
    // Global default TTL for entries unless module overrides
    ttlMs: process.env.CACHE_TTL_MS ? parseInt(process.env.CACHE_TTL_MS, 10) : 1000 * 60 * 60, // 1 hour
    // Memory cap across caches (soft per LRU instance). Modules can set lower caps.
    maxSizeBytes: process.env.CACHE_MAX_SIZE_BYTES ? parseInt(process.env.CACHE_MAX_SIZE_BYTES, 10) : 200 * 1024 * 1024, // 200MB
    // Max items per cache
    maxItems: process.env.CACHE_MAX_ITEMS ? parseInt(process.env.CACHE_MAX_ITEMS, 10) : 20000,
  },
};

export default config;
