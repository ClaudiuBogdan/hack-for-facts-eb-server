import pool from "./connection";
import * as fs from "fs-extra";
import path from "path";

/**
 * Initializes the database by dropping existing tables and creating new ones based on schema.sql
 */
async function setupDatabase() {
  try {
    console.log("Starting database setup...");

    // Read schema SQL from file
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf8");

    // Connect to database
    const client = await pool.connect();

    try {
      console.log("Connected to database");

      // Drop existing tables in reverse order to avoid foreign key constraints
      console.log("Dropping existing tables...");
      await client.query(`
        DROP TABLE IF EXISTS UATs CASCADE;
        DROP TABLE IF EXISTS ExecutionLineItems CASCADE;
        DROP TABLE IF EXISTS Reports CASCADE;
        DROP TABLE IF EXISTS FundingSources CASCADE;
        DROP TABLE IF EXISTS EconomicClassifications CASCADE;
        DROP TABLE IF EXISTS FunctionalClassifications CASCADE;
        DROP TABLE IF EXISTS Entities CASCADE;
      `);

      // Execute schema SQL
      console.log("Creating new schema...");
      await client.query(schemaSql);

      console.log("Database setup completed successfully!");
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error setting up database:", error);
    process.exit(1);
  }
}

// Run the setup function if this file is executed directly
if (require.main === module) {
  setupDatabase()
    .then(() => {
      console.log("Database initialization complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Failed to initialize database:", error);
      process.exit(1);
    });
}

export { setupDatabase };
