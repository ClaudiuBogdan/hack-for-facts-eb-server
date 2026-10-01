import createFastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { fastifyTrustProxy } from '@/infra/config/trust-proxy.js';

describe('patched Fastify proxy compatibility', () => {
  it('rejects spoofed forwarded headers under numeric hop-only settings', async () => {
    const app = createFastify({ trustProxy: fastifyTrustProxy(1) });
    app.get('/probe', (request) => ({
      ip: request.ip,
      hostname: request.hostname,
      protocol: request.protocol,
    }));
    try {
      const response = await app.inject({
        url: '/probe',
        headers: {
          'x-forwarded-for': '192.0.2.1',
          'x-forwarded-host': 'spoof.example',
          'x-forwarded-proto': 'https',
        },
      });
      expect(response.json()).toEqual({ ip: '127.0.0.1', hostname: 'localhost', protocol: 'http' });
    } finally {
      await app.close();
    }
  });
  it('keeps explicit booleans, proxy lists and the current gateway default', () => {
    expect(fastifyTrustProxy(false)).toBe(false);
    expect(fastifyTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(fastifyTrustProxy(undefined)).toBe(true);
  });
});
