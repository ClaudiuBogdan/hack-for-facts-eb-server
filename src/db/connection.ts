import { Pool } from "pg";
import config from "../config";

// Create a pool instance
const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Handle errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

export default pool;
