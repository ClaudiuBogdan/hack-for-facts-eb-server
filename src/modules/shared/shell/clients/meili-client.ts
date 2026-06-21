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

/** Palette budget for the single-index `entities` search (tighter than the 5s default). */
const ENTITIES_SEARCH_TIMEOUT_MS = 1000;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Map one raw Meili hit to a `SearchHit`. Serves BOTH the legacy `multiSearch`
 * path (docs carry `body`, no `doc_type`) and the `entities` path (docs carry
 * `subtitle`, `doc_type`, and the entity projection fields). Everything beyond
 * the core contract is optional — missing fields are simply omitted.
 */
const mapHit = (h: Record<string, unknown>, indexUid: string): SearchHit => {
  const id = h['id'] ?? h['doc_id'] ?? '';
  const docType = h['doc_type'];
  const title = h['title'] ?? h['name'] ?? '';
  const body = asString(h['body']);
  const subtitle = asString(h['subtitle']);
  const docId = asString(h['doc_id']);
  const docKey = asString(h['doc_key']);
  const countyName = asString(h['county_name']);
  const url = asString(h['url']);
  const rankBoost = h['rank_boost'];
  const cuis = h['cuis'];
  const year = h['year'];

  return {
    id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
    docType: typeof docType === 'string' ? docType : indexUid,
    title: typeof title === 'string' ? title : '',
    // entities docs have `subtitle`; legacy docs have `body` — prefer the former.
    snippet: subtitle ?? (body !== undefined ? body.slice(0, 200) : null),
    score: typeof h['_rankingScore'] === 'number' ? h['_rankingScore'] : null,
    source: 'meili',
    attrs: h,
    ...(docId !== undefined && { docId }),
    ...(docKey !== undefined && { docKey }),
    ...(subtitle !== undefined && { subtitle }),
    ...(countyName !== undefined && { countyName }),
    ...(url !== undefined && { url }),
    ...(typeof rankBoost === 'number' && { rankBoost }),
    ...(Array.isArray(cuis) && {
      cuis: cuis.filter((c): c is string => typeof c === 'string'),
    }),
    ...(typeof year === 'number' && { year }),
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

    async searchEntities(
      q: string,
      index: string,
      opts: { filter?: unknown; facets?: readonly string[]; limit: number; offset?: number }
    ): Promise<Result<EntitiesSearchResult, ApiError>> {
      try {
        // `filter` is the structured ARRAY form from `buildEntitiesFilter`
        // (`['AND', [field, op, value], …]`) — pass it straight through; Meili
        // parameterizes the tokens, so there is no string-injection surface.
        const resp = await fetch(`${config.host}/indexes/${index}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            q,
            limit: opts.limit,
            ...(opts.offset !== undefined && { offset: opts.offset }),
            ...(opts.filter !== undefined && { filter: opts.filter }),
            ...(opts.facets !== undefined && { facets: opts.facets }),
            showRankingScore: true,
            attributesToHighlight: ['title', 'subtitle'],
          }),
          signal: AbortSignal.timeout(ENTITIES_SEARCH_TIMEOUT_MS),
        });

        // Surface a non-OK response (INCLUDING `index_not_found`) as an error so
        // the usecase degrades to Postgres — never an `ok` with empty hits (that
        // is the silent-no-fallback bug the legacy multiSearch had).
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return err(
            upstreamError(`meilisearch entities ${String(resp.status)}: ${text}`, 'meilisearch')
          );
        }

        const data = (await resp.json()) as {
          hits: Record<string, unknown>[];
          facetDistribution?: Record<string, Record<string, number>>;
          estimatedTotalHits?: number;
        };
        return ok({
          hits: data.hits.map((h) => mapHit(h, index)),
          facetDistribution: data.facetDistribution ?? {},
          estimatedTotalHits: data.estimatedTotalHits ?? data.hits.length,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`meilisearch entities request failed: ${msg}`, 'meilisearch', error));
      }
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
