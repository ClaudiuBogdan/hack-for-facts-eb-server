/**
 * Endpoint URL helpers (pure).
 *
 * - `canonicalizeEndpoint`: two URLs that differ only in host case, an
 *   explicit default port, a trailing slash, a fragment or userinfo are the
 *   SAME endpoint — comparing such a pair would compare the legacy endpoint
 *   to itself and pass.
 * - `redactEndpoint`: the display form of a URL (userinfo stripped) used in
 *   console output and in every report file, so credentials in an endpoint
 *   URL never land on disk.
 */

export function canonicalizeEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not an absolute URL: ${redactEndpoint(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol in endpoint URL: ${redactEndpoint(raw)}`);
  }
  // `new URL` already lowercases the host and drops the scheme's default
  // port; `origin` carries no userinfo and no fragment. Loopback aliases
  // (`localhost`, `127.0.0.1`, `[::1]`) reach the same listener, so they are
  // one host (codex 2026-09-02: a localhost/127.0.0.1 pair compared the
  // baseline endpoint to itself and passed). Other DNS aliases of one host
  // are NOT resolved here — name them consistently.
  const hostname = LOOPBACK_HOSTNAMES.has(url.hostname) ? 'localhost' : url.hostname;
  const port = url.port === '' ? '' : `:${url.port}`;
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${url.protocol}//${hostname}${port}${pathname}${url.search}`;
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export function sameEndpoint(a: string, b: string): boolean {
  return canonicalizeEndpoint(a) === canonicalizeEndpoint(b);
}

/** The URL with any `user:password@` removed; non-URLs are returned as-is. */
export function redactEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.username === '' && url.password === '') return raw;
  url.username = '';
  url.password = '';
  return url.href;
}
