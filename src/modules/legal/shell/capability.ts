/**
 * Legal module — semantic readiness probe (plan §9, Codex finding #2).
 *
 * The EFFECTIVE semantic gate is `kernel.searchCapabilities.forDomain('legal').semantic
 * AND hnswReady`. The kernel slot is the cross-source contract; this module ADDS a
 * cheap boot-time probe of the actual HNSW index so a missing/disabled index
 * degrades gracefully (lexical + caveat) instead of issuing 8s exact scans. It does
 * NOT mutate the kernel slot — it computes a local effective boolean the search
 * usecase consumes. If the probe errors, it returns `false` (degrade, never break).
 */

import { sql, type Kysely } from 'kysely';

import type { ProdDatabase } from '@/modules/shared/index.js';

type Db = Kysely<ProdDatabase>;

/**
 * True iff pgvector is present AND both legal HNSW indexes exist. Cheap
 * `to_regclass` lookups; runs once at module construction.
 */
export const probeLegalHnsw = async (db: Db): Promise<boolean> => {
  try {
    const row = await sql<{ ready: boolean }>`
      select (
        exists (select 1 from pg_extension where extname = 'vector')
        and to_regclass('legal.section_embeddings_article_v1_hnsw') is not null
        and to_regclass('legal.document_embeddings_general_v1_hnsw') is not null
      ) as ready
    `.execute(db);
    return row.rows[0]?.ready ?? false;
  } catch {
    return false;
  }
};
