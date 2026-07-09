/**
 * Budget repo — funding-source id translation (A1; ANAF_EXTRANET_REVIEW §A1).
 *
 * Prod mints `budget.funding_sources.source_id` as an arbitrary IDENTITY surrogate;
 * the STABLE public convention (phoenix's letter-code ordinal A=1..J=10) lives in
 * `source_code`. The `budget.v_funding_sources_compat` view re-derives the
 * conventional id (`row_number() over (order by source_code)`) and carries the
 * stored id as `internal_source_id`. This module caches that projection in-process
 * so the repo can translate stored↔public in O(1) per row:
 *
 *  - fact reads expose `fundingSourceId` as the PUBLIC (conventional) id — the
 *    stored `funding_source_id` column is remapped via `toPublicId`;
 *  - `fundingSourceIds` FILTERS arrive as PUBLIC ids and are remapped to the stored
 *    column value via `toStoredId` before they hit SQL (an unknown public id →
 *    `undefined` → the caller substitutes a no-match sentinel = empty-set semantics).
 *
 * The view is the single DB-level authority; this cache mirrors it (short TTL so a
 * new ANAF source self-heals without a process restart). Depends on the migration
 * being deployed — a documented cutover prerequisite (BUDGET_NOTES §A1).
 */

import { type ProdDatabase } from '@/modules/shared/index.js';

import type { Kysely } from 'kysely';

type Db = Kysely<ProdDatabase>;

/** The conventional id used for the unresolved case (matches the view's 0 row). */
export const FUNDING_SOURCE_UNKNOWN_ID = 0;

export interface FundingSourceCompatRow {
  readonly sourceId: number; // public (conventional) id
  readonly sourceCode: string | null;
  readonly sourceDescription: string | null;
  readonly internalSourceId: number; // stored identity id
}

export interface FundingSourceMap {
  /** All rows (incl. the 0=Unknown row), public-id ascending — for the dim list. */
  readonly rows: readonly FundingSourceCompatRow[];
  /** Stored identity id → public (conventional) id. Unknown stored → 0 (Unknown). */
  readonly toPublicId: (storedId: number) => number;
  /** Public (conventional) id → stored identity id. Unknown public → undefined. */
  readonly toStoredId: (publicId: number) => number | undefined;
}

const build = (rows: readonly FundingSourceCompatRow[]): FundingSourceMap => {
  const storedToPublic = new Map<number, number>();
  const publicToStored = new Map<number, number>();
  for (const r of rows) {
    storedToPublic.set(r.internalSourceId, r.sourceId);
    publicToStored.set(r.sourceId, r.internalSourceId);
  }
  return {
    rows,
    toPublicId: (storedId) => storedToPublic.get(storedId) ?? FUNDING_SOURCE_UNKNOWN_ID,
    toStoredId: (publicId) => publicToStored.get(publicId),
  };
};

/** Testable pure builder (used by unit tests with the 10-row prod fixture). */
export const buildFundingSourceMap = build;

export interface FundingSourceMapLoader {
  load(): Promise<FundingSourceMap>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export const makeFundingSourceMap = (db: Db, opts?: { ttlMs?: number }): FundingSourceMapLoader => {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { map: FundingSourceMap; at: number } | null = null;
  let inflight: Promise<FundingSourceMap> | null = null;

  const load = async (): Promise<FundingSourceMap> => {
    if (cached !== null && Date.now() - cached.at < ttlMs) return cached.map;
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const rows = await db
          .selectFrom('budget.v_funding_sources_compat')
          .select(['source_id', 'source_code', 'source_description', 'internal_source_id'])
          .orderBy('source_id', 'asc')
          .execute();
        const map = build(
          rows.map((r) => ({
            sourceId: r.source_id,
            sourceCode: r.source_code,
            sourceDescription: r.source_description,
            internalSourceId: r.internal_source_id,
          }))
        );
        cached = { map, at: Date.now() };
        return map;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return { load };
};
