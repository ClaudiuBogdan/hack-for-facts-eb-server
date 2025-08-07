import { Pool } from "pg";
import config from "../config";

// Create a tuned pool instance
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax ?? 20,
  idleTimeoutMillis: config.dbPoolIdleMs ?? 30_000,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs ?? 10_000,
  ssl: config.dbUseSSL ? { rejectUnauthorized: config.dbRejectUnauthorizedSSL ?? false } : undefined,
  application_name: "hack-for-facts-eb-server",
});

// Set safe per-connection settings
pool.on("connect", async (client) => {
  try {
    if (config.dbStatementTimeoutMs) {
      await client.query(`SET statement_timeout TO ${Math.floor(config.dbStatementTimeoutMs)};`);
    }
    if (config.dbIdleInTxTimeoutMs) {
      await client.query(`SET idle_in_transaction_session_timeout TO ${Math.floor(config.dbIdleInTxTimeoutMs)};`);
    }
    await client.query("SET search_path TO public;");
  } catch (err) {
    console.error("Error setting session parameters", err);
  }
});

// Handle errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

export default pool;
