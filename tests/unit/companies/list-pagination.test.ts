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
import { makeCompaniesMcpTools } from '@/modules/companies/shell/mcp/tools.js';

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

/**
 * The cursor identity (CQA-25/26, independent audit 2026-10-17). The next page
 * starts at page index × page size over the candidates of one name query, so a
 * cursor is valid only for the page size and the name query that issued it. On
 * Chronos dev, `Ford first:20` then `first:50` returned 0 rows (30 skipped), and
 * the Ford cursor on `Dacia first:20` returned Dacia's rows 21–40.
 */
describe('companies cursor identity (CQA-25/26)', () => {
  const cuisOf = (page: Connection) =>
    (page.edges as unknown as { node: { cui: string } }[]).map((edge) => edge.node.cui);
  const FORD = CANDIDATES.slice(0, 50);
  const DACIA = Array.from({ length: 40 }, (_, i) => String(5000 + i));
  /** Name resolution that depends on the query, as Meili's does. */
  const twoNamesRepo = () => {
    const base = pagingRepo([...FORD, ...DACIA]);
    return stubRepo({
      ...base,
      resolveByName: vi.fn(async (q: string) =>
        ok({ hits: (q === 'Dacia' ? DACIA : FORD).map(nameHit), degraded: false })
      ),
    });
  };
  // The GraphQL error carries the code; the message names the refusal.
  const invalid = (message: RegExp) => ({
    extensions: { code: 'INVALID_INPUT' },
    message: expect.stringMatching(message),
  });
  const MISMATCH = /^cursor\/filter mismatch; restart pagination$/;

  it('refuses a cursor with another page size instead of skipping rows', async () => {
    const query = companiesQuery(twoNamesRepo());
    const first = await query({ q: 'Ford', sort: 'NAME', first: 20 });
    expect(first.pageInfo.hasNextPage).toBe(true);
    await expect(
      query({ q: 'Ford', sort: 'NAME', first: 50, after: first.pageInfo.endCursor })
    ).rejects.toMatchObject(
      invalid(/^this cursor pages 20 companies at a time; request first: 20 or restart pagination$/)
    );
    // The same page size continues exactly where the first page ended.
    const second = await query({
      q: 'Ford',
      sort: 'NAME',
      first: 20,
      after: first.pageInfo.endCursor,
    });
    expect(cuisOf(second)).toEqual(FORD.slice(20, 40));
  });

  it('compares the effective page size: two requests above the maximum both page by 100', async () => {
    const many = Array.from({ length: 250 }, (_, i) => String(20_000 + i));
    const query = companiesQuery(pagingRepo(many));
    const first = await query({ first: 150 });
    const second = await query({ first: 120, after: first.pageInfo.endCursor });
    expect(cuisOf(second)).toEqual(many.slice(100, 200));
  });

  it('refuses one search’s cursor for another search', async () => {
    const query = companiesQuery(twoNamesRepo());
    const ford = await query({ q: 'Ford', sort: 'NAME', first: 20 });
    await expect(
      query({ q: 'Dacia', sort: 'NAME', first: 20, after: ford.pageInfo.endCursor })
    ).rejects.toMatchObject(invalid(MISMATCH));
    // Dacia from its own start is complete: rows 1–20, then 21–40.
    const dacia1 = await query({ q: 'Dacia', sort: 'NAME', first: 20 });
    const dacia2 = await query({
      q: 'Dacia',
      sort: 'NAME',
      first: 20,
      after: dacia1.pageInfo.endCursor,
    });
    expect([...cuisOf(dacia1), ...cuisOf(dacia2)]).toEqual(DACIA);
  });

  it('refuses a name-query cursor on the unsearched list, and the reverse', async () => {
    const query = companiesQuery(twoNamesRepo());
    const ford = await query({ q: 'Ford', first: 20 });
    await expect(query({ first: 20, after: ford.pageInfo.endCursor })).rejects.toMatchObject(
      invalid(MISMATCH)
    );
    const all = await query({ first: 20 });
    await expect(
      query({ q: 'Ford', first: 20, after: all.pageInfo.endCursor })
    ).rejects.toMatchObject(invalid(MISMATCH));
  });

  it('treats a blank name query as no query, as the candidate resolution does', async () => {
    const query = companiesQuery(twoNamesRepo());
    const all = await query({ first: 20 });
    const next = await query({ q: '   ', first: 20, after: all.pageInfo.endCursor });
    expect(cuisOf(next)).toEqual([...FORD, ...DACIA].slice(20, 40));
  });

  /** A cursor as issued before these bindings: the same envelope with only [page, scope] keys. */
  const legacyOf = (cursor: string | null) => {
    const issued = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const legacy = issued.replace(
      /"keys":\["([^"]*)","([^"]*)"(,"[^"]*")*\]/u,
      '"keys":["$1","$2"]'
    );
    expect(legacy).not.toBe(issued);
    return Buffer.from(legacy, 'utf8').toString('base64url');
  };

  it('refuses cursors issued before these bindings', async () => {
    const query = companiesQuery(twoNamesRepo());
    // An unsearched one keeps its filter hash and lacks the new keys: malformed.
    const all = await query({ first: 20 });
    await expect(
      query({ first: 20, after: legacyOf(all.pageInfo.endCursor) })
    ).rejects.toMatchObject(invalid(/^malformed cursor; restart pagination$/));
    // A searched one carried no name query in its hash: a filter mismatch for that search.
    await expect(
      query({ q: 'Ford', first: 20, after: legacyOf(all.pageInfo.endCursor) })
    ).rejects.toMatchObject(invalid(MISMATCH));
  });

  it('refuses a continuation when the name candidates changed under the same scope', async () => {
    // The search index answers the first page; its bounded fallback answers the next with other candidates.
    const answers = [FORD, [...FORD.slice(0, 10), ...FORD.slice(20)]];
    let call = 0;
    const base = pagingRepo([...FORD, ...DACIA]);
    const repo = stubRepo({
      ...base,
      resolveByName: vi.fn(async () => {
        const hits = answers[Math.min(call, answers.length - 1)] ?? [];
        call += 1;
        return ok({ hits: hits.map(nameHit), degraded: call > 1 });
      }),
    });
    const query = companiesQuery(repo);
    const first = await query({ q: 'Ford', first: 20 });
    expect(cuisOf(first)).toEqual(FORD.slice(0, 20));
    await expect(
      query({ q: 'Ford', first: 20, after: first.pageInfo.endCursor })
    ).rejects.toMatchObject(
      invalid(
        /^the companies matching this name changed since the cursor was issued; restart pagination$/
      )
    );
  });

  it('continues an unchanged candidate set and refuses an interior edge cursor', async () => {
    const query = companiesQuery(twoNamesRepo());
    const first = await query({ q: 'Ford', first: 20 });
    // edges[0] would resume at row 21 and skip rows 2-20: refused.
    await expect(
      query({ q: 'Ford', first: 20, after: first.edges[0]?.cursor })
    ).rejects.toMatchObject(
      invalid(/^only the last edge of a full page continues this list; pass pageInfo\.endCursor$/)
    );
    expect(first.pageInfo.endCursor).toBe(first.edges[19]?.cursor);
    const second = await query({ q: 'Ford', first: 20, after: first.pageInfo.endCursor });
    expect(cuisOf(second)).toEqual(FORD.slice(20, 40));
  });
});

/**
 * The MCP list pages by explicit page/pageSize; a name query's candidates are
 * bound the same way (meta.nameCandidates back as nameCandidates), so a
 * changed candidate set refuses the page instead of skipping companies.
 */
describe('MCP list_companies name-candidate binding', () => {
  const FORD = CANDIDATES.slice(0, 50);
  const listTool = (repo: CompaniesRepository) => {
    const tool = makeCompaniesMcpTools({
      repo,
      flowsRepo: stubFlows(),
      meili: null,
      clientBaseUrl: 'https://transparenta.test',
      hubStats: { get: vi.fn() },
    }).find((t) => t.name === 'list_companies');
    if (tool === undefined) throw new Error('no list_companies tool');
    return tool;
  };
  const answering = (answers: readonly (readonly string[])[]) => {
    let call = 0;
    const base = pagingRepo(FORD);
    return stubRepo({
      ...base,
      resolveByName: vi.fn(async () => {
        const hits = answers[Math.min(call, answers.length - 1)] ?? [];
        call += 1;
        return ok({ hits: hits.map(nameHit), degraded: call > 1 });
      }),
    });
  };
  interface ListOut {
    ok: boolean;
    error?: string;
    items?: readonly { cui: string }[];
    meta?: { registryScope: string; nameCandidates?: string };
  }

  it('refuses the next page when the name candidates changed', async () => {
    const tool = listTool(answering([FORD, [...FORD.slice(0, 10), ...FORD.slice(20)]]));
    const first = (await tool.handler({ q: 'Ford', pageSize: 20 })) as unknown as ListOut;
    expect(first.items?.map((r) => r.cui)).toEqual(FORD.slice(0, 20));
    expect(first.meta?.nameCandidates).toMatch(/^c/u);
    const second = (await tool.handler({
      q: 'Ford',
      page: 2,
      pageSize: 20,
      registryScope: first.meta?.registryScope,
      nameCandidates: first.meta?.nameCandidates,
    })) as unknown as ListOut;
    expect(second).toMatchObject({
      ok: false,
      error:
        'the companies matching this name changed since the cursor was issued; restart pagination',
    });
  });

  it('continues an unchanged candidate set, and binds nothing without a name query', async () => {
    const tool = listTool(answering([FORD]));
    const first = (await tool.handler({ q: 'Ford', pageSize: 20 })) as unknown as ListOut;
    const second = (await tool.handler({
      q: 'Ford',
      page: 2,
      pageSize: 20,
      registryScope: first.meta?.registryScope,
      nameCandidates: first.meta?.nameCandidates,
    })) as unknown as ListOut;
    expect(second.items?.map((r) => r.cui)).toEqual(FORD.slice(20, 40));
    const unsearched = (await tool.handler({ pageSize: 20 })) as unknown as ListOut;
    expect(unsearched.meta?.nameCandidates).toBeUndefined();
  });
});
