import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';

export interface QueueRedisHealthConfig {
  readonly url: string;
  readonly password: string;
  readonly caFile: string;
}

export const makeQueueRedisHealth = (config: QueueRedisHealthConfig) => {
  const redis = new Redis(config.url, {
    password: config.password,
    tls: {
      ca: readFileSync(config.caFile),
      rejectUnauthorized: true,
      servername: new URL(config.url).hostname,
    },
    lazyConnect: true,
    disableClientInfo: true,
    enableReadyCheck: false,
    connectTimeout: 1000,
    commandTimeout: 1500,
    socketTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => 5000,
  });
  // Driver errors can include the endpoint. Expose only probe status.
  redis.on('error', () => undefined);
  let pendingCheck: ReturnType<typeof check> | undefined;

  async function check() {
    const start = performance.now();
    let healthy = false;
    try {
      if (redis.status === 'wait') void redis.connect().catch(() => undefined);
      if (redis.status === 'ready') {
        const response: string = await redis.ping();
        healthy = response === 'PONG';
      }
    } catch {
      // Retry on the next health check once the driver reconnects.
    }
    return {
      status: healthy ? ('healthy' as const) : ('unhealthy' as const),
      latencyMs: Math.round(performance.now() - start),
    };
  }

  return {
    check() {
      pendingCheck ??= check().finally(() => {
        pendingCheck = undefined;
      });
      return pendingCheck;
    },
    close() {
      redis.disconnect();
    },
  };
};
