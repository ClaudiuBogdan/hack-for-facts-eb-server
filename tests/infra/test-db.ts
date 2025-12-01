import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { createConfig } from '../../src/infra/config/env.js';
import { initDatabases, type DatabaseClients } from '../../src/infra/database/client.js';
import { seedDatabase } from '../../src/infra/database/seeds/index.js';

let container: StartedPostgreSqlContainer;
let clients: DatabaseClients;
let isSetup = false;

export async function setupTestDatabase() {
  // Singleton pattern: only setup once
  if (isSetup) {
    console.log('Database already setup, reusing existing container');
    return clients;
  }

  // Start container
  console.log('Starting Postgres Container...');
  // Default postgres image is usually fine, but we can specify if needed.
  // version 15/16 is good.
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const connectionString = container.getConnectionUri();

  // Set env vars for the app to use
  process.env['DATABASE_URL'] = connectionString;
  process.env['BUDGET_DATABASE_URL'] = connectionString;
  process.env['USER_DATABASE_URL'] = connectionString;

  // Init clients
  const config = createConfig(process.env as any);
  clients = initDatabases(config);

  // Apply Schema using raw pg client for multi-statement SQL
  // We assume the user is superuser (default in testcontainers) so extension creation works.
  console.log('Applying budget schema...');
  const BudgetSchema = fs.readFileSync(
    path.join(process.cwd(), 'src/infra/database/budget/schema.sql'),
    'utf-8'
  );
  const UserSchema = fs.readFileSync(
    path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
    'utf-8'
  );

  // Use raw pg client for schema application to support multi-statement SQL
  console.log('Creating pg client for schema application...');
  const pgClient = new pg.Client({ connectionString });

  try {
    console.log('Connecting to database...');
    await pgClient.connect();
    console.log('Connected! Executing budget schema...');

    await pgClient.query(BudgetSchema);
    console.log('Budget schema executed successfully');

    // Verify tables were created
    const tableCheck = await pgClient.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'functionalclassifications'`
    );
    console.log('FunctionalClassifications table exists:', tableCheck.rows.length > 0);

    console.log('Executing user schema...');
    await pgClient.query(UserSchema);
    console.log('User schema applied successfully');
  } catch (error) {
    console.error('Error applying schemas:', error);
    throw error;
  } finally {
    await pgClient.end();
    console.log('Schema client connection closed');
  }

  // Seed Data
  const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
  if (fs.existsSync(seedDir)) {
    const files = fs.readdirSync(seedDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      console.log(`Seeding ${file}...`);
      await seedDatabase(clients.budgetDb, path.join(seedDir, file));
    }
  }

  isSetup = true;
  return clients;
}

export async function teardownTestDatabase() {
  if (!isSetup) {
    console.log('Database was not setup, skipping teardown');
    return;
  }

  try {
    if (clients?.budgetDb !== undefined) {
      await clients.budgetDb.destroy();
    }
  } catch (error) {
    console.error('Error destroying budget db client:', error);
  }

  try {
    if (clients?.userDb !== undefined) {
      await clients.userDb.destroy();
    }
  } catch (error) {
    console.error('Error destroying user db client:', error);
  }

  try {
    if (container !== undefined) {
      await container.stop();
      console.log('Container stopped successfully');
    }
  } catch (error) {
    console.error('Error stopping container:', error);
  }

  isSetup = false;
}

export function getTestClients() {
  return clients;
}
