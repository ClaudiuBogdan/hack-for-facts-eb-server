/**
 * The public health projection (review X/F14): dependency error strings
 * (driver messages with host names, TLS and pool details) never reach the
 * unauthenticated `/api/v1/health` / `/api/v1/ready` bodies; a coded reason
 * does, and the raw text is handed back for the log.
 */
import { describe, expect, it } from 'vitest';

import { publicHealthReport } from '@/app/public-health.js';

import type { HealthReport } from '@/modules/shared/index.js';

const report: HealthReport = {
  overall: 'degraded',
  postgres: { status: 'ok', latencyMs: 3 },
  meilisearch: {
    status: 'error',
    latencyMs: 4001,
    error: 'connect ECONNREFUSED 10.42.0.17:7700 (meili.internal)',
  },
  opensearch: { status: 'error', latencyMs: 4000, error: 'health probe timeout' },
  synthetic: { status: 'disabled' },
};

describe('publicHealthReport', () => {
  it('keeps status and latency, replaces the error text with a coded reason', () => {
    const { publicReport } = publicHealthReport(report);
    expect(publicReport).toEqual({
      overall: 'degraded',
      postgres: { status: 'ok', latencyMs: 3 },
      meilisearch: { status: 'error', latencyMs: 4001, reason: 'error' },
      opensearch: { status: 'error', latencyMs: 4000, reason: 'timeout' },
      synthetic: { status: 'disabled' },
    });
    expect(JSON.stringify(publicReport)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(publicReport)).not.toContain('10.42.0.17');
  });

  it('hands the raw errors back for the log, one entry per failing dependency', () => {
    expect(publicHealthReport(report).detail).toEqual([
      { dependency: 'meilisearch', error: 'connect ECONNREFUSED 10.42.0.17:7700 (meili.internal)' },
      { dependency: 'opensearch', error: 'health probe timeout' },
    ]);
    expect(
      publicHealthReport({
        ...report,
        overall: 'healthy',
        meilisearch: { status: 'ok' },
        opensearch: { status: 'ok' },
      }).detail
    ).toEqual([]);
  });
});
