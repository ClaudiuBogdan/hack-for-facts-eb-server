/**
 * Shared Kernel — Meilisearch client (foundation §4.6).
 *
 * Native-fetch single-index search over the palette `entities` index for
 * instant entity-name / identifier autocomplete. Failures — including a
 * missing/corrupt index — are `Upstream` errors so the global-search usecase
 * can degrade to pg.
 */

import { ok, err, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '../../core/errors.js';

import type { EntitiesSearchResult, MeiliClient } from '../../core/ports.js';
import type { SearchHit } from '../../core/types.js';

export interface MeiliClientConfig {
  readonly host: string;
  readonly apiKey: string;
}

/** Palette budget for the single-index `entities` search (tighter than the 5s default). */
const ENTITIES_SEARCH_TIMEOUT_MS = 1000;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Map one raw Meili hit to a `SearchHit`. Tolerates BOTH the palette `entities`
 * shape (docs carry `subtitle`, `doc_type`, and the entity projection fields)
 * and the retired per-source shape (docs carried `body`, no `doc_type`) —
 * the tolerance stays so a mispointed index degrades to partial hits rather
 * than throwing. Everything beyond the core contract is optional — missing
 * fields are simply omitted.
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
  // Palette docs carry `identifiers` (CUI + ONRC number + citations); legacy
  // docs carried `cuis`. Accept both, and derive `cuis` as the all-numeric
  // subset so the CUI-spine deep-link never receives a J-number or a citation.
  const identifiersRaw = h['identifiers'] ?? h['cuis'];
  const identifiers = Array.isArray(identifiersRaw)
    ? identifiersRaw.filter((v): v is string => typeof v === 'string')
    : undefined;
  const cuis = identifiers?.filter((v) => /^\d+$/u.test(v));
  const roles = Array.isArray(h['roles'])
    ? h['roles'].filter((r): r is string => typeof r === 'string')
    : undefined;
  const isActive = h['is_active'];

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
    ...(cuis !== undefined && { cuis }),
    ...(identifiers !== undefined && { identifiers }),
    ...(roles !== undefined && { roles }),
    ...(typeof isActive === 'boolean' && { isActive }),
  };
};

export const makeMeiliClient = (config: MeiliClientConfig): MeiliClient => {
  // `multiSearch`/`searchIndividually` (and the `timeoutMs` config) were
  // removed 2026-08-26 with the port entry — zero production callers after
  // the companies-repo re-point (D9). `searchEntities` keeps its own tight
  // 1s budget; the health check its 3s.
  return {
    async searchEntities(
      q: string,
      index: string,
      opts: { filter?: unknown; facets?: readonly string[]; limit: number; offset?: number }
    ): Promise<Result<EntitiesSearchResult, ApiError>> {
      try {
        // `filter` is the Meili ARRAY form from `buildEntitiesFilter` (an array
        // of allowlisted, JSON-quoted expression strings AND-ed together) — pass
        // it straight through. `showRankingScore` is required or `_rankingScore`
        // (→ `score`) is never returned. Highlighting is intentionally NOT
        // requested: nothing consumes `_formatted` yet (the client highlights
        // locally); add `attributesToHighlight` + map it when a consumer needs it.
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
        return err(
          upstreamError(`meilisearch entities request failed: ${msg}`, 'meilisearch', error)
        );
      }
    },

    async healthCheck(): Promise<Result<void, ApiError>> {
      try {
        const resp = await fetch(`${config.host}/health`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok)
          return err(upstreamError(`meili health ${String(resp.status)}`, 'meilisearch'));
        return ok(undefined);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`meili health failed: ${msg}`, 'meilisearch', error));
      }
    },
  };
};
