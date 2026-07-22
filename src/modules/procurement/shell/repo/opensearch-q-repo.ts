/**
 * Procurement module — OpenSearch `q` resolver (DEV integration).
 *
 * Resolves the free-text `q` facet into a bounded primary-key id-set against
 * the procurement OpenSearch indices (Romanian analyzer: folded diacritics,
 * stemming, fuzziness) instead of the SQL ILIKE predicate. The SQL layer
 * remains the source of truth for every structured filter, the total-order
 * sort, and the capped count — OpenSearch only replaces the text predicate.
 *
 * Degradation contract: any failure (unconfigured grain, engine down,
 * structurally invalid response, foreign document ids) returns `err`; the
 * caller falls back to the ILIKE predicate and logs the category. A capped
 * id-set is disclosed via `truncated` — the caller must degrade the count
 * to estimated (the set is a relevance-biased subset).
 *
 * TLS: the chronos node presents a private-CA cert whose SANs are the
 * cluster service DNS names. Over a localhost port-forward, pass `caCert`
 * plus `tlsServername` (one of the cert SANs) — full verification, no
 * insecure bypass. Document ids are the pk prefixed with a grain letter
 * (`p123` / `c123` / `d123`) — see scrapper prod-db/os-prototype/.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '@/modules/shared/index.js';

import type { SearchGrain } from '../../core/search.js';

export interface OpenSearchQConfig {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  /** Private CA bundle (PEM contents) for the node certificate. */
  readonly caCert?: string;
  /** TLS servername override when the URL host is not a cert SAN (port-forward). */
  readonly tlsServername?: string;
  /** Per-grain index names; a grain without an index is not OS-resolvable. */
  readonly indexes: Partial<Record<SearchGrain, string>>;
  readonly timeoutMs?: number;
  /** Bounded id-set size. Mirrors SEARCH_WINDOW_MAX — deeper hits are unreachable anyway. */
  readonly idCap?: number;
}

export interface OpenSearchQResolution {
  /** Numeric pks (grain prefix stripped), BM25-ordered, bounded by `idCap`. */
  readonly ids: readonly number[];
  /** True when the id-set hit the cap — the set is a relevance-truncated subset. */
  readonly truncated: boolean;
}

export interface OpenSearchQResolver {
  /** Which grains this resolver can serve (has an index configured). */
  canResolve(grain: SearchGrain): boolean;
  resolveIds(grain: SearchGrain, q: string): Promise<Result<OpenSearchQResolution, ApiError>>;
}

/** The v0 BM25 field set — mirrors the scrapper os-prototype smoke queries. */
const Q_FIELDS = [
  'title^3',
  'title.folded^3',
  'authority_name',
  'authority_name.folded',
  'supplier_name',
  'supplier_name.folded',
] as const;

/** Document-id prefix per grain — a foreign prefix means a mis-wired index. */
const ID_PREFIX: Readonly<Partial<Record<SearchGrain, string>>> = {
  procedures: 'p',
  contracts: 'c',
  direct_acquisitions: 'd',
};

const DEFAULT_ID_CAP = 10_000;

const safeJsonParse = fromThrowable(JSON.parse as (text: string) => unknown);

/**
 * Extract and validate the hit ids without declaring the engine's `_id`
 * property in a type. Returns null on any structural corruption (missing
 * hits array, non-string id, foreign grain prefix, non-integer remainder).
 */
const extractIds = (payload: unknown, prefix: string): number[] | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const hitsBlock = (payload as Record<string, unknown>)['hits'];
  // filter_path elides empty parents: a valid zero-hit response is `{}`.
  if (hitsBlock === undefined) return [];
  if (typeof hitsBlock !== 'object' || hitsBlock === null) return null;
  const hits = (hitsBlock as Record<string, unknown>)['hits'];
  if (hits === undefined) return [];
  if (!Array.isArray(hits)) return null;
  const ids: number[] = [];
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) return null;
    const id = (hit as Record<string, unknown>)['_id'];
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const n = Number(id.slice(prefix.length));
    if (!Number.isSafeInteger(n)) return null;
    ids.push(n);
  }
  return ids;
};

export const makeOpenSearchQResolver = (config: OpenSearchQConfig): OpenSearchQResolver => {
  const timeoutMs = config.timeoutMs ?? 5_000;
  const idCap = config.idCap ?? DEFAULT_ID_CAP;
  const base = new URL(config.url);
  if ((config.username === undefined) !== (config.password === undefined)) {
    throw new Error('opensearch q resolver: username and password must be set together');
  }
  const auth =
    config.username !== undefined && config.password !== undefined
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
      : undefined;

  const post = (path: string, body: unknown): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const options: RequestOptions = {
        hostname: base.hostname,
        port: base.port === '' ? 443 : Number(base.port),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
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

  return {
    canResolve: (grain) => config.indexes[grain] !== undefined && ID_PREFIX[grain] !== undefined,

    async resolveIds(
      grain: SearchGrain,
      q: string
    ): Promise<Result<OpenSearchQResolution, ApiError>> {
      const index = config.indexes[grain];
      const prefix = ID_PREFIX[grain];
      if (index === undefined || prefix === undefined) {
        return err(upstreamError(`opensearch q: no index for grain ${grain}`, 'opensearch'));
      }
      const body = {
        size: idCap,
        _source: false,
        track_total_hits: false,
        query: {
          multi_match: {
            query: q,
            fields: Q_FIELDS,
            type: 'best_fields',
            fuzziness: 'AUTO',
            prefix_length: 1,
            max_expansions: 50,
          },
        },
      };
      try {
        const resp = await post(`/${index}/_search?filter_path=hits.hits._id`, body);
        // Status-only diagnostics: response bodies can echo the query text
        // and must never reach logs.
        if (resp.status !== 200) {
          return err(upstreamError(`opensearch q: http ${String(resp.status)}`, 'opensearch'));
        }
        const parsed = safeJsonParse(resp.text);
        if (parsed.isErr()) {
          return err(upstreamError('opensearch q: invalid json response', 'opensearch'));
        }
        const ids = extractIds(parsed.value, prefix);
        if (ids === null) {
          return err(upstreamError('opensearch q: malformed hits payload', 'opensearch'));
        }
        return ok({ ids, truncated: ids.length >= idCap });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        return err(upstreamError(`opensearch q: transport failed: ${msg}`, 'opensearch', error));
      }
    },
  };
};
