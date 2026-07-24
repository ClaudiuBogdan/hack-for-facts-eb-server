/**
 * Procurement module — the OpenSearch list engine (transport + parsing).
 *
 * OpenSearch is the record-list engine for the three indexed grains: it owns
 * the filters, the total order, the page window, the count and the result-set
 * facets, and returns ORDERED primary keys. Postgres then hydrates only the
 * ≤100 rows of that page — so every value the client renders still comes from
 * the production database, while membership and order come from the index.
 *
 * The query itself is compiled in `core/opensearch-query.ts` (pure, tested).
 * This module is I/O only: transport, status handling, defensive parsing.
 *
 * Degradation contract: any failure returns `err`. The caller may fall back to
 * the SQL path when the filter is SQL-capable, and MUST surface an error when
 * it is not (geography and the CPV mid-levels exist only in the index) — a
 * silent unfiltered fallback would answer a different question than the one
 * asked.
 *
 * TLS: the chronos node presents a private-CA cert whose SANs are the cluster
 * service DNS names. Over a localhost port-forward, pass `caCert` plus
 * `tlsServername` (one of those SANs) — full verification, no insecure bypass.
 * Document ids are the pk prefixed with a grain letter (`p123`/`c123`/`d123`).
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '@/modules/shared/index.js';

import { compileListQuery } from '../../core/opensearch-query.js';

import type { ProcurementSearchFilter, SearchGrain } from '../../core/search.js';
import type { OffsetSearchRequest, SearchFacet } from '../../core/types.js';

export interface OpenSearchListConfig {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  /** Private CA bundle (PEM contents) for the node certificate. */
  readonly caCert?: string;
  /** TLS servername override when the URL host is not a cert SAN (port-forward). */
  readonly tlsServername?: string;
  /** Per-grain index names; a grain without an index is not engine-servable. */
  readonly indexes: Partial<Record<SearchGrain, string>>;
  readonly timeoutMs?: number;
  /** `true` = always-exact totals; a number caps the exact range (`gte` beyond). */
  readonly trackTotalHits?: boolean | number;
}

export interface OpenSearchListPage {
  /** Primary keys in engine sort order — the page, already windowed. */
  readonly pks: readonly number[];
  readonly total: number;
  /** False when the engine capped the count and reported a lower bound. */
  readonly totalExhaustive: boolean;
  readonly facets: readonly SearchFacet[];
  /** Index build stamp (`_meta.built_at`) — an index without one is refused. */
  readonly asOf: string;
}

export interface OpenSearchListEngine {
  /** Which grains this engine can serve (has an index configured). */
  canServe(grain: SearchGrain): boolean;
  search(
    grain: SearchGrain,
    filter: ProcurementSearchFilter,
    page: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OpenSearchListPage, ApiError>>;
}

/** Document-id prefix per grain — a foreign prefix means a mis-wired index. */
const ID_PREFIX: Readonly<Partial<Record<SearchGrain, string>>> = {
  procedures: 'p',
  contracts: 'c',
  direct_acquisitions: 'd',
};

const META_TTL_MS = 5 * 60_000;

const safeJsonParse = fromThrowable(JSON.parse as (text: string) => unknown);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

interface ParsedHits {
  readonly pks: number[];
  readonly total: number;
  readonly totalExhaustive: boolean;
}

/**
 * A search that timed out, terminated early, or lost a shard still answers
 * HTTP 200 with whatever it gathered — and reports `relation: "eq"` on a count
 * taken over the shards that DID answer. Serving that as an exact total and a
 * complete page is the worst failure this surface can have, so an incomplete
 * response is rejected outright (the request also asks the engine not to
 * produce one: `allow_partial_search_results=false`).
 */
const isCompleteResponse = (payload: Record<string, unknown>): boolean => {
  if (payload['timed_out'] === true) return false;
  if (payload['terminated_early'] === true) return false;
  const shards = asRecord(payload['_shards']);
  if (shards === null) return false;
  const { total, successful, failed, skipped } = shards;
  if (typeof total !== 'number' || typeof successful !== 'number') return false;
  if (typeof failed === 'number' && failed > 0) return false;
  const answered = successful + (typeof skipped === 'number' ? skipped : 0);
  return answered >= total;
};

/**
 * Parse `hits` without declaring the engine's wire types. Returns null on any
 * structural surprise — a partially-understood response must not be served as
 * a page.
 */
const parseHits = (payload: Record<string, unknown>, prefix: string): ParsedHits | null => {
  const hitsBlock = asRecord(payload['hits']);
  if (hitsBlock === null) return null;
  const totalBlock = asRecord(hitsBlock['total']);
  if (totalBlock === null) return null;
  const total = totalBlock['value'];
  const relation = totalBlock['relation'];
  if (typeof total !== 'number' || !Number.isInteger(total)) return null;
  if (relation !== 'eq' && relation !== 'gte') return null;

  const hits = hitsBlock['hits'];
  if (!Array.isArray(hits)) return null;
  const pks: number[] = [];
  for (const hit of hits) {
    const record = asRecord(hit);
    if (record === null) return null;
    const id = record['_id'];
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const pk = Number(id.slice(prefix.length));
    if (!Number.isSafeInteger(pk)) return null;
    pks.push(pk);
  }
  return { pks, total, totalExhaustive: relation === 'eq' };
};

/**
 * Parse the terms aggregations — ALL of them or none. Skipping a malformed
 * bucket, or defaulting a missing `sum_other_doc_count` to zero, would drop
 * records out of a distribution the reader is told is complete. Returns null
 * on any structural surprise; the caller then serves the page without facets
 * rather than with a wrong one.
 */
const parseFacets = (
  payload: Record<string, unknown>,
  dims: readonly string[]
): SearchFacet[] | null => {
  if (dims.length === 0) return [];
  const aggs = asRecord(payload['aggregations']);
  if (aggs === null) return null;
  const facets: SearchFacet[] = [];
  for (const dimension of dims) {
    const agg = asRecord(aggs[dimension]);
    if (agg === null) return null;
    const rawBuckets = agg['buckets'];
    if (!Array.isArray(rawBuckets)) return null;
    const buckets: { key: string; count: number }[] = [];
    for (const raw of rawBuckets) {
      const bucket = asRecord(raw);
      if (bucket === null) return null;
      const key = bucket['key'];
      const count = bucket['doc_count'];
      if (typeof key !== 'string' || typeof count !== 'number') return null;
      buckets.push({ key, count });
    }
    const other = agg['sum_other_doc_count'];
    if (typeof other !== 'number') return null;
    facets.push({ dimension, buckets, otherCount: other });
  }
  return facets;
};

export const makeOpenSearchListEngine = (config: OpenSearchListConfig): OpenSearchListEngine => {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const base = new URL(config.url);
  if ((config.username === undefined) !== (config.password === undefined)) {
    throw new Error('opensearch list engine: username and password must be set together');
  }
  const auth =
    config.username !== undefined && config.password !== undefined
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
      : undefined;

  const send = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const options: RequestOptions = {
        hostname: base.hostname,
        port: base.port === '' ? 443 : Number(base.port),
        path,
        method,
        headers: {
          ...(payload !== undefined && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          ...(auth !== undefined && { Authorization: auth }),
        },
        timeout: timeoutMs,
        ...(config.caCert !== undefined && { ca: config.caCert }),
        ...(config.tlsServername !== undefined && { servername: config.tlsServername }),
      };
      const req = httpsRequest(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`timed out after ${String(timeoutMs)}ms`));
      });
      req.end(payload);
    });

  /**
   * Index build provenance, cached. `verify-parity.sh` stamps `_meta.built_at`
   * only after an index passes its gates, so a missing stamp means the index
   * was never gated — and an ungated index must not serve a list that would
   * read as live. Cached for five minutes; a read failure is treated as
   * missing (fail closed).
   */
  const metaCache = new Map<string, { value: string | null; expiresAt: number }>();
  const readAsOf = async (index: string): Promise<string | null> => {
    const cached = metaCache.get(index);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    let value: string | null = null;
    try {
      const resp = await send('GET', `/${index}/_mapping`);
      if (resp.status === 200) {
        const parsed = safeJsonParse(resp.text);
        if (parsed.isOk()) {
          const root = asRecord(parsed.value);
          const indexBlock = root === null ? null : asRecord(root[index]);
          const mappings = indexBlock === null ? null : asRecord(indexBlock['mappings']);
          const meta = mappings === null ? null : asRecord(mappings['_meta']);
          const builtAt = meta?.['built_at'];
          if (typeof builtAt === 'string') value = builtAt;
        }
      }
    } catch {
      value = null;
    }
    metaCache.set(index, { value, expiresAt: Date.now() + META_TTL_MS });
    return value;
  };

  return {
    canServe: (grain) => config.indexes[grain] !== undefined && ID_PREFIX[grain] !== undefined,

    async search(grain, filter, page, facets = []) {
      const index = config.indexes[grain];
      const prefix = ID_PREFIX[grain];
      if (index === undefined || prefix === undefined) {
        return err(upstreamError(`opensearch list: no index for grain ${grain}`, 'opensearch'));
      }
      const compiled = compileListQuery({
        grain,
        filter,
        page,
        facets,
        ...(config.trackTotalHits !== undefined && { trackTotalHits: config.trackTotalHits }),
      });
      try {
        const resp = await send(
          'POST',
          `/${index}/_search?allow_partial_search_results=false`,
          compiled.body
        );
        // Status-only diagnostics: response bodies echo the query text and must
        // never reach the logs.
        if (resp.status !== 200) {
          return err(upstreamError(`opensearch list: http ${String(resp.status)}`, 'opensearch'));
        }
        const parsed = safeJsonParse(resp.text);
        if (parsed.isErr()) {
          return err(upstreamError('opensearch list: invalid json response', 'opensearch'));
        }
        const payload = asRecord(parsed.value);
        if (payload === null) {
          return err(upstreamError('opensearch list: malformed response', 'opensearch'));
        }
        if (!isCompleteResponse(payload)) {
          return err(upstreamError('opensearch list: incomplete search response', 'opensearch'));
        }
        const hits = parseHits(payload, prefix);
        if (hits === null) {
          return err(upstreamError('opensearch list: malformed hits payload', 'opensearch'));
        }
        // A wrong distribution is worse than none: an unparseable facet block
        // serves the page WITHOUT facets rather than with a partial one.
        const facets = parseFacets(payload, compiled.facetDims);
        const asOf = await readAsOf(index);
        if (asOf === null) {
          // An index with no build stamp cannot be dated, and an undated list
          // silently reads as live. Refuse it — the caller degrades to SQL for
          // SQL-serveable filters and fails explicitly for the rest.
          return err(
            upstreamError('opensearch list: index carries no build stamp', 'opensearch')
          );
        }
        return ok({
          pks: hits.pks,
          total: hits.total,
          totalExhaustive: hits.totalExhaustive,
          facets: facets ?? [],
          asOf,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`opensearch list: transport failed: ${msg}`, 'opensearch', error));
      }
    },
  };
};
