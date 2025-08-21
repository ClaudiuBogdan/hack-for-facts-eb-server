import userDataPool from "./connectionUserData";
import * as fs from "fs-extra";
import path from "path";

/**
 * Initializes the user-data database schema based on schema-userdata.sql
 */
async function setupUserDataDatabase() {
  try {
    console.log("Starting user-data database setup...");

    const schemaPath = path.join(__dirname, "schema-userdata.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf8");

    const client = await userDataPool.connect();
    try {
      console.log("Connected to user-data database");
      await client.query("BEGIN");
      await client.query(schemaSql);
      await client.query("COMMIT");
      console.log("User-data database setup completed successfully!");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error setting up user-data database:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  setupUserDataDatabase()
    .then(() => {
      console.log("User-data database initialization complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Failed to initialize user-data database:", error);
      process.exit(1);
    });
}

export { setupUserDataDatabase };


