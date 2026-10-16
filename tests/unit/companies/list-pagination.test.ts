/**
 * Companies unit tests — the GraphQL `companies` connection's next-page signal
 * (CQA-17). A name query resolves at most 50 candidate CUIs; a full-cap
 * resolution makes the TOTAL an estimate of how many companies match the name,
 * but the candidate list itself ends at `totalCount`. Only a capped COUNT means
 * rows continue past it. The cap is disclosed structurally instead.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';

import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { CompanyListRow } from '@/modules/companies/core/types.js';
import type { ContributorRegistry } from '@/modules/shared/index.js';

const row = (cui: string): CompanyListRow => ({
  cui,
  orgId: cui,
  name: `CO ${cui}`,
  nameSource: 'core_organization',
  legalForm: null,
  headlineStatus: null,
  county: null,
  vatPayer: null,
  declaredFiscallyInactive: null,
  registrationDate: null,
  registrationDatePresent: false,
  registryCuiState: 'IN_EDITION' as CompanyListRow['registryCuiState'],
  hasActiveObservation: null,
  statusBasis: null,
  countyBasis: null,
  recordedDateBasis: null,
});

const nameHit = (cui: string) => ({
  dim: 'name' as const,
  value: cui,
  label: `CO ${cui}`,
  cui,
  confidence: 1,
  labelSource: 'core_organization' as const,
});

const CANDIDATES = Array.from({ length: 50 }, (_, i) => String(1000 + i));

interface Connection {
  edges: { cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
  totalEstimated: boolean;
  nameCandidateCapped: boolean;
  caveats: string[];
}

/**
 * A repo whose list read pages `cuis` by offset (as the SQL does) with an
 * exact or capped count.
 */
const pagingRepo = (
  cuis: readonly string[],
  over: { hits?: readonly string[]; countCapped?: boolean; total?: number } = {}
): CompaniesRepository => {
  const listCompanies: CompaniesRepository['listCompanies'] = async (filter, _sort, page) => {
    const inList = (filter['cui'] as { in?: readonly string[] } | undefined)?.in;
    const all = inList === undefined ? cuis : cuis.filter((c) => inList.includes(c));
    const start = (page.page - 1) * page.pageSize;
    return ok({
      rows: all.slice(start, start + page.pageSize).map(row),
      total: over.total ?? all.length,
      estimated: over.countCapped ?? false,
    });
  };
  return stubRepo({
    resolveByName: vi.fn(async () => ok({ hits: (over.hits ?? []).map(nameHit), degraded: false })),
    listCompanies: vi.fn(listCompanies),
  });
};

const companiesQuery = (repo: CompaniesRepository) => {
  const resolvers = makeCompaniesResolvers({
    repo,
    flowsRepo: stubFlows(),
    meili: null,
    registry: {} as ContributorRegistry,
    hubStats: { get: vi.fn() },
  }) as { Query: Record<string, (r: unknown, a: Record<string, unknown>) => Promise<unknown>> };
  return async (args: Record<string, unknown>): Promise<Connection> =>
    (await resolvers.Query['companies']?.(null, args)) as Connection;
};

describe('companies connection next-page signal (CQA-17)', () => {
  it('a full name-candidate cap ends paging at the candidates and discloses the cap', async () => {
    const query = companiesQuery(pagingRepo(CANDIDATES, { hits: CANDIDATES }));
    const first = await query({ q: 'Ford', sort: 'NAME', first: 50 });
    expect(first.edges).toHaveLength(50);
    expect(first.totalCount).toBe(50);
    // No further page of these candidates exists...
    expect(first.pageInfo.hasNextPage).toBe(false);
    // ...though the total still only estimates how many companies match the name.
    expect(first.totalEstimated).toBe(true);
    expect(first.nameCandidateCapped).toBe(true);
    expect(first.caveats.some((c) => c.includes('50-candidate cap'))).toBe(true);
  });

  it('pages through a capped candidate set and stops at its end', async () => {
    const query = companiesQuery(pagingRepo(CANDIDATES, { hits: CANDIDATES }));
    const seen: number[] = [];
    let after: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Connection = await query({
        q: 'Ford',
        first: 20,
        ...(after !== null && { after }),
      });
      seen.push(page.edges.length);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    // 20 + 20 + 10: every advertised next page has rows; nothing past 50.
    expect(seen).toEqual([20, 20, 10]);
  });

  it('a below-cap name query stays exact and undisclosed', async () => {
    const hits = CANDIDATES.slice(0, 3);
    const page = await companiesQuery(pagingRepo(CANDIDATES, { hits }))({ q: 'rare', first: 20 });
    expect(page.totalCount).toBe(3);
    expect(page.totalEstimated).toBe(false);
    expect(page.nameCandidateCapped).toBe(false);
    expect(page.caveats).toEqual([]);
    expect(page.pageInfo.hasNextPage).toBe(false);
  });

  it('a capped count still advertises the next page of a full page', async () => {
    // The repo caps the count at 10,000 and flags it once more rows exist.
    const page = await companiesQuery(
      pagingRepo(CANDIDATES.slice(0, 20), { countCapped: true, total: 10_000 })
    )({ first: 20 });
    expect(page.totalCount).toBe(10_000);
    expect(page.totalEstimated).toBe(true);
    expect(page.nameCandidateCapped).toBe(false);
    expect(page.pageInfo.hasNextPage).toBe(true);
  });

  it('an exact count advertises a next page only while rows remain', async () => {
    const query = companiesQuery(pagingRepo(CANDIDATES.slice(0, 40)));
    const first = await query({ first: 20 });
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = await query({ first: 20, after: first.pageInfo.endCursor });
    expect(second.edges).toHaveLength(20);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });
});
