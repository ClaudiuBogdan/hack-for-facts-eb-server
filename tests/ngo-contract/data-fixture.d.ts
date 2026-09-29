// Compile-time boundary only. Runtime implementation comes from the pinned scraper checkout.
declare module '@ngo-data/rnong-keyed-reads.fixture.js' {
  import type { PoolClient, Pool } from 'pg';
  export interface PgFixture {
    connectionString: string;
    pool: Pool;
    stop(): Promise<void>;
  }
  export function startNgoKeyedFixture(): Promise<{ fixture: PgFixture; client: PoolClient }>;
}
