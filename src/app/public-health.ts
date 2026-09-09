/**
 * Public projection of the kernel health report (review X/F14).
 *
 * `/api/v1/health` and `/api/v1/ready` are unauthenticated. The kernel report
 * carries each dependency's raw error string (driver messages with host names,
 * TLS and pool details), which belongs in the log, not in a public body. The
 * public body keeps status + latency and a coded reason.
 */
import type { HealthReport, ServiceStatus } from '../modules/shared/index.js';

export type PublicServiceReason = 'timeout' | 'error';

export interface PublicServiceStatus {
  readonly status: ServiceStatus['status'];
  readonly latencyMs?: number;
  readonly reason?: PublicServiceReason;
}

export interface PublicHealthReport {
  readonly overall: HealthReport['overall'];
  readonly postgres: PublicServiceStatus;
  readonly meilisearch: PublicServiceStatus;
  readonly opensearch: PublicServiceStatus;
  readonly synthetic: PublicServiceStatus;
}

const DEPENDENCIES = ['postgres', 'meilisearch', 'opensearch', 'synthetic'] as const;

const toPublic = (s: ServiceStatus): PublicServiceStatus => ({
  status: s.status,
  ...(s.latencyMs !== undefined && { latencyMs: s.latencyMs }),
  ...(s.status === 'error' && {
    reason: s.error === 'health probe timeout' ? 'timeout' : 'error',
  }),
});

/** The sanitized body plus the raw per-dependency errors for the log. */
export const publicHealthReport = (
  report: HealthReport
): {
  readonly publicReport: PublicHealthReport;
  readonly detail: readonly { readonly dependency: string; readonly error: string }[];
} => ({
  publicReport: {
    overall: report.overall,
    postgres: toPublic(report.postgres),
    meilisearch: toPublic(report.meilisearch),
    opensearch: toPublic(report.opensearch),
    synthetic: toPublic(report.synthetic),
  },
  detail: DEPENDENCIES.flatMap((dependency) => {
    const s = report[dependency];
    return s.status === 'error' && s.error !== undefined && s.error !== ''
      ? [{ dependency, error: s.error }]
      : [];
  }),
});
