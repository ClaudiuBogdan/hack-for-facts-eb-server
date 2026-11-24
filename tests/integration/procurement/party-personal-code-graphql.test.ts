/**
 * "Never a CNP" on the legacy GraphQL record paths: a party name the source wrote with a personal
 * numeric code is withheld (name and displayName null; displayName falls back to a served code),
 * on contract lists and their highlights, the contract and procedure details, modifications and
 * supplier records. An ordinary name is served unchanged. The name is a synthetic code, built
 * for the test.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';

import {
  CODED_NAME,
  ORDINARY_NAME,
  SYNTHETIC_CNP,
} from '../../fixtures/procurement/personal-code.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type {
  ProcurementContract,
  ProcurementModification,
  ProcurementProcedure,
} from '@/modules/procurement/core/types.js';

const KERNEL_STUB_SDL = /* GraphQL */ `
  scalar Date
  scalar SIRUTA
  type Query {
    _empty: String
  }
`;

const contract = (id: string, supplierCui: string | null, supplierName: string) =>
  ({
    contractId: id,
    authorityCui: '4305857',
    authorityName: id === '2' ? `PRIMARIA ${SYNTHETIC_CNP}` : 'COMUNA EXEMPLU',
    supplierCui,
    supplierName,
  }) as unknown as ProcurementContract;

/** 1: ordinary; 2: coded names, no supplier code; 3: coded name with a public code. */
const CONTRACTS = [
  contract('1', '14399840', ORDINARY_NAME),
  contract('2', null, CODED_NAME),
  contract('3', '14399840', CODED_NAME),
];

const modification = (id: string, supplierName: string) =>
  ({
    modificationId: id,
    contractId: null,
    authorityCui: '4305857',
    authorityName: 'COMUNA EXEMPLU',
    supplierCui: null,
    supplierName,
  }) as unknown as ProcurementModification;

const procedure = {
  procedureId: '9',
  authorityCui: '4305857',
  authorityName: `COMUNA ${SYNTHETIC_CNP}`,
} as unknown as ProcurementProcedure;

const page = <T>(items: readonly T[], highlights?: unknown) =>
  Promise.resolve(
    ok({
      items,
      total: items.length,
      estimated: false,
      ...(highlights !== undefined && { highlights }),
    })
  );

const repo = {
  searchContractsOffset: () =>
    page(CONTRACTS, [
      { id: '1', supplierName: `⟦FIRMA⟧ EXEMPLU SRL` },
      { id: '2', supplierName: `⟦POPESCU⟧ ION ${SYNTHETIC_CNP}` },
    ]),
  searchModificationsOffset: () =>
    page([modification('7', CODED_NAME), modification('8', ORDINARY_NAME)]),
  getContractDetail: (id: string) =>
    Promise.resolve(
      ok({
        contract: CONTRACTS.find((c) => c.contractId === id),
        procedure: null,
        duplicates: [],
        ted: null,
      })
    ),
  getProcedureDetail: () =>
    Promise.resolve(
      ok({ procedure, contracts: CONTRACTS, perLotWinners: null, duplicates: [], ted: null })
    ),
  supplierRecords: () =>
    Promise.resolve(
      ok({
        total: null,
        hasNextPage: false,
        endCursor: null,
        edges: CONTRACTS.map((c) => ({
          cursor: `c${c.contractId}`,
          node: { grain: 'procurement_contract', contract: c },
        })),
      })
    ),
} as unknown as ProcurementRepo;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (): Promise<FastifyInstance> => {
  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeGraphQLPlugin({
      schema: [KERNEL_STUB_SDL, procurementTypeDefs],
      resolvers: [
        makeProcurementResolvers({
          repo,
          // No active build: procedure canonicality answers null without a read.
          analysis: {
            procedureCanonicalityBuild: () => Promise.resolve(ok(null)),
          } as unknown as AnalysisRepo,
        }) as unknown as Record<string, never>,
      ],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await instance.ready();
  return instance;
};

const post = async (query: string) => {
  app ??= await build();
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  const body = res.json<{ data?: Record<string, unknown>; errors?: unknown }>();
  expect(body.errors).toBeUndefined();
  return { raw: res.body, data: body.data ?? {} };
};

const PARTY = 'cui name displayName';

/** id → [authority name, supplier {cui, name, displayName}]. */
const partiesOf = (items: readonly Record<string, unknown>[]) =>
  Object.fromEntries(
    items.map((item) => [
      String(item['id']),
      [(item['authority'] as { name: string | null }).name, item['supplier']],
    ])
  );

const EXPECTED_CONTRACT_PARTIES = {
  '1': ['COMUNA EXEMPLU', { cui: '14399840', name: ORDINARY_NAME, displayName: ORDINARY_NAME }],
  '2': [null, { cui: null, name: null, displayName: null }],
  // The name goes, the public code stays (and is what displayName shows).
  '3': ['COMUNA EXEMPLU', { cui: '14399840', name: null, displayName: '14399840' }],
};

describe('legacy GraphQL party names carrying a personal code (never a CNP)', () => {
  it('procurementContracts withholds the coded names and their highlight fragments', async () => {
    const { raw, data } = await post(/* GraphQL */ `
      query {
        procurementContracts(pageSize: 10) {
          items { id authority { ${PARTY} } supplier { ${PARTY} } }
          highlights { id supplierName }
        }
      }
    `);
    const result = data['procurementContracts'] as {
      items: Record<string, unknown>[];
      highlights: unknown[];
    };
    expect(partiesOf(result.items)).toEqual(EXPECTED_CONTRACT_PARTIES);
    expect(result.highlights).toEqual([
      { id: '1', supplierName: '⟦FIRMA⟧ EXEMPLU SRL' },
      { id: '2', supplierName: null },
    ]);
    expect(raw).not.toContain(SYNTHETIC_CNP);
  });

  it('procurementContract (detail) withholds a coded supplier name', async () => {
    for (const [id, expected] of Object.entries(EXPECTED_CONTRACT_PARTIES)) {
      const { raw, data } = await post(/* GraphQL */ `
        query {
          procurementContract(id: "${id}") {
            contract { id authority { ${PARTY} } supplier { ${PARTY} } }
          }
        }
      `);
      const detail = data['procurementContract'] as { contract: Record<string, unknown> };
      expect(partiesOf([detail.contract])).toEqual({ [id]: expected });
      expect(raw).not.toContain(SYNTHETIC_CNP);
    }
  });

  it('procurementProcedure withholds a coded authority name and its contracts’ coded names', async () => {
    const { raw, data } = await post(/* GraphQL */ `
      query {
        procurementProcedure(id: "9") {
          procedure { id authority { ${PARTY} } }
          contracts { id authority { ${PARTY} } supplier { ${PARTY} } }
        }
      }
    `);
    const detail = data['procurementProcedure'] as {
      procedure: { authority: Record<string, unknown> };
      contracts: Record<string, unknown>[];
    };
    expect(detail.procedure.authority).toEqual({
      cui: '4305857',
      name: null,
      displayName: '4305857',
    });
    expect(partiesOf(detail.contracts)).toEqual(EXPECTED_CONTRACT_PARTIES);
    expect(raw).not.toContain(SYNTHETIC_CNP);
  });

  it('procurementModifications withholds a coded supplier name, not an ordinary one', async () => {
    const { raw, data } = await post(/* GraphQL */ `
      query {
        procurementModifications(pageSize: 10) {
          items { id authority { ${PARTY} } supplier { ${PARTY} } }
        }
      }
    `);
    const result = data['procurementModifications'] as { items: Record<string, unknown>[] };
    expect(partiesOf(result.items)).toEqual({
      '7': ['COMUNA EXEMPLU', { cui: null, name: null, displayName: null }],
      '8': ['COMUNA EXEMPLU', { cui: null, name: ORDINARY_NAME, displayName: ORDINARY_NAME }],
    });
    expect(raw).not.toContain(SYNTHETIC_CNP);
  });

  it('procurementSupplierRecords withholds a coded contract supplier name', async () => {
    const { raw, data } = await post(/* GraphQL */ `
      query {
        procurementSupplierRecords(supplierCui: "14399840", first: 10) {
          edges { node { ... on ProcurementContract { id authority { ${PARTY} } supplier { ${PARTY} } } } }
        }
      }
    `);
    const result = data['procurementSupplierRecords'] as {
      edges: { node: Record<string, unknown> }[];
    };
    expect(partiesOf(result.edges.map((edge) => edge.node))).toEqual(EXPECTED_CONTRACT_PARTIES);
    expect(raw).not.toContain(SYNTHETIC_CNP);
  });
});
