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
};

export default config;
