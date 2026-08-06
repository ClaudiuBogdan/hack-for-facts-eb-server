/**
 * Legal module — the OpenSearch search engine (transport + parsing).
 *
 * OpenSearch is legal's SINGLE search engine (user decision, 2026-08-04): two
 * indexes behind aliases (`legal-acts` / `legal-sections`), keys-only results,
 * Postgres hydrates every value the reader sees. The request bodies are
 * compiled in `core/legal-opensearch-query.ts` (pure, tested); this module is
 * I/O only — transport, status handling, defensive parsing.
 *
 * Degradation contract (plan §4): every failure here returns `err`. The caller
 * MUST NOT substitute a lexical SQL scan for a failed engine call — a silent
 * unfiltered fallback answers a different question than the one asked, and
 * that exact substitution already burned this platform once.
 *
 * TLS: the chronos node presents a private-CA cert whose SANs are the cluster
 * service DNS names. Over a localhost port-forward, pass `caCert` plus
 * `tlsServername` (one of those SANs) — full verification, no insecure bypass.
 *
 * The transport is injectable so the parsing and the refusal gates — the part
 * that decides whether an answer is servable — are testable without a live
 * cluster. Production always gets the https sender built below.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '@/modules/shared/index.js';

import {
  ACTS_HIGHLIGHT_FIELDS,
  SECTIONS_HIGHLIGHT_FIELDS,
  buildActsBm25Body,
  buildSectionsBm25Body,
  buildSectionsKnnBody,
} from '../../core/legal-opensearch-query.js';

import type { LegalEngineHit, LegalEnginePage, LegalSearchEngine } from '../../core/ports.js';

export interface LegalEngineConfig {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  /** Private CA bundle (PEM contents) for the node certificate. */
  readonly caCert?: string;
  /** TLS servername override when the URL host is not a cert SAN (port-forward). */
  readonly tlsServername?: string;
  /**
   * Alias names. An index that is NOT configured makes its leg unservable and
   * is reported as such — never quietly dropped from a fusion.
   */
  readonly actsIndex?: string;
  readonly sectionsIndex?: string;
  readonly timeoutMs?: number;
}

/** The seam: `(method, path, body) => response`. Injected in tests. */
export type LegalEngineTransport = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
) => Promise<{ status: number; text: string }>;

const META_TTL_MS = 5 * 60_000;

const safeJsonParse = fromThrowable(JSON.parse as (text: string) => unknown);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

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
 * First fragment per highlighted field, BASE analyzer before `.folded`. Both
 * return the original text; asking only the folded twin loses marks on
 * diacritic-less queries (procurement's measured lesson). Highlighting is
 * presentational, so an unreadable block costs emphasis, not correctness.
 */
const parseSnippet = (raw: unknown, fields: readonly string[]): string | null => {
  const block = asRecord(raw);
  if (block === null) return null;
  for (const field of fields) {
    for (const name of [field, `${field}.folded`]) {
      const fragments: unknown = block[name];
      if (!Array.isArray(fragments)) continue;
      const first: unknown = fragments[0];
      if (typeof first === 'string' && first !== '') return first;
    }
  }
  return null;
};

/** `act_id` is a bigint in Postgres; the index may carry it as number or string. */
const asId = (value: unknown): string | null => {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
};

interface ParsedHits {
  readonly hits: LegalEngineHit[];
  readonly total: number;
  readonly totalExhaustive: boolean;
}

/**
 * Parse `hits` without declaring the engine's wire types. Returns null on any
 * structural surprise — a partially-understood response must not be served as
 * a page. `document_id` is mandatory on every hit: it is the hydration key,
 * and a hit we cannot hydrate is a hit we cannot honestly show.
 */
const parseHits = (
  payload: Record<string, unknown>,
  highlightFields: readonly string[]
): ParsedHits | null => {
  const hitsBlock = asRecord(payload['hits']);
  if (hitsBlock === null) return null;
  const totalBlock = asRecord(hitsBlock['total']);
  if (totalBlock === null) return null;
  const total = totalBlock['value'];
  const relation = totalBlock['relation'];
  if (typeof total !== 'number' || !Number.isInteger(total)) return null;
  if (relation !== 'eq' && relation !== 'gte') return null;

  const rawHits = hitsBlock['hits'];
  if (!Array.isArray(rawHits)) return null;
  const hits: LegalEngineHit[] = [];
  for (const raw of rawHits) {
    const record = asRecord(raw);
    if (record === null) return null;
    const source = asRecord(record['_source']);
    if (source === null) return null;
    const documentId = source['document_id'];
    if (typeof documentId !== 'string' || documentId === '') return null;
    const sectionKey = source['section_key'];
    if (sectionKey !== undefined && typeof sectionKey !== 'string') return null;
    hits.push({
      documentId,
      actId: asId(source['act_id']),
      sectionKey: typeof sectionKey === 'string' ? sectionKey : null,
      snippet: parseSnippet(record['highlight'], highlightFields),
    });
  }
  return { hits, total, totalExhaustive: relation === 'eq' };
};

export const makeLegalSearchEngine = (
  config: LegalEngineConfig,
  injectedTransport?: LegalEngineTransport
): LegalSearchEngine => {
  const timeoutMs = config.timeoutMs ?? 10_000;
  if ((config.username === undefined) !== (config.password === undefined)) {
    throw new Error('legal search engine: username and password must be set together');
  }
  const auth =
    config.username !== undefined && config.password !== undefined
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
      : undefined;

  const httpsTransport: LegalEngineTransport = (method, path, body) =>
    new Promise((resolve, reject) => {
      const base = new URL(config.url);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const options: RequestOptions = {
        hostname: base.hostname,
        port: base.port === '' ? 443 : Number(base.port),
        path,
        method,
        headers: {
          Accept: 'application/json',
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

  const send = injectedTransport ?? httpsTransport;

  /**
   * Index build provenance, cached. The exporter stamps `_meta.built_at` only
   * after an index passes its reconcile gates, so a missing stamp means the
   * index was never gated — and an ungated index must not serve results that
   * read as live. Cached five minutes; a read failure is treated as missing
   * (fail closed).
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
          // An alias resolves to its concrete index, so the mapping is keyed by
          // a name we did not ask for: take the single entry, whatever it is.
          const entries = root === null ? [] : Object.values(root);
          const first = entries.length === 1 ? asRecord(entries[0]) : null;
          const mappings = first === null ? null : asRecord(first['mappings']);
          const meta = mappings === null ? null : asRecord(mappings['_meta']);
          const builtAt = meta?.['built_at'];
          if (typeof builtAt === 'string' && builtAt !== '') value = builtAt;
        }
      }
    } catch {
      value = null;
    }
    metaCache.set(index, { value, expiresAt: Date.now() + META_TTL_MS });
    return value;
  };

  const run = async (
    index: string | undefined,
    leg: string,
    body: Record<string, unknown>,
    highlightFields: readonly string[]
  ): Promise<Result<LegalEnginePage, ApiError>> => {
    if (index === undefined) {
      return err(upstreamError(`legal search: no index configured for ${leg}`, 'opensearch'));
    }
    try {
      const resp = await send('POST', `/${index}/_search?allow_partial_search_results=false`, body);
      // Status-only diagnostics: response bodies echo the query text AND the
      // indexed law text, and must never reach the logs.
      if (resp.status !== 200) {
        return err(upstreamError(`legal search ${leg}: http ${String(resp.status)}`, 'opensearch'));
      }
      const parsed = safeJsonParse(resp.text);
      if (parsed.isErr()) {
        return err(upstreamError(`legal search ${leg}: invalid json response`, 'opensearch'));
      }
      const payload = asRecord(parsed.value);
      if (payload === null) {
        return err(upstreamError(`legal search ${leg}: malformed response`, 'opensearch'));
      }
      if (!isCompleteResponse(payload)) {
        return err(upstreamError(`legal search ${leg}: incomplete search response`, 'opensearch'));
      }
      const parsedHits = parseHits(payload, highlightFields);
      if (parsedHits === null) {
        return err(upstreamError(`legal search ${leg}: malformed hits payload`, 'opensearch'));
      }
      const asOf = await readAsOf(index);
      if (asOf === null) {
        return err(
          upstreamError(`legal search ${leg}: index carries no build stamp`, 'opensearch')
        );
      }
      return ok({
        hits: parsedHits.hits,
        total: parsedHits.total,
        totalExhaustive: parsedHits.totalExhaustive,
        asOf,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      return err(
        upstreamError(`legal search ${leg}: transport failed: ${msg}`, 'opensearch', error)
      );
    }
  };

  return {
    canServeActs: () => config.actsIndex !== undefined,
    canServeSections: () => config.sectionsIndex !== undefined,

    searchActsBm25: (q, filter, window) =>
      run(
        config.actsIndex,
        'acts/bm25',
        buildActsBm25Body(q, filter, window),
        ACTS_HIGHLIGHT_FIELDS
      ),

    searchSectionsBm25: (q, filter, window) =>
      run(
        config.sectionsIndex,
        'sections/bm25',
        buildSectionsBm25Body(q, filter, window),
        SECTIONS_HIGHLIGHT_FIELDS
      ),

    // No highlights on the vector leg: a kNN match has no query terms to mark,
    // and inventing one would misreport WHY the provision was retrieved.
    searchSectionsKnn: (queryVector, filter, size) =>
      run(
        config.sectionsIndex,
        'sections/knn',
        buildSectionsKnnBody(queryVector, filter, size),
        []
      ),
  };
};
