import { Redis, type RedisOptions } from 'ioredis';

import { closeRedis } from './close-redis.js';

import type { Logger } from 'pino';

export interface QueueRedisClient {
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

export type QueueRedis = Redis & QueueRedisClient;

export type QueueRedisFactory = (url: string, options: RedisOptions) => QueueRedis;

export interface ConnectQueueRedisConfig {
  redisUrl: string;
  redisPassword?: string;
  logger: Logger;
  redisFactory?: QueueRedisFactory;
}

const normalizeRedisError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error('Unknown BullMQ Redis connection error');
};

export const connectQueueRedis = async (config: ConnectQueueRedisConfig): Promise<QueueRedis> => {
  const {
    redisUrl,
    redisPassword,
    logger,
    redisFactory = (url, options) => new Redis(url, options),
  } = config;
  const redis = redisFactory(redisUrl, {
    ...(redisPassword !== undefined && redisPassword !== '' ? { password: redisPassword } : {}),
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  let latestStartupError: Error | undefined;
  const onStartupError = (error: Error) => {
    latestStartupError = error;
  };

  redis.on('error', onStartupError);

  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch (error) {
    await closeRedis(redis, logger);
    throw latestStartupError ?? normalizeRedisError(error);
  } finally {
    redis.off('error', onStartupError);
  }
};
