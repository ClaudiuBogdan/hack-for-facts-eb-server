/**
 * Shared Kernel — OpenSearch client (foundation §4.6).
 *
 * Authenticated HTTP(S) health + terms aggregation for relevance/full-text rollups.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import { ok, err, fromThrowable, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '../../core/errors.js';

import type { OpenSearchAggBucket, OpenSearchClient } from '../../core/ports.js';

export interface OpenSearchClientConfig {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  /** Private CA bundle (PEM contents) for the node certificate. */
  readonly caCert?: string;
  /** TLS servername override when the URL host is not a certificate SAN. */
  readonly tlsServername?: string;
  readonly timeoutMs?: number;
}

const safeJsonParse = fromThrowable(JSON.parse as (text: string) => unknown);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const makeOpenSearchClient = (config: OpenSearchClientConfig): OpenSearchClient => {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const base = config.url === '' ? undefined : new URL(config.url);
  if (base !== undefined && base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('opensearch: URL protocol must be http or https');
  }
  if ((config.username === undefined) !== (config.password === undefined)) {
    throw new Error('opensearch: username and password must be set together');
  }
  if (
    base?.protocol !== 'https:' &&
    (config.caCert !== undefined || config.tlsServername !== undefined)
  ) {
    throw new Error('opensearch: CA and TLS servername require an https URL');
  }
  const auth =
    config.username !== undefined && config.password !== undefined
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
      : undefined;

  const request = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeout = timeoutMs
  ): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      if (base === undefined) {
        reject(new Error('OpenSearch is not configured'));
        return;
      }
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const options: RequestOptions = {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port === '' ? (base.protocol === 'https:' ? 443 : 80) : Number(base.port),
        path: `${base.pathname.replace(/\/$/, '')}${path}`,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined && {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
          ...(auth !== undefined && { Authorization: auth }),
        },
        timeout,
        ...(config.caCert !== undefined && { ca: config.caCert }),
        ...(config.tlsServername !== undefined && { servername: config.tlsServername }),
      };
      const transport = base.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = transport(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`timed out after ${String(timeout)}ms`));
      });
      req.end(payload);
    });

  return {
    async healthCheck(): Promise<Result<{ status: string }, ApiError>> {
      try {
        const resp = await request('GET', '/_cluster/health', undefined, 3000);
        if (resp.status !== 200) {
          return err(upstreamError(`opensearch health ${String(resp.status)}`, 'opensearch'));
        }
        const parsed = safeJsonParse(resp.text);
        if (
          parsed.isErr() ||
          !isRecord(parsed.value) ||
          typeof parsed.value['status'] !== 'string'
        ) {
          return err(upstreamError('opensearch health returned invalid JSON', 'opensearch'));
        }
        return ok({ status: parsed.value['status'] });
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
        const resp = await request('POST', `/${encodeURIComponent(index)}/_search`, body);
        if (resp.status !== 200) {
          // Status-only diagnostics: response bodies can contain indexed data.
          return err(upstreamError(`opensearch agg ${String(resp.status)}`, 'opensearch'));
        }
        const parsed = safeJsonParse(resp.text);
        if (parsed.isErr() || !isRecord(parsed.value)) {
          return err(upstreamError('opensearch agg returned invalid JSON', 'opensearch'));
        }
        const aggregations = parsed.value['aggregations'];
        const groups = isRecord(aggregations) ? aggregations['groups'] : undefined;
        const bucketsValue = isRecord(groups) ? groups['buckets'] : undefined;
        if (bucketsValue !== undefined && !Array.isArray(bucketsValue)) {
          return err(upstreamError('opensearch agg returned malformed buckets', 'opensearch'));
        }
        const buckets = Array.isArray(bucketsValue) ? bucketsValue : [];
        const normalized: OpenSearchAggBucket[] = [];
        for (const bucket of buckets) {
          if (!isRecord(bucket)) {
            return err(upstreamError('opensearch agg returned malformed bucket', 'opensearch'));
          }
          const key = bucket['key'];
          const docCount = bucket['doc_count'];
          const totalRonBlock = bucket['total_ron'];
          const totalRon = isRecord(totalRonBlock) ? totalRonBlock['value'] : undefined;
          if (typeof key !== 'string' || typeof docCount !== 'number') {
            return err(upstreamError('opensearch agg returned malformed bucket', 'opensearch'));
          }
          normalized.push({
            key,
            docCount,
            totalRon: typeof totalRon === 'number' ? totalRon : 0,
          });
        }
        return ok(normalized);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`opensearch agg failed: ${msg}`, 'opensearch', error));
      }
    },
  };
};
