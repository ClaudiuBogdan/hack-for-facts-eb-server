import { Type } from '@sinclair/typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLICKHOUSE_MAX_CONCURRENT,
  CLICKHOUSE_MAX_QUEUED,
  makeClickhouseReader,
  makeQueryParams,
} from '@/modules/companies/shell/analytics/clickhouse-reader.js';

import type { Logger } from '@/modules/shared/index.js';

const CONFIG = {
  url: 'https://clickhouse.internal:8443',
  database: 'companies_analytics',
  user: 'companies_reader',
  password: 's3cr3t-value',
};
const ROW = Type.Object({ companies: Type.String() });

const compact = (rows: readonly Record<string, unknown>[], names = ['companies']) =>
  Response.json({
    meta: names.map((name) => ({ name, type: 'String' })),
    data: rows.map((row) => names.map((name) => row[name])),
  });

const recordingLogger = () => {
  const lines: string[] = [];
  const log = (obj: unknown, msg?: string) => {
    lines.push(JSON.stringify(obj) + (msg ?? ''));
  };
  const logger: Logger = { info: log, warn: log, error: log, debug: log };
  return { logger, lines };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('companies analytics ClickHouse reader', () => {
  it('posts the statement with typed parameters, header credentials and no settings', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(compact([{ companies: '42' }]));
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    const params = makeQueryParams();
    const sql = `SELECT toString(count()) AS companies FROM t WHERE has(${params.bind('Array(String)', ["a'b", 'c\\d'])}, x) AND y = ${params.bind('String', 'tab\there')}`;
    const result = await reader.query(sql, params, ROW);
    expect(result._unsafeUnwrap()).toEqual([{ companies: '42' }]);

    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://clickhouse.internal:8443');
    expect(url.searchParams.get('database')).toBe('companies_analytics');
    expect(url.searchParams.get('param_p0')).toBe("['a\\'b','c\\\\d']");
    expect(url.searchParams.get('param_p1')).toBe('tab\\there');
    // readonly=1: the reader sends no setting at all.
    expect([...url.searchParams.keys()].sort()).toEqual(['database', 'param_p0', 'param_p1']);
    expect(url.toString()).not.toContain(CONFIG.password);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      'X-ClickHouse-User': 'companies_reader',
      'X-ClickHouse-Key': 's3cr3t-value',
    });
    expect(init.body).toBe(`${sql} FORMAT JSONCompact`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['159', 'Timeout'],
    ['241', 'ServiceUnavailable'],
    ['202', 'ServiceUnavailable'],
    ['60', 'Database'],
    [null, 'Database'],
  ])('maps server error code %s to %s without echoing the server text', async (code, type) => {
    const body = `Code: ${code ?? '999'}. DB::Exception: secret query text s3cr3t-value`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 500,
          headers: code === null ? {} : { 'X-ClickHouse-Exception-Code': code },
        })
      )
    );
    const { logger, lines } = recordingLogger();
    const result = await makeClickhouseReader(CONFIG, logger).query(
      'SELECT 1',
      makeQueryParams(),
      ROW
    );
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe(type);
    expect(JSON.stringify(error)).not.toContain('DB::Exception');
    expect(lines.join('\n')).not.toContain('DB::Exception');
    expect(lines.join('\n')).not.toContain('s3cr3t');
  });

  it('turns a transport failure into a generic upstream error and never logs it raw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED user:s3cr3t-value@host'))
    );
    const { logger, lines } = recordingLogger();
    const result = await makeClickhouseReader(CONFIG, logger).query(
      'SELECT 1',
      makeQueryParams(),
      ROW
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'Upstream',
      message: 'companies analytics engine is unreachable',
    });
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain('s3cr3t');
    expect(lines.join('\n')).not.toContain('s3cr3t');
    expect(lines.join('\n')).not.toContain('ECONNREFUSED');
  });

  it.each([
    ['a missing column', compact([{ companies: '1' }], ['rows'])],
    ['a wrong scalar type', compact([{ companies: 1 }])],
    ['a short row', Response.json({ meta: [{ name: 'companies', type: 'String' }], data: [[]] })],
    ['not JSON', new Response('<html>proxy</html>', { status: 200 })],
  ])('rejects %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await makeClickhouseReader(CONFIG).query('SELECT 1', makeQueryParams(), ROW);
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });

  it('caps each process at 3 in flight: 2 replicas stay within the reader’s limit of 6', () => {
    expect(CLICKHOUSE_MAX_CONCURRENT).toBe(3);
    expect(CLICKHOUSE_MAX_CONCURRENT * 2).toBeLessThanOrEqual(6);
  });

  it('refuses at once as busy when the wait queue is full, without a request', async () => {
    const fetchSpy = vi.fn().mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    const held = Array.from({ length: CLICKHOUSE_MAX_CONCURRENT + CLICKHOUSE_MAX_QUEUED }, (_, i) =>
      reader.query(`SELECT ${String(i)}`, makeQueryParams(), ROW, { cache: false })
    );
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(CLICKHOUSE_MAX_CONCURRENT);
    });
    const overflow = await reader.query('SELECT overflow', makeQueryParams(), ROW, {
      cache: false,
    });
    expect(overflow._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: 'companies analytics is busy; retry shortly',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(CLICKHOUSE_MAX_CONCURRENT);
    reader.close();
    const settled = await Promise.all(held);
    expect(settled.every((r) => r.isErr())).toBe(true);
  });

  it(`keeps at most ${String(CLICKHOUSE_MAX_CONCURRENT)} requests in flight`, async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const fetchSpy = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    const pending = Array.from({ length: CLICKHOUSE_MAX_CONCURRENT + 2 }, (_, i) =>
      reader.query(`SELECT ${String(i)}`, makeQueryParams(), ROW, { cache: false })
    );
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(CLICKHOUSE_MAX_CONCURRENT);
    });
    resolvers[0]?.(compact([{ companies: '1' }]));
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(CLICKHOUSE_MAX_CONCURRENT + 1);
    });
    for (let i = 1; i < resolvers.length; i++) resolvers[i]?.(compact([{ companies: '1' }]));
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(CLICKHOUSE_MAX_CONCURRENT + 2);
    });
    resolvers.at(-1)?.(compact([{ companies: '1' }]));
    const results = await Promise.all(pending);
    expect(results.every((r) => r.isOk())).toBe(true);
  });

  it('shares one request between identical concurrent statements and caches the result', async () => {
    const fetchSpy = vi
      .fn()
      .mockImplementation(() => Promise.resolve(compact([{ companies: '7' }])));
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    const [a, b] = await Promise.all([
      reader.query('SELECT 7', makeQueryParams(), ROW),
      reader.query('SELECT 7', makeQueryParams(), ROW),
    ]);
    const c = await reader.query('SELECT 7', makeQueryParams(), ROW);
    expect([a, b, c].map((r) => r._unsafeUnwrap())).toEqual([
      [{ companies: '7' }],
      [{ companies: '7' }],
      [{ companies: '7' }],
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('Code: 241.', { status: 500 }))
      .mockResolvedValueOnce(compact([{ companies: '1' }]));
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    expect((await reader.query('SELECT 1', makeQueryParams(), ROW)).isErr()).toBe(true);
    expect((await reader.query('SELECT 1', makeQueryParams(), ROW)).isOk()).toBe(true);
  });

  it('close() aborts in-flight requests and refuses new ones', async () => {
    const fetchSpy = vi.fn().mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (init.signal?.aborted === true) abort();
          init.signal?.addEventListener('abort', abort);
        })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader(CONFIG);
    const inFlight = reader.query('SELECT 1', makeQueryParams(), ROW);
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    reader.close();
    expect((await inFlight)._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    const after = await reader.query('SELECT 2', makeQueryParams(), ROW);
    expect(after._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });
});
