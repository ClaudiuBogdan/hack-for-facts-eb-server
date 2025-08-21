import { Pool } from "pg";
import config from "../config";

// Create a dedicated pool for the user-generated data database
const userDataPool = new Pool({
  connectionString: config.userDataDatabaseUrl,
  max: config.userDataDbPoolMax ?? 20,
  idleTimeoutMillis: config.userDataDbPoolIdleMs ?? 30_000,
  connectionTimeoutMillis: config.userDataDbConnectionTimeoutMs ?? 10_000,
  ssl: config.userDataDbUseSSL ? { rejectUnauthorized: config.userDataDbRejectUnauthorizedSSL ?? false } : undefined,
  application_name: "hack-for-facts-eb-server:userdata",
});

// Set safe per-connection settings
userDataPool.on("connect", async (client) => {
  try {
    if (config.userDataDbStatementTimeoutMs) {
      await client.query(`SET statement_timeout TO ${Math.floor(config.userDataDbStatementTimeoutMs)};`);
    }
    if (config.userDataDbIdleInTxTimeoutMs) {
      await client.query(`SET idle_in_transaction_session_timeout TO ${Math.floor(config.userDataDbIdleInTxTimeoutMs)};`);
    }
    await client.query("SET search_path TO public;");
  } catch (err) {
    console.error("Error setting session parameters (user-data)", err);
  }
});

// Handle errors
userDataPool.on("error", (err) => {
  console.error("Unexpected error on idle client (user-data)", err);
  process.exit(-1);
});

export default userDataPool;


