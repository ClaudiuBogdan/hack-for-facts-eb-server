import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export const closeRedis = async (redis: Redis, logger: Logger): Promise<void> => {
  try {
    await redis.quit();
  } catch (error) {
    logger.warn({ error }, 'Failed to quit BullMQ Redis cleanly, disconnecting');
    redis.disconnect();
  }
};
