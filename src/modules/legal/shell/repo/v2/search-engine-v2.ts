/**
 * The OpenSearch transport for the legal-v2 TEST indexes (words only).
 *
 * `actsIndex` / `unitsIndex` name `legal-v2-test-acts-*` / `legal-v2-test-
 * units-*` (no aliases exist for the test indexes). Each index must carry the
 * exporter's `_mapping._meta`: its `index_contract` (refused when it is not the
 * v2 contract, so an old `legal-sections` index is never read with v2 field
 * names) and its `built_at` stamp (served as `asOf`). The reader user needs
 * `indices:data/read/search*` AND `indices:admin/mappings/get` on the indexes.
 *
 * Any engine trouble is an error, never a substitute answer.
 */

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '@/modules/shared/index.js';

import {
  V2_INDEX_CONTRACT_ACTS,
  V2_INDEX_CONTRACT_UNITS,
  buildV2ActsBody,
  buildV2UnitsBody,
  type LegalV2SearchEngine,
  type V2EngineHit,
  type V2EnginePage,
} from '../../../core/v2/search.js';
import {
  makeLegalEngineHttpsTransport,
  type LegalEngineConfig,
  type LegalEngineTransport,
} from '../opensearch-legal-repo.js';

export interface LegalV2EngineConfig extends LegalEngineConfig {
  readonly actsIndex: string;
  readonly unitsIndex: string;
}

const META_TTL_MS = 5 * 60_000;
const safeJsonParse = fromThrowable(JSON.parse as (text: string) => unknown);
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const complete = (payload: Record<string, unknown>): boolean => {
  if (payload['timed_out'] === true || payload['terminated_early'] === true) return false;
  const shards = rec(payload['_shards']);
  if (shards === null) return false;
  const { total, successful, failed, skipped } = shards;
  if (typeof total !== 'number' || typeof successful !== 'number') return false;
  if (typeof failed === 'number' && failed > 0) return false;
  return successful + (typeof skipped === 'number' ? skipped : 0) >= total;
};

const idOf = (v: unknown): string | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^\d{1,18}$/u.test(v)
      ? v
      : null;

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse one search answer; null when malformed (refused upstream). */
export const parseV2Hits = (
  payload: Record<string, unknown>
): { hits: V2EngineHit[]; total: number | null; totalExhaustive: boolean } | null => {
  const block = rec(payload['hits']);
  const raw = block?.['hits'];
  if (!Array.isArray(raw)) return null;
  // `track_total_hits: false` sends no total; a total that is sent must be well formed.
  const totalBlock = block?.['total'];
  let total: number | null = null;
  let totalExhaustive = false;
  if (totalBlock !== undefined) {
    const t = rec(totalBlock);
    const value = t?.['value'];
    const relation = t?.['relation'];
    if (typeof value !== 'number' || (relation !== 'eq' && relation !== 'gte')) return null;
    total = value;
    totalExhaustive = relation === 'eq';
  }
  const hits: V2EngineHit[] = [];
  for (const item of raw) {
    const hit = rec(item);
    const source = rec(hit?.['_source']);
    if (hit === null || source === null) return null;
    const actId = idOf(source['act_id']);
    if (actId === null) return null;
    const highlight = rec(hit['highlight']);
    let snippet: string | null = null;
    for (const field of ['text', 'text.folded']) {
      const fragments = highlight?.[field];
      if (Array.isArray(fragments) && typeof fragments[0] === 'string') {
        snippet = fragments[0];
        break;
      }
    }
    const score = hit['_score'];
    hits.push({
      actId,
      score: typeof score === 'number' ? score : 0,
      citationPath: strOrNull(source['citation_path']),
      headingPath: strOrNull(source['heading_path']),
      snippet,
    });
  }
  return { hits, total, totalExhaustive };
};

export const makeLegalV2SearchEngine = (
  config: LegalV2EngineConfig,
  injected?: LegalEngineTransport
): LegalV2SearchEngine => {
  const send = injected ?? makeLegalEngineHttpsTransport(config);
  const metaCache = new Map<string, { value: Result<string, string>; expiresAt: number }>();

  /** `_meta.built_at` of an index carrying `contract`, or why it cannot serve. */
  const readMeta = async (index: string, contract: string): Promise<Result<string, string>> => {
    const cached = metaCache.get(index);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    let value: Result<string, string>;
    try {
      const resp = await send('GET', `/${encodeURIComponent(index)}/_mapping`);
      const parsed = resp.status === 200 ? safeJsonParse(resp.text) : null;
      const root = parsed?.isOk() === true ? rec(parsed.value) : null;
      const entries = root === null ? [] : Object.values(root);
      const meta = rec(rec(rec(entries.length === 1 ? entries[0] : null)?.['mappings'])?.['_meta']);
      const builtAt = meta?.['built_at'];
      if (resp.status !== 200) value = err(`mapping read http ${String(resp.status)}`);
      else if (meta?.['index_contract'] !== contract) value = err(`index is not ${contract}`);
      else if (typeof builtAt !== 'string' || builtAt === '')
        value = err('index carries no build stamp');
      else value = ok(builtAt);
    } catch (error) {
      value = err(error instanceof Error ? error.message : 'mapping read failed');
    }
    metaCache.set(index, { value, expiresAt: Date.now() + META_TTL_MS });
    return value;
  };

  const run = async (
    index: string,
    contract: string,
    leg: string,
    body: Record<string, unknown>
  ): Promise<Result<V2EnginePage, ApiError>> => {
    try {
      const resp = await send(
        'POST',
        `/${encodeURIComponent(index)}/_search?allow_partial_search_results=false`,
        body
      );
      if (resp.status !== 200) {
        return err(
          upstreamError(`legal v2 search ${leg}: http ${String(resp.status)}`, 'opensearch')
        );
      }
      const parsed = safeJsonParse(resp.text);
      const payload = parsed.isOk() ? rec(parsed.value) : null;
      if (payload === null) {
        return err(upstreamError(`legal v2 search ${leg}: invalid json response`, 'opensearch'));
      }
      if (!complete(payload)) {
        return err(
          upstreamError(`legal v2 search ${leg}: incomplete search response`, 'opensearch')
        );
      }
      const hits = parseV2Hits(payload);
      if (hits === null) {
        return err(upstreamError(`legal v2 search ${leg}: malformed hits payload`, 'opensearch'));
      }
      const meta = await readMeta(index, contract);
      if (meta.isErr()) {
        return err(upstreamError(`legal v2 search ${leg}: ${meta.error}`, 'opensearch'));
      }
      return ok({ ...hits, asOf: meta.value });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      return err(
        upstreamError(`legal v2 search ${leg}: transport failed: ${msg}`, 'opensearch', error)
      );
    }
  };

  return {
    searchActs: (q, f, size) =>
      run(config.actsIndex, V2_INDEX_CONTRACT_ACTS, 'acts', buildV2ActsBody(q, f, size)),
    searchUnits: (q, f, size, countTotal) =>
      run(
        config.unitsIndex,
        V2_INDEX_CONTRACT_UNITS,
        'units',
        buildV2UnitsBody(q, f, size, countTotal)
      ),
  };
};
