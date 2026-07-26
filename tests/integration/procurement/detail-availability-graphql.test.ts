/**
 * `ProcurementDetailAvailability` serialization, EXECUTED over the real GraphQL
 * surface (the same `makeGraphQLPlugin` the app mounts), against a fake repo.
 *
 * This has to be executable coverage, because neither half of the bug is visible
 * on its own: the domain emits lowercase internal values
 * (`'not_available_for_source'`), the SDL declares SCREAMING_SNAKE enum names,
 * and a mapper or component test sees whichever side it was written against.
 * The failure only exists at serialization time — and because
 * `detailAvailability` is NON-NULL, the error bubbles up and nulls the ENTIRE
 * `procurementDirectAcquisition` bundle. Every seap_da / seap_dan detail page
 * (the majority of the direct-acquisition grain) died that way, over a value
 * that was correct.
 *
 * So: one request per internal value, asserting both `errors` and the bundle.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type {
  DaDetailAvailability,
  DirectAcquisitionDetail,
  ProcurementDirectAcquisition,
} from '@/modules/procurement/core/types.js';

/**
 * The kernel types the procurement slice's SDL references. Only these two, so
 * the stub stays this small — the slice under test is the real, unmodified one.
 */
const KERNEL_STUB_SDL = /* GraphQL */ `
  scalar Date
  scalar SIRUTA
  type Query {
    _empty: String
  }
`;

const DA_ID = '71690399';

/** A canonical seap_dan row: the family with no item-detail source in existence. */
const directAcquisition = {
  daId: DA_ID,
  sourceSystem: 'seap_dan',
  sourceUrl: 'https://data.gov.ro/dataset/achizitii-directe/resource/2019.xlsx',
  uniqueCode: 'DA0001',
  title: 'Furnizare hartie',
  authorityCui: '4350505',
  authorityName: 'Primaria Exemplu',
  supplierCui: '29852817',
  supplierName: 'Furnizor SRL',
  valueRon: '1200.00',
  currency: 'RON',
  status: 'finalized',
  isCanonical: true,
  dupGroupId: null,
} as unknown as ProcurementDirectAcquisition;

const bundle = (detailAvailability: DaDetailAvailability): DirectAcquisitionDetail => ({
  directAcquisition,
  duplicates: [],
  // Null for every state but AVAILABLE. The body is not what this suite is
  // about, and the SDL types `detail` nullable, so AVAILABLE keeps it null too.
  detail: null,
  detailAvailability,
});

const QUERY = /* GraphQL */ `
  query {
    procurementDirectAcquisition(id: "${DA_ID}") {
      detailAvailability
      duplicates {
        id
      }
      directAcquisition {
        id
        sourceSystem
        sourceUrl
        valueRon
      }
    }
  }
`;

const AVAILABILITY_INTROSPECTION = /* GraphQL */ `
  query {
    __type(name: "ProcurementDetailAvailability") {
      enumValues {
        name
      }
    }
  }
`;

/** internal domain value → the GraphQL enum name the client is promised. */
const CASES: readonly (readonly [DaDetailAvailability, string])[] = [
  ['available', 'AVAILABLE'],
  ['not_captured', 'NOT_CAPTURED'],
  ['not_available_for_source', 'NOT_AVAILABLE_FOR_SOURCE'],
  ['temporarily_unavailable', 'TEMPORARILY_UNAVAILABLE'],
];

let app: FastifyInstance;

const buildApp = async (detailAvailability: DaDetailAvailability): Promise<FastifyInstance> => {
  const repo = {
    getDirectAcquisitionDetail: () => Promise.resolve(ok(bundle(detailAvailability))),
  } as unknown as ProcurementRepo;

  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeGraphQLPlugin({
      schema: [KERNEL_STUB_SDL, procurementTypeDefs],
      resolvers: [
        makeProcurementResolvers({ repo, analysis: {} as AnalysisRepo }) as unknown as Record<
          string,
          never
        >,
      ],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await instance.ready();
  return instance;
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { readonly message: string }[];
}

const post = async (instance: FastifyInstance, query: string): Promise<GqlResponse> => {
  const res = await instance.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  expect(res.statusCode).toBe(200);
  return res.json<GqlResponse>();
};

afterEach(async () => {
  await app?.close();
});

describe('ProcurementDetailAvailability serializes every internal value', () => {
  it.each(CASES)('%s → %s, with the bundle intact', async (internal, enumName) => {
    app = await buildApp(internal);
    const body = await post(app, QUERY);

    // Assert errors FIRST and by content: the bubbled non-null error is the only
    // signal of the outage — `data` just goes null, which reads like a 404.
    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementDirectAcquisition']).toEqual({
      detailAvailability: enumName,
      duplicates: [],
      directAcquisition: {
        id: DA_ID,
        sourceSystem: 'seap_dan',
        sourceUrl: 'https://data.gov.ro/dataset/achizitii-directe/resource/2019.xlsx',
        valueRon: '1200.00',
      },
    });
  });

  it('covers every value the schema declares (a new member without a mapping fails here)', async () => {
    app = await buildApp('available');
    const body = await post(app, AVAILABILITY_INTROSPECTION);

    const declared = (
      body.data?.['__type'] as { enumValues: readonly { name: string }[] } | undefined
    )?.enumValues.map((v) => v.name);
    expect([...(declared ?? [])].sort()).toEqual([...CASES.map(([, name]) => name)].sort());
  });
});
