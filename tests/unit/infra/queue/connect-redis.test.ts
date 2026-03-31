import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { connectQueueRedis } from '@/infra/queue/connect-redis.js';

class FakeRedis {
  connectCalls = 0;
  pingCalls = 0;
  quitCalls = 0;
  disconnectCalls = 0;
  listenerCount = 0;

  constructor(
    private readonly behavior: {
      connectError?: Error;
      pingError?: Error;
      quitError?: Error;
    } = {}
  ) {}

  on(_event: 'error', _listener: (error: Error) => void): this {
    this.listenerCount += 1;
    return this;
  }

  off(_event: 'error', _listener: (error: Error) => void): this {
    this.listenerCount = Math.max(0, this.listenerCount - 1);
    return this;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.behavior.connectError !== undefined) {
      throw this.behavior.connectError;
    }
  }

  async ping(): Promise<string> {
    this.pingCalls += 1;
    if (this.behavior.pingError !== undefined) {
      throw this.behavior.pingError;
    }

    return 'PONG';
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
    if (this.behavior.quitError !== undefined) {
      throw this.behavior.quitError;
    }
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

describe('connectQueueRedis', () => {
  const logger = pinoLogger({ level: 'silent' });

  it('connects and pings successfully before returning the client', async () => {
    const redis = new FakeRedis();

    const result = await connectQueueRedis({
      redisUrl: 'redis://localhost:6379',
      logger,
      redisFactory: () => redis as never,
    });

    expect(result).toBe(redis);
    expect(redis.connectCalls).toBe(1);
    expect(redis.pingCalls).toBe(1);
    expect(redis.quitCalls).toBe(0);
    expect(redis.disconnectCalls).toBe(0);
    expect(redis.listenerCount).toBe(0);
  });

  it('closes the client when bootstrap fails and disconnects if quit also fails', async () => {
    const redis = new FakeRedis({
      pingError: new Error('ping failed'),
      quitError: new Error('quit failed'),
    });

    await expect(
      connectQueueRedis({
        redisUrl: 'redis://localhost:6379',
        logger,
        redisFactory: () => redis as never,
      })
    ).rejects.toThrow('ping failed');

    expect(redis.connectCalls).toBe(1);
    expect(redis.pingCalls).toBe(1);
    expect(redis.quitCalls).toBe(1);
    expect(redis.disconnectCalls).toBe(1);
    expect(redis.listenerCount).toBe(0);
  });
});
