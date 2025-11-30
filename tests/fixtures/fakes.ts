/**
 * Fake implementations for testing
 * Provides in-memory substitutes for external dependencies
 */

import pinoLib from 'pino';

/**
 * Create a silent logger for tests
 */
export const makeSilentLogger = () => {
  return pinoLib({ level: 'silent' });
};
