/**
 * Shared Kernel — Meilisearch client (foundation §4.6).
 *
 * Native-fetch multi-search for instant entity-name / prefix autocomplete.
 * Falls back to per-index search when an index is missing. Failures are
 * `Upstream` errors so the global-search usecase can degrade to pg.
 */

import { ok, err, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '../../core/errors.js';

import type { EntitiesSearchResult, MeiliClient, MeiliSearchResult } from '../../core/ports.js';
import type { SearchHit } from '../../core/types.js';

export interface MeiliClientConfig {
  readonly host: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

const mapHit = (h: Record<string, unknown>, indexUid: string): SearchHit => {
  const id = h['id'] ?? h['doc_id'] ?? '';
  const docType = h['doc_type'];
  const title = h['title'] ?? h['name'] ?? '';
  const body = h['body'];
  return {
    id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
    docType: typeof docType === 'string' ? docType : indexUid,
    title: typeof title === 'string' ? title : '',
    snippet: typeof body === 'string' ? body.slice(0, 200) : null,
    score: typeof h['_rankingScore'] === 'number' ? (h['_rankingScore']) : null,
    source: 'meili',
    attrs: h,
  };
};

export const makeMeiliClient = (config: MeiliClientConfig): MeiliClient => {
  const timeout = config.timeoutMs ?? 5000;

  const searchIndividually = async (
    q: string,
    indexes: readonly string[],
    limit: number
  ): Promise<readonly MeiliSearchResult[]> => {
    const results: MeiliSearchResult[] = [];
    for (const indexUid of indexes) {
      try {
        const resp = await fetch(`${config.host}/indexes/${indexUid}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ q, limit }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!resp.ok) {
          results.push({ index: indexUid, hits: [], totalHits: 0 });
          continue;
        }
        const data = (await resp.json()) as {
          hits: Record<string, unknown>[];
          estimatedTotalHits?: number;
        };
        results.push({
          index: indexUid,
          hits: data.hits.map((h) => mapHit(h, indexUid)),
          totalHits: data.estimatedTotalHits ?? data.hits.length,
        });
      } catch {
        results.push({ index: indexUid, hits: [], totalHits: 0 });
      }
    }
    return results;
  };

  return {
    async multiSearch(
      q: string,
      indexes: readonly string[],
      limit: number
    ): Promise<Result<readonly MeiliSearchResult[], ApiError>> {
      if (indexes.length === 0) return ok([]);
      try {
        const resp = await fetch(`${config.host}/multi-search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ queries: indexes.map((indexUid) => ({ indexUid, q, limit })) }),
          signal: AbortSignal.timeout(timeout),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          if (text.includes('index_not_found')) {
            return ok(await searchIndividually(q, indexes, limit));
          }
          return err(upstreamError(`meilisearch ${String(resp.status)}: ${text}`, 'meilisearch'));
        }

        const data = (await resp.json()) as {
          results: { indexUid: string; hits: Record<string, unknown>[]; estimatedTotalHits?: number }[];
        };
        return ok(
          data.results.map((r) => ({
            index: r.indexUid,
            hits: r.hits.map((h) => mapHit(h, r.indexUid)),
            totalHits: r.estimatedTotalHits ?? r.hits.length,
          }))
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`meilisearch request failed: ${msg}`, 'meilisearch', error));
      }
    },

    // TODO(T2): the real single-index `entities` search — POST
    // /indexes/<index>/search with the array `filter`, `facets`,
    // `showRankingScore:true`, and `attributesToHighlight`, mapping
    // facetDistribution + estimatedTotalHits. T1 lands the port signature; this
    // placeholder keeps the tree compiling until then.
    searchEntities(
      _q: string,
      _index: string,
      _opts: { filter?: unknown; facets?: readonly string[]; limit: number; offset?: number }
    ): Promise<Result<EntitiesSearchResult, ApiError>> {
      return Promise.resolve(ok({ hits: [], facetDistribution: {}, estimatedTotalHits: 0 }));
    },

    async healthCheck(): Promise<Result<void, ApiError>> {
      try {
        const resp = await fetch(`${config.host}/health`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) return err(upstreamError(`meili health ${String(resp.status)}`, 'meilisearch'));
        return ok(undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`meili health failed: ${msg}`, 'meilisearch', error));
      }
    },
  };
};
