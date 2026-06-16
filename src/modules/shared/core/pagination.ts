/**
 * Shared Kernel — Pagination contracts (foundation §5.3, §14.3, §14.4).
 *
 * Two shapes, picked per endpoint:
 *  - Offset: `page`/`pageSize` for bounded/cheap-count lists (§14.4 guard).
 *  - Cursor: opaque base64url of the sort tuple + filter hash (`fhash`) for
 *    large/time-ordered lists. `fhash` is identical across REST/GraphQL/MCP for
 *    the same logical filters and rejects filter-mismatched cursors (§14.3).
 *
 * Pure: no Node/Buffer dependency (base64url via a small helper so the encoder
 * is unit-testable in any environment and identical on every surface).
 */

import { err, ok, type Result  } from 'neverthrow';

import { invalidInput, type ApiError } from './errors.js';



// ─────────────────────────────────────────────────────────────────────────────
// Offset pagination (§5.3 + §14.4 guard)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface OffsetParams {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `meta.page` envelope. `estimated` flags a planner estimate where an exact
 * blocking COUNT(*) is disallowed (§14.4 — large sets use cursor).
 */
export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly estimated?: boolean;
}

/** Clamp + default offset params. */
export const normalizeOffset = (
  page: number | undefined,
  pageSize: number | undefined
): OffsetParams => {
  const p = page !== undefined && Number.isFinite(page) && page >= 1 ? Math.floor(page) : DEFAULT_PAGE;
  const rawSize =
    pageSize !== undefined && Number.isFinite(pageSize) && pageSize >= 1
      ? Math.floor(pageSize)
      : DEFAULT_PAGE_SIZE;
  return { page: p, pageSize: Math.min(rawSize, MAX_PAGE_SIZE) };
};

export const offsetFor = (params: OffsetParams): number => (params.page - 1) * params.pageSize;

// ─────────────────────────────────────────────────────────────────────────────
// Cursor pagination (§14.3 envelope)
// ─────────────────────────────────────────────────────────────────────────────

/** Current cursor envelope version. Bump to invalidate in-flight cursors. */
export const CURSOR_VERSION = 1 as const;

export interface CursorEnvelope {
  readonly v: number;
  readonly sort: string;
  readonly dir: 'asc' | 'desc';
  /** The sort-tuple of the last returned row (string-encoded). */
  readonly keys: readonly string[];
  /** Hash of canonicalizeFilters(input). */
  readonly fhash: string;
}

export interface CursorMeta {
  readonly next: string | null;
}

// base64url helpers — work in Node and any modern runtime without Buffer.
const toBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(s, 'utf8').toString('base64');
  return b64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const fromBase64Url = (s: string): string => {
  const b64 = s.replace(/-/gu, '+').replace(/_/gu, '/');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, 'base64').toString('utf8');
};

export const encodeCursor = (envelope: CursorEnvelope): string =>
  toBase64Url(JSON.stringify(envelope));

/**
 * Decode a cursor and validate it against the active sort + filter hash.
 * On `fhash`/sort/dir mismatch or malformed input returns `InvalidInput`
 * ("restart pagination") so clients reset to page 1 (§14.3) — never silently
 * re-apply.
 */
export const decodeCursor = (
  raw: string,
  expected: { sort: string; dir: 'asc' | 'desc'; fhash: string }
): Result<CursorEnvelope, ApiError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
  }
  const env = parsed as Partial<CursorEnvelope>;
  if (
    env.v !== CURSOR_VERSION ||
    typeof env.sort !== 'string' ||
    (env.dir !== 'asc' && env.dir !== 'desc') ||
    !Array.isArray(env.keys) ||
    typeof env.fhash !== 'string'
  ) {
    return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
  }
  if (env.fhash !== expected.fhash || env.sort !== expected.sort || env.dir !== expected.dir) {
    return err(invalidInput('cursor/filter mismatch; restart pagination', 'cursor'));
  }
  return ok({
    v: env.v,
    sort: env.sort,
    dir: env.dir,
    keys: env.keys.map((k) => String(k)),
    fhash: env.fhash,
  });
};

/** Build the next-page cursor from the last row's sort tuple. */
export const buildNextCursor = (params: {
  sort: string;
  dir: 'asc' | 'desc';
  fhash: string;
  lastKeys: readonly (string | number | null)[];
}): string =>
  encodeCursor({
    v: CURSOR_VERSION,
    sort: params.sort,
    dir: params.dir,
    fhash: params.fhash,
    keys: params.lastKeys.map((k) => (k === null ? '' : String(k))),
  });

/** A paginated cursor page. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/**
 * `Conn<T>` is an alias of `CursorPage<T>` for plans/modules that speak in
 * "connection" terms (GraphQL Relay naming). It is the SAME shape — the GraphQL
 * connection projection (edges/node/pageInfo) is built from this in the shell,
 * so there is one cursor contract, not two. Prefer `CursorPage<T>` in new code;
 * `Conn<T>` exists so module plans referencing it don't reinvent one.
 */
export type Conn<T> = CursorPage<T>;
