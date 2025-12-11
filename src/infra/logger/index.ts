/**
 * Logger factory using Pino
 * Provides structured JSON logging with configurable levels
 */

import pinoLib, { type Logger, type LoggerOptions } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerConfig {
  level: LogLevel;
  name: string;
  pretty?: boolean;
}

const defaultConfig: LoggerConfig = {
  level: 'info',
  name: 'transparenta-eu-server',
  pretty: process.env['NODE_ENV'] !== 'production',
};

/**
 * Creates a configured Pino logger instance
 */
export const createLogger = (config: Partial<LoggerConfig> = {}): Logger => {
  const finalConfig = { ...defaultConfig, ...config };

  const options: LoggerOptions = {
    name: finalConfig.name,
    level: finalConfig.level,
  };

  // Use pino-pretty in development for readable logs
  if (finalConfig.pretty != null && finalConfig.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return pinoLib(options);
};

/**
 * Creates a child logger with additional context
 */
export const createChildLogger = (parent: Logger, context: Record<string, unknown>): Logger => {
  return parent.child(context);
};

export { type Logger } from 'pino';
