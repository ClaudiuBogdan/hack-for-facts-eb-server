/**
 * A full `CompaniesRepository` stub over in-memory answers (no mocking
 * library: plain `vi.fn` spies). The registry scope half captures
 * `PUBLISHED_SCOPE` and rechecks as holding unless overridden.
 */

import { ok } from 'neverthrow';
import { vi } from 'vitest';

import { PUBLISHED_SCOPE, recheckOf } from './registry-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { CompanyRegistryEnvelope } from '@/modules/companies/core/registry.js';
import type { FlowsRepo } from '@/modules/shared/index.js';

export const stubRepo = (
  over: Partial<CompaniesRepository> = {},
  scope: CompanyRegistryEnvelope = PUBLISHED_SCOPE
): CompaniesRepository => ({
  captureRegistryScope: vi.fn(async () => ok(scope)),
  confirmRegistryScope: vi.fn(async () => ok(recheckOf(scope))),
  getProfileData: vi.fn(async () => ok(null)),
  getFinancials: vi.fn(async () => ok([])),
  getFinancialQualityAssessment: vi.fn(async () =>
    ok({ assessedYears: [], assessedAt: null, flags: [] })
  ),
  getRegistrationDiffData: vi.fn(async (_cui: string, s: CompanyRegistryEnvelope) =>
    ok({ registry: s, later: null, earlier: null })
  ),
  listCompanies: vi.fn(async () => ok({ rows: [], total: 0, estimated: false })),
  countCompanies: vi.fn(async () => ok(0)),
  resolveByName: vi.fn(async () => ok({ hits: [], degraded: false })),
  findByRegistrationNumber: vi.fn(async () => ok([])),
  resolveCaen: vi.fn(async () => ok([])),
  resolveCounty: vi.fn(async () => ok([])),
  countBy: vi.fn(async () =>
    ok({
      groups: [],
      denominator: 0,
      coverage: { territoryMatched: null, territoryUnmatched: null, note: '' },
    })
  ),
  presenceCounts: vi.fn(async () => ok(null)),
  profileSlicesForCuis: vi.fn(async () => ok(new Map())),
  publishedEditions: vi.fn(async () => ok([])),
  ...over,
});

export const stubFlows = (): FlowsRepo => ({
  getFlowSummary: vi.fn(async () =>
    ok({
      direction: 'in' as const,
      count: 0,
      totalAmountRon: '0',
      minYear: null,
      maxYear: null,
      byFlowType: [],
      byYear: [],
    })
  ),
  getTopCounterparties: vi.fn(async () => ok([])),
  listFlows: vi.fn(async () => ok({ items: [], next: null })),
  getCounterpartyNetwork: vi.fn(async () => ok({ rootCui: '', depth: 0, nodes: [], edges: [] })),
  aggregateFlows: vi.fn(async () => ok([])),
});
