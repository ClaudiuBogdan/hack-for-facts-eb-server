import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { getPool, type DataDomain } from ".";

export async function runQuery<T extends QueryResultRow = any>(
  domain: DataDomain,
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool: Pool = getPool(domain);
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  domain: DataDomain,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool: Pool = getPool(domain);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}


