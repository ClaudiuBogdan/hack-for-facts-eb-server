/**
 * App-layer reciprocal-rank fusion for the legal hybrid search.
 *
 * OpenSearch's native hybrid query cannot span TWO indexes (acts + sections)
 * nor fuse a BM25 leg with a kNN leg across them, so fusion happens here, in
 * pure code, over keys-only legs: each leg contributes documents in engine
 * rank order and the fused score for a key is Σ 1/(k + rank). Postgres
 * hydrates the winners afterwards — the engine never serves display data.
 *
 * `k` dampens the head advantage of any single leg; 60 is the literature
 * default and the Wave-2 shadow eval re-measures it (a fixture-pinned
 * constant, not a tuning knob to drift silently).
 */

export const RRF_K_DEFAULT = 60;

export interface FusionLeg<TKey extends string = string> {
  /** Which engine leg produced this ranking (diagnostic, carried to hits). */
  readonly leg: string;
  /** Keys in ENGINE RANK ORDER (best first). */
  readonly keys: readonly TKey[];
}

export interface FusedHit<TKey extends string = string> {
  readonly key: TKey;
  readonly score: number;
  /** Every leg that surfaced this key, with its 1-based rank there. */
  readonly sources: readonly { readonly leg: string; readonly rank: number }[];
}

/**
 * Fuse ranked legs. Deterministic: score descending, then key ascending —
 * two calls with the same legs always order identically (keyset paging over
 * a fused list needs a total order).
 *
 * Precondition: `k` is a positive module constant (`RRF_K_DEFAULT` or the
 * eval-measured replacement), never user input — call sites do not pass
 * request-derived values.
 */
export function rrfFuse<TKey extends string>(
  legs: readonly FusionLeg<TKey>[],
  k: number = RRF_K_DEFAULT
): FusedHit<TKey>[] {
  const scores = new Map<TKey, { score: number; sources: { leg: string; rank: number }[] }>();
  for (const leg of legs) {
    const seenInLeg = new Set<TKey>();
    for (const [index, key] of leg.keys.entries()) {
      // A key repeated WITHIN one leg keeps its best rank only — a leg that
      // lists a document twice must not double its contribution.
      if (seenInLeg.has(key)) continue;
      seenInLeg.add(key);
      const rank = index + 1;
      const entry = scores.get(key) ?? { score: 0, sources: [] };
      entry.score += 1 / (k + rank);
      entry.sources.push({ leg: leg.leg, rank });
      scores.set(key, entry);
    }
  }
  return [...scores.entries()]
    .map(([key, { score, sources }]) => ({ key, score, sources }))
    .sort((a, b) => {
      const byScore = b.score - a.score;
      return byScore !== 0 ? byScore : a.key.localeCompare(b.key);
    });
}
