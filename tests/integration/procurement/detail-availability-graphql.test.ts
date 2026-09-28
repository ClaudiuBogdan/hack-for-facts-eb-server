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
  DaDetailBody,
  DaItem,
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

/** A canonical seap_dan row: served from a summary export. */
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

const buildApp = async (
  detailAvailability: DaDetailAvailability,
  detail: DaDetailBody | null = null
): Promise<FastifyInstance> => {
  const repo = {
    getDirectAcquisitionDetail: () =>
      Promise.resolve(ok({ ...bundle(detailAvailability), detail })),
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

const item = (daItemId: string, itemIndex: number): DaItem => ({
  daItemId,
  itemIndex,
  catalogItemCode: 'PAPER-A4',
  catalogItemName: 'Paper A4',
  catalogItemDescription: null,
  itemMeasureUnit: 'pack',
  cpvCode: '30197630-1',
  cpvText: 'Printing paper',
  itemQuantity: '2.0000',
  unitPrice: '10.2500',
  unitEstimatedPrice: '11.0000',
  catalogUnitPrice: '10.2500',
  lineValue: '20.5000',
  sourceUrl: 'https://e-licitatie.ro/pub/direct-acquisition/view/123',
});

const detailBody = (items: readonly DaItem[]): DaDetailBody => ({
  description: 'Office supplies',
  deliveryCondition: null,
  paymentCondition: null,
  contractTypeText: 'Supplies',
  isEuFunded: false,
  euFundText: null,
  caDecisionDate: null,
  caDecisionDeadline: null,
  supplierDecisionDate: null,
  supplierDecisionDeadline: null,
  caRejectionReason: null,
  supplierRejectionReason: null,
  correctionReason: null,
  documentCount: 0,
  itemCount: items.length,
  itemsTotal: null,
  itemsValueDelta: null,
  itemsReconciled: null,
  textRedacted: false,
  sourceUrl: 'https://e-licitatie.ro/pub/direct-acquisition/view/123',
  items,
});

const ITEMS_QUERY = /* GraphQL */ `
  query {
    procurementDirectAcquisition(id: "${DA_ID}") {
      detailAvailability
      detail {
        description
        itemCount
        items {
          id
          itemIndex
          catalogItemName
          itemQuantity
          unitPrice
          lineValue
        }
      }
    }
  }
`;

describe('DA items execute through the GraphQL schema', () => {
  it.each([0, 1, 2])('serves a detail with %i items and stable string IDs', async (count) => {
    const items = Array.from({ length: count }, (_, index) =>
      item(index === 0 ? '9007199254740993' : '9007199254740995', index)
    );
    app = await buildApp('available', detailBody(items));
    const body = await post(app, ITEMS_QUERY);

    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementDirectAcquisition']).toEqual({
      detailAvailability: 'AVAILABLE',
      detail: {
        description: 'Office supplies',
        itemCount: count,
        items: items.map((line) => ({
          id: line.daItemId,
          itemIndex: line.itemIndex,
          catalogItemName: line.catalogItemName,
          itemQuantity: line.itemQuantity,
          unitPrice: line.unitPrice,
          lineValue: line.lineValue,
        })),
      },
    });
  });
});

const FULL_DETAIL_QUERY = /* GraphQL */ `
  query {
    procurementDirectAcquisition(id: "${DA_ID}") {
      detailAvailability
      detail {
        description deliveryCondition paymentCondition contractTypeText isEuFunded euFundText
        caDecisionDate caDecisionDeadline supplierDecisionDate supplierDecisionDeadline
        caRejectionReason supplierRejectionReason correctionReason documentCount itemCount
        itemsTotal itemsValueDelta itemsReconciled textRedacted sourceUrl
        items {
          id itemIndex catalogItemCode catalogItemName catalogItemDescription itemMeasureUnit
          cpvCode cpvText itemQuantity unitPrice unitEstimatedPrice catalogUnitPrice lineValue sourceUrl
        }
      }
    }
  }
`;

describe('DA detail subtree field mappings', () => {
  it.each([false, true])('preserves every field with textRedacted=%s', async (textRedacted) => {
    const original = detailBody([item('9007199254740993', 0)]);
    const detail = {
      ...original,
      textRedacted,
      description: textRedacted ? null : original.description,
    };
    app = await buildApp('available', detail);
    const body = await post(app, FULL_DETAIL_QUERY);

    expect(body.errors).toBeUndefined();
    expect(body.data?.['procurementDirectAcquisition']).toEqual({
      detailAvailability: 'AVAILABLE',
      detail: {
        ...detail,
        items: detail.items.map(({ daItemId, ...fields }) => ({ id: daItemId, ...fields })),
      },
    });
  });
});
