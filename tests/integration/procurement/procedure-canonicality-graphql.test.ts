/**
 * Procedure canonicality (P36), EXECUTED over the real GraphQL surface (the same
 * `makeGraphQLPlugin` the app mounts) against fake repositories.
 *
 * The resolver used to hard-code `isCanonical: true` / `dupGroupId: null`, so
 * a SEAP award linked to its e-licitatie notice by rule A (non-canonical in the
 * active generation) read as canonical. Every path that returns a procedure
 * node is exercised: the procedure list, the procedure detail and a contract's
 * procedure. Unknown stays null: a backend failure carries an error and leaves
 * the rest of the node intact.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';
import { databaseError } from '@/modules/shared/index.js';

import type {
  AnalysisRepo,
  ProcedureCanonicality,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type {
  ContractDetail,
  DuplicateRef,
  ProcedureDetail,
  ProcurementProcedure,
} from '@/modules/procurement/core/types.js';

const KERNEL_STUB_SDL = /* GraphQL */ `
  scalar Date
  scalar SIRUTA
  type Query {
    _empty: String
  }
`;

const procedure = (procedureId: string, sourceSystem: string): ProcurementProcedure => ({
  procedureId,
  sourceSystem,
  sourceUrl: null,
  noticeNo: 'CAN1160189',
  noticeKind: null,
  procedureType: null,
  contractKind: null,
  title: 'Furnizare',
  authorityCui: '3551942',
  authorityName: 'Spitalul',
  cpvCode: null,
  cpvDivisionCode: null,
  estimatedValueRon: null,
  awardedValueRon: '97092.00',
  currency: 'RON',
  status: 'awarded',
  countyName: null,
  publicationDate: '2025-12-30',
  stateDate: null,
  value: {
    valueState: 'official_exact',
    valueStateRule: null,
    valueAccepted: true,
    valueRonComparable: '97092.00',
    valueComparableBasis: null,
    valueRulesVersion: 9,
    valueResolvedAt: null,
  },
});

const NATIVE = procedure('347436', 'elicitatie');
const LINKED = procedure('573731', 'seap_notice');
const UNLINKED = procedure('900001', 'elicitatie');

/** Build 16 as the active generation publishes it. */
const ACTIVE = new Map<string, ProcedureCanonicality>([
  ['347436', { isCanonical: true, dupGroupId: '347436' }],
  ['573731', { isCanonical: false, dupGroupId: '347436' }],
  ['900001', { isCanonical: true, dupGroupId: null }],
]);
const GROUPS = new Map<string, readonly DuplicateRef[]>([
  ['347436', [{ sourceSystem: 'seap_notice', id: '573731' }]],
  ['573731', [{ sourceSystem: 'elicitatie', id: '347436' }]],
  ['900001', []],
]);

const detail = (p: ProcurementProcedure): ProcedureDetail => ({
  procedure: p,
  contracts: [],
  perLotWinners: null,
  duplicates: [],
  ted: null,
});

const repo = {
  searchProceduresOffset: () =>
    Promise.resolve(ok({ items: [NATIVE, LINKED, UNLINKED], total: 3, estimated: false })),
  getProcedureDetail: (id: string) =>
    Promise.resolve(
      ok([NATIVE, LINKED, UNLINKED].map(detail).find((d) => d.procedure.procedureId === id) ?? null)
    ),
  getContractDetail: () => Promise.resolve(ok({ procedure: LINKED } as unknown as ContractDetail)),
} as unknown as ProcurementRepo;

interface AnalysisFake {
  readonly analysis: AnalysisRepo;
  readonly canonicalityCalls: (readonly string[])[];
}

const analysisFake = (mode: 'active' | 'down' | 'unpublished'): AnalysisFake => {
  const canonicalityCalls: (readonly string[])[] = [];
  const down = databaseError('clickhouse unreachable: connect ECONNREFUSED');
  const analysis = {
    procedureCanonicality: (ids: readonly string[]) => {
      canonicalityCalls.push(ids);
      if (mode === 'down') return Promise.resolve(err(down));
      if (mode === 'unpublished') return Promise.resolve(ok(null));
      return Promise.resolve(
        ok(new Map(ids.flatMap((id) => (ACTIVE.has(id) ? [[id, ACTIVE.get(id)]] : []))))
      );
    },
    procedureDuplicates: (id: string) => {
      if (mode === 'down') return Promise.resolve(err(down));
      if (mode === 'unpublished') return Promise.resolve(ok(null));
      return Promise.resolve(ok(GROUPS.get(id) ?? null));
    },
  } as unknown as AnalysisRepo;
  return { analysis, canonicalityCalls };
};

let app: FastifyInstance | undefined;

const buildApp = async (analysis: AnalysisRepo): Promise<FastifyInstance> => {
  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeGraphQLPlugin({
      schema: [KERNEL_STUB_SDL, procurementTypeDefs],
      resolvers: [makeProcurementResolvers({ repo, analysis }) as unknown as Record<string, never>],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await instance.ready();
  return instance;
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { readonly message: string; readonly path?: readonly unknown[] }[];
}

const post = async (query: string): Promise<GqlResponse> => {
  if (app === undefined) throw new Error('app not built');
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  expect(res.statusCode).toBe(200);
  return res.json<GqlResponse>();
};

const LIST = /* GraphQL */ `
  {
    procurementProcedures {
      items {
        id
        sourceSystem
        isCanonical
        dupGroupId
      }
    }
  }
`;
const DETAIL = (id: string) => /* GraphQL */ `
  {
    procurementProcedure(id: "${id}") {
      procedure {
        id
        noticeNo
        isCanonical
        dupGroupId
      }
      duplicates {
        sourceSystem
        id
      }
    }
  }
`;
const CONTRACT = /* GraphQL */ `
  {
    procurementContract(id: "1") {
      procedure {
        id
        isCanonical
        dupGroupId
      }
    }
  }
`;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('procedure canonicality follows the active generation', () => {
  it('serves the list from one batched read', async () => {
    const fake = analysisFake('active');
    app = await buildApp(fake.analysis);
    const body = await post(LIST);
    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementProcedures']).toEqual({
      items: [
        { id: '347436', sourceSystem: 'elicitatie', isCanonical: true, dupGroupId: '347436' },
        { id: '573731', sourceSystem: 'seap_notice', isCanonical: false, dupGroupId: '347436' },
        { id: '900001', sourceSystem: 'elicitatie', isCanonical: true, dupGroupId: null },
      ],
    });
    // Both fields of all three nodes: ONE read with the three ids.
    expect(fake.canonicalityCalls).toEqual([['347436', '573731', '900001']]);
  });

  it('serves the linked observation and its group on the detail', async () => {
    app = await buildApp(analysisFake('active').analysis);
    const linked = await post(DETAIL('573731'));
    expect(linked.errors).toBeUndefined();
    expect(linked.data?.['procurementProcedure']).toEqual({
      procedure: { id: '573731', noticeNo: 'CAN1160189', isCanonical: false, dupGroupId: '347436' },
      duplicates: [{ sourceSystem: 'elicitatie', id: '347436' }],
    });
    const native = await post(DETAIL('347436'));
    expect(native.data?.['procurementProcedure']).toMatchObject({
      procedure: { isCanonical: true, dupGroupId: '347436' },
      duplicates: [{ sourceSystem: 'seap_notice', id: '573731' }],
    });
    const ungrouped = await post(DETAIL('900001'));
    expect(ungrouped.data?.['procurementProcedure']).toMatchObject({
      procedure: { isCanonical: true, dupGroupId: null },
      duplicates: [],
    });
  });

  it("serves a contract's procedure through the same resolver", async () => {
    app = await buildApp(analysisFake('active').analysis);
    const body = await post(CONTRACT);
    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementContract']).toEqual({
      procedure: { id: '573731', isCanonical: false, dupGroupId: '347436' },
    });
  });

  it('answers null, not true, for a procedure the generation does not hold', async () => {
    const outside = procedure('999999', 'elicitatie');
    const missingRepo = {
      ...repo,
      getProcedureDetail: () => Promise.resolve(ok(detail(outside))),
    } as unknown as ProcurementRepo;
    const instance = fastifyLib({ logger: false });
    await instance.register(
      makeGraphQLPlugin({
        schema: [KERNEL_STUB_SDL, procurementTypeDefs],
        resolvers: [
          makeProcurementResolvers({
            repo: missingRepo,
            analysis: analysisFake('active').analysis,
          }) as unknown as Record<string, never>,
        ],
        isProduction: false,
        enableGraphiQL: false,
      })
    );
    await instance.ready();
    app = instance;
    const body = await post(DETAIL('999999'));
    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementProcedure']).toEqual({
      procedure: { id: '999999', noticeNo: 'CAN1160189', isCanonical: null, dupGroupId: null },
      duplicates: null,
    });
  });

  it('answers null when no generation is published', async () => {
    app = await buildApp(analysisFake('unpublished').analysis);
    const body = await post(DETAIL('573731'));
    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementProcedure']).toEqual({
      procedure: { id: '573731', noticeNo: 'CAN1160189', isCanonical: null, dupGroupId: null },
      duplicates: null,
    });
  });

  it('reports a backend failure as an error on the field, keeping the node', async () => {
    app = await buildApp(analysisFake('down').analysis);
    const body = await post(DETAIL('573731'));
    expect(body.data?.['procurementProcedure']).toEqual({
      procedure: { id: '573731', noticeNo: 'CAN1160189', isCanonical: null, dupGroupId: null },
      duplicates: null,
    });
    const paths = (body.errors ?? []).map((e) => (e.path ?? []).join('.'));
    expect(paths.sort()).toEqual([
      'procurementProcedure.duplicates',
      'procurementProcedure.procedure.dupGroupId',
      'procurementProcedure.procedure.isCanonical',
    ]);
    const list = await post(LIST);
    expect(list.data?.['procurementProcedures']).toMatchObject({
      items: [
        { id: '347436', isCanonical: null },
        { id: '573731', isCanonical: null },
        { id: '900001', isCanonical: null },
      ],
    });
    expect(list.errors?.length).toBe(6);
  });
});
