import { createServer, type IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { makeOpenSearchClient } from '@/modules/shared/shell/clients/opensearch-client.js';

const listen = async (
  handler: (request: IncomingMessage, body: string) => { status: number; body: unknown }
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const result = handler(request, Buffer.concat(chunks).toString('utf8'));
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        })
      ),
  };
};

describe('shared OpenSearch client', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map(async (close) => close()));
  });

  it('uses basic auth for health and aggregation without leaking response bodies', async () => {
    const authorization = `Basic ${Buffer.from('reader:secret').toString('base64')}`;
    const server = await listen((request, body) => {
      expect(request.headers.authorization).toBe(authorization);
      if (request.url === '/_cluster/health') return { status: 200, body: { status: 'green' } };
      expect(request.url).toBe('/entities/_search');
      expect(body).toContain('"size":0');
      return {
        status: 200,
        body: {
          aggregations: {
            groups: { buckets: [{ key: 'Bucuresti', doc_count: 4, total_ron: { value: 12.5 } }] },
          },
        },
      };
    });
    closers.push(server.close);

    const client = makeOpenSearchClient({
      url: server.url,
      username: 'reader',
      password: 'secret',
    });
    const health = await client.healthCheck();
    expect(health.isOk() && health.value.status).toBe('green');
    const aggregation = await client.termsAggregation('entities', 'county.keyword', {});
    expect(aggregation.isOk() && aggregation.value).toEqual([
      { key: 'Bucuresti', docCount: 4, totalRon: 12.5 },
    ]);
  });

  it('requires paired credentials and https for TLS options', () => {
    expect(() => makeOpenSearchClient({ url: 'https://example.test', username: 'reader' })).toThrow(
      'username and password must be set together'
    );
    expect(() => makeOpenSearchClient({ url: 'http://example.test', caCert: 'pem' })).toThrow(
      'CA and TLS servername require an https URL'
    );
  });

  it('can remain disabled without making a transport request', async () => {
    const client = makeOpenSearchClient({ url: '' });
    const health = await client.healthCheck();
    expect(health.isErr()).toBe(true);
    if (health.isErr()) expect(health.error.message).toContain('not configured');
  });
});
