/**
 * Shared Kernel — OpenSearch client (foundation §4.6).
 *
 * Native-fetch health + terms aggregation for relevance/full-text rollups.
 */

import { ok, err, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '../../core/errors.js';

import type { OpenSearchAggBucket, OpenSearchClient } from '../../core/ports.js';

export interface OpenSearchClientConfig {
  readonly url: string;
  readonly timeoutMs?: number;
}

export const makeOpenSearchClient = (config: OpenSearchClientConfig): OpenSearchClient => {
  const timeout = config.timeoutMs ?? 10_000;
  return {
    async healthCheck(): Promise<Result<{ status: string }, ApiError>> {
      try {
        const resp = await fetch(`${config.url}/_cluster/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok)
          return err(upstreamError(`opensearch health ${String(resp.status)}`, 'opensearch'));
        const data = (await resp.json()) as { status: string };
        return ok({ status: data.status });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`opensearch health failed: ${msg}`, 'opensearch', error));
      }
    },

    async termsAggregation(
      index: string,
      field: string,
      filters: Record<string, unknown>,
      size = 100
    ): Promise<Result<readonly OpenSearchAggBucket[], ApiError>> {
      try {
        const must = Object.entries(filters).map(([k, v]) => ({ term: { [k]: v } }));
        const body = {
          size: 0,
          query: must.length > 0 ? { bool: { must } } : { match_all: {} },
          aggs: {
            groups: {
              terms: { field, size },
              aggs: { total_ron: { sum: { field: 'amount_ron' } } },
            },
          },
        };
        const resp = await fetch(`${config.url}/${index}/_search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return err(upstreamError(`opensearch agg ${String(resp.status)}: ${text}`, 'opensearch'));
        }
        const data = (await resp.json()) as {
          aggregations?: {
            groups?: {
              buckets?: { key: string; doc_count: number; total_ron?: { value: number } }[];
            };
          };
        };
        const buckets = data.aggregations?.groups?.buckets ?? [];
        return ok(
          buckets.map((b) => ({
            key: b.key,
            docCount: b.doc_count,
            totalRon: b.total_ron?.value ?? 0,
          }))
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`opensearch agg failed: ${msg}`, 'opensearch', error));
      }
    },
  };
};
