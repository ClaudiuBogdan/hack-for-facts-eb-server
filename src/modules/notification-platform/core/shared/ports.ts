export type { Clock, IdGenerator } from '@/common/ports/index.js';

export interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
