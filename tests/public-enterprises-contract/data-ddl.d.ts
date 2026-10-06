// Compile-time boundary only. Runtime implementation comes from the scraper
// checkout through the test-only `@pe-data` alias (vitest.public-enterprises-contract.config.ts).
declare module '@pe-data/prod-migrations/20260629T160000__public_enterprises_v2_schema.js' {
  import type { Kysely } from 'kysely';
  export function up(db: Kysely<unknown>): Promise<void>;
}
declare module '@pe-data/prod-migrations/20260630T120000__public_enterprises_cutover.js' {
  import type { Kysely } from 'kysely';
  export function up(db: Kysely<unknown>): Promise<void>;
}
declare module '@pe-data/prod-migrations/20261006T180000__public_enterprises_public_read_views.js' {
  import type { Kysely } from 'kysely';
  export function up(db: Kysely<unknown>): Promise<void>;
}
declare module '@pe-data/extraction-kit/testing/pg-fixture.js' {
  import type { Kysely } from 'kysely';
  import type { Pool } from 'pg';
  export interface PgFixture {
    db: Kysely<unknown>;
    pool: Pool;
    connectionString: string;
    stop(): Promise<void>;
  }
  export function startPgFixture(options?: {
    context?: string;
    image?: string;
    poolMax?: number;
  }): Promise<PgFixture>;
}
