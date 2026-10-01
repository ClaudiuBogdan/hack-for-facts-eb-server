import { GraphQLError } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { parseAnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import { analysisRecords, analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';

import { BUILD_ID, fakeAnalysisRepo, generation, verdict } from './analysis-fakes.js';

import type {
  AnalysisRecordRow,
  AnalysisRepo,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type { ProcurementContract } from '@/modules/procurement/core/types.js';

const row = (over: Partial<AnalysisRecordRow> = {}): AnalysisRecordRow => ({
  id: '17',
  date: '2025-11-03',
  title: 'Furnituri de birou',
  authorityCui: '4270740',
  authorityName: 'Primaria Sibiu',
  supplierCui: '14399840',
  supplierName: 'Firma SRL',
  valueRon: '1234.56',
  status: 'finalized',
  recordKind: null,
  cpvCode: '30192700',
  ...over,
});

const DA = { grain: 'direct_acquisition' as const, buyerCounty: 'SB' };

describe('analysis build pin', () => {
  it('serves a request pinned to the active build', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisStats({ analysisRepo: repo }, { scope: DA, build: BUILD_ID });
    expect(result.isOk()).toBe(true);
  });

  it('refuses a pin that is not the active build, naming the field', async () => {
    const { repo, calls } = fakeAnalysisRepo();
    const result = await analysisStats({ analysisRepo: repo }, { scope: DA, build: '12' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'build' });
    expect(result._unsafeUnwrapErr().message).toContain(`active build (${BUILD_ID})`);
    expect(calls).toEqual([]);
  });

  it('refuses a malformed pin before reading the generation', async () => {
    const { repo } = fakeAnalysisRepo({ generation: null });
    const result = await analysisRecords({ analysisRepo: repo }, { scope: DA, build: '13; drop' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'build' });
  });
});

describe('analysisRecords', () => {
  it('pages the rows the stats block counts, on its build, with its total', async () => {
    const { repo, calls } = fakeAnalysisRepo({ records: { total: '3948', rows: [row()] } });
    const result = await analysisRecords(
      { analysisRepo: repo },
      { scope: DA, build: BUILD_ID, sort: 'value_desc', page: 3, pageSize: 25 }
    );
    const page = result._unsafeUnwrap();
    expect(page).toMatchObject({
      grain: 'direct_acquisition',
      total: '3948',
      page: 3,
      pageSize: 25,
    });
    expect(page.items).toEqual([row()]);
    expect(page.meta).toMatchObject({ answerability: 'served', buildId: BUILD_ID });
    expect(calls).toEqual([
      { method: 'recordsFor', grain: 'direct_acquisition', params: ['value_desc', 50, 25] },
    ]);
  });

  it('withholds natural-person identifiers but keeps the published names', async () => {
    const { repo } = fakeAnalysisRepo({
      records: {
        total: '1',
        rows: [row({ supplierCui: '1840101123456', supplierName: 'Ion Pop' })],
      },
    });
    const page = (await analysisRecords({ analysisRepo: repo }, { scope: DA }))._unsafeUnwrap();
    expect(page.items[0]).toMatchObject({ supplierCui: null, supplierName: 'Ion Pop' });
  });

  it('nulls money and refuses a value order where the spend gate withholds money', async () => {
    // LIVE_LIKE_QUALITY abstains contract spend.
    const { repo } = fakeAnalysisRepo({ records: { total: '1', rows: [row()] } });
    const scope = { grain: 'contract' as const, recordKind: 'contract_award' as const };
    const dated = (await analysisRecords({ analysisRepo: repo }, { scope }))._unsafeUnwrap();
    expect(dated.items[0]?.valueRon).toBeNull();
    expect(dated.meta.caveats.join(' ')).toContain('consortium award lists once per member');
    const valued = await analysisRecords({ analysisRepo: repo }, { scope, sort: 'value_desc' });
    expect(valued._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'sort' });
  });

  it('lists nothing where the stats block abstains (geo gate), without reading', async () => {
    const { repo, calls } = fakeAnalysisRepo({
      quality: { direct_acquisition: verdict({ geo: 'abstain' }) },
    });
    const page = (await analysisRecords({ analysisRepo: repo }, { scope: DA }))._unsafeUnwrap();
    expect(page).toMatchObject({ total: null, items: [], meta: { answerability: 'abstained' } });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ scope: { buyerCounty: 'SB' } }, 'grain'],
    [{ scope: { grain: 'procedure' as const } }, 'grain'],
    [{ scope: DA, sort: 'relevance' }, 'sort'],
    [{ scope: DA, page: 0 }, 'page'],
    [{ scope: DA, pageSize: 101 }, 'pageSize'],
    [{ scope: DA, page: 401, pageSize: 25 }, 'page'],
  ])('refuses %o on field %s', async (input, field) => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisRecords({ analysisRepo: repo }, input);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
  });

  it('serves the last row of the 10 000-row window', async () => {
    const { repo, calls } = fakeAnalysisRepo();
    const result = await analysisRecords({ analysisRepo: repo }, { scope: DA, page: 400 });
    expect(result.isOk()).toBe(true);
    expect(calls[0]?.params).toEqual(['date_desc', 9975, 25]);
  });
});

describe('scope identifiers', () => {
  it.each(['supplierCui', 'authorityCui'])('refuses a withheld %s as a key', (field) => {
    const result = parseAnalysisScope({ [field]: '1840101123456' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
  });
});

interface RecordsResolver {
  procurementRecords(
    root: unknown,
    args: { scope: Readonly<Record<string, unknown>>; build?: string }
  ): Promise<{ readonly items: readonly Record<string, unknown>[]; readonly total: string | null }>;
  procurementStats(root: unknown, args: { scope: unknown; build?: string }): Promise<unknown>;
}

const surfaces = (analysis: AnalysisRepo, repo: ProcurementRepo) => {
  const resolvers = makeProcurementResolvers({ repo, analysis }) as {
    readonly Query: RecordsResolver;
  };
  const tool = makeProcurementMcpTools({ repo, analysis, clientBaseUrl: 'https://x.test' }).find(
    (candidate) => candidate.name === 'aggregate_procurement'
  );
  if (tool === undefined) throw new Error('aggregate_procurement is not registered');
  return { query: resolvers.Query, tool };
};

describe('procurementRecords transport', () => {
  const contract = (id: string): ProcurementContract =>
    ({
      contractId: id,
      displayTitle: { text: `Contract ${id}`, source: 'procedure', sourceUrl: null },
    }) as unknown as ProcurementContract;

  it('hydrates contract display titles by id without changing rows or money', async () => {
    const analysis = fakeAnalysisRepo({
      // Build 13 publishes framework roles: the frameworks page names its population.
      generation: generation(
        { contract: verdict() },
        { frameworkRole: true, supplierGeography: true }
      ),
      records: {
        total: '2',
        rows: [row({ id: '1', title: null }), row({ id: '2', title: null, valueRon: null })],
      },
    }).repo;
    const repo = {
      contractsByIds: (ids: readonly string[]) =>
        Promise.resolve(
          ok(new Map(ids.filter((id) => id === '1').map((id) => [id, contract(id)])))
        ),
    } as unknown as ProcurementRepo;
    const { query } = surfaces(analysis, repo);
    const page = await query.procurementRecords(undefined, {
      scope: {
        grain: 'contract',
        recordKind: 'framework_agreement',
        frameworkRole: 'framework_ceiling',
      },
    });
    expect(page.total).toBe('2');
    expect(page.items.map((item) => [item['id'], item['valueRon']])).toEqual([
      ['1', '1234.56'],
      ['2', null],
    ]);
    expect(page.items[0]?.['displayTitle']).toMatchObject({ text: 'Contract 1' });
    // No production row for the second id: no label, never another row.
    expect(page.items[1]?.['displayTitle']).toBeNull();
    expect(page.items[0]?.['supplier']).toEqual({
      cui: '14399840',
      name: 'Firma SRL',
      displayName: 'Firma SRL',
    });
  });

  it('marks a stale pin with extensions.field = build', async () => {
    const analysis = fakeAnalysisRepo({ generation: generation() }).repo;
    const { query } = surfaces(analysis, {} as ProcurementRepo);
    const failure = await query
      .procurementStats(undefined, { scope: DA, build: '9' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GraphQLError);
    expect((failure as GraphQLError).extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'build',
    });
  });

  it('labels MCP contract records with the same display titles', async () => {
    const analysis = fakeAnalysisRepo({
      generation: generation({ contract: verdict() }),
      records: { total: '1', rows: [row({ id: '5', title: null })] },
    }).repo;
    const repo = {
      contractsByIds: () => Promise.resolve(ok(new Map([['5', contract('5')]]))),
    } as unknown as ProcurementRepo;
    const { tool } = surfaces(analysis, repo);
    const out = await tool.handler({ shape: 'records', scope: { grain: 'contract' } });
    expect(out.items).toEqual([
      {
        ...row({ id: '5', title: null }),
        displayTitle: { text: 'Contract 5', source: 'procedure', sourceUrl: null },
      },
    ]);
  });

  it('serves the same page through MCP shape=records', async () => {
    const analysis = fakeAnalysisRepo({ records: { total: '1', rows: [row()] } }).repo;
    const { tool } = surfaces(analysis, {} as ProcurementRepo);
    const out = await tool.handler({ shape: 'records', scope: DA, build: BUILD_ID, page: 2 });
    expect(out.ok).toBe(true);
    // A direct purchase has no display title to read: the ClickHouse row, labelled null.
    expect(out.items).toEqual([{ ...row(), displayTitle: null }]);
    const stale = await tool.handler({ shape: 'records', scope: DA, build: '1' });
    expect(stale).toMatchObject({ ok: false, errorType: 'InvalidInput' });
  });
});
