/**
 * Synthetic sql-v1 qualification fixtures for companies unit tests (never
 * source data). One published policy identity; statuses default to
 * `reported` unless overridden.
 */

import {
  COMPANY_FINANCIAL_METRICS,
  type CompanyFinancialMetric,
  type CompanyMetricStatus,
  type CompanyStatementQualification,
  type CompanyStatementSource,
} from '@/modules/companies/core/types.js';

export const POLICY_SHA = 'a1'.repeat(32);

export const assessedQualification = (
  statuses: Partial<Record<CompanyFinancialMetric, CompanyMetricStatus>> = {},
  netResult: string | null = null,
  identity: Partial<CompanyStatementQualification> = {}
): CompanyStatementQualification => {
  const metrics = COMPANY_FINANCIAL_METRICS.map((metric) => ({
    metric,
    status: statuses[metric] ?? ('reported' as const),
  }));
  const netResultStatus = statuses.net_result ?? 'reported';
  return {
    assessment: 'assessed',
    reason: null,
    releaseId: '2',
    policyVersion: 'companies-analytics-admission-2026-10-02-q1',
    policySha256: POLICY_SHA,
    policyApprovedOn: '2026-10-02',
    evaluatorVersion: 'sql-v1',
    metrics,
    netResultStatus,
    netResult: netResultStatus === 'reported' ? netResult : null,
    holdReason: null,
    holdDrift: [],
    ...identity,
  };
};

export const notAssessedQualification = (reason: string): CompanyStatementQualification => ({
  assessment: 'not_assessed',
  reason,
  releaseId: null,
  policyVersion: null,
  policySha256: null,
  policyApprovedOn: null,
  evaluatorVersion: null,
  metrics: [],
  netResultStatus: null,
  netResult: null,
  holdReason: null,
  holdDrift: [],
});

export const statementSource = (year: number, cui = '1'): CompanyStatementSource =>
  year >= 2019
    ? {
        sourceSystem: 'anaf',
        url: `https://webservicesp.anaf.ro/bilant?an=${String(year)}&cui=${cui}`,
        urlKind: 'anaf_statement',
        statementProfileHash: 'b2'.repeat(32),
        metricRuleVersion: 'anaf-bilant-metric-v1',
      }
    : {
        sourceSystem: 'mfp',
        url: null,
        urlKind: null,
        statementProfileHash: 'b2'.repeat(32),
        metricRuleVersion: 'anaf-bilant-metric-v1',
      };
