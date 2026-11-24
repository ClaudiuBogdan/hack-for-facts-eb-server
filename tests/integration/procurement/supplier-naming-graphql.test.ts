/**
 * Naming step 2 on the DA release surfaces: GraphQL and REST serve each
 * disclosed supplier's kind (`company`, `person_masked`, `code_only`) with its
 * code, a name only where the kind carries one, and a code the names view may
 * not show as a withheld supplier. A served masked name makes the answer
 * never cacheable, as a registry name does. Synthetic codes and names only.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  makeDaTotalsCache,
  type DaReleaseDeps,
} from '@/modules/procurement/core/da-release-usecases.js';
import {
  daReleaseTypeDefs,
  makeDaReleaseResolvers,
} from '@/modules/procurement/shell/graphql/da-release-schema.js';
import { makeDaReleaseRestPlugin } from '@/modules/procurement/shell/rest/da-release-routes.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import { COMPANY, PURCHASES, makeFakeDaRepo } from '../../fixtures/procurement/da-release.js';

import type { DaPartyRecord, DaPurchaseRecord } from '@/modules/procurement/core/da-release.js';
import type { SupplierNaming } from '@/modules/procurement/core/supplier-naming.js';

const MASKED = 'EXEMPLU M*** PFA';

const supplier = (code: string, naming: SupplierNaming): DaPartyRecord => ({
  ...COMPANY,
  portalPartyId: `9${code}`,
  fiscalCode: code,
  name: naming.name,
  naming,
});

const withSupplier = (index: number, party: DaPartyRecord): DaPurchaseRecord => {
  const purchase = PURCHASES[index];
  if (purchase === undefined) throw new Error(`fixture purchase ${String(index)} missing`);
  return { ...purchase, supplier: party };
};

const NAMED = withSupplier(0, supplier('14399840', { kind: 'company', name: 'FIRMA EXEMPLU SRL' }));
const PERSON = withSupplier(1, supplier('2000002', { kind: 'person_masked', name: MASKED }));
const CODE = withSupplier(2, supplier('3000003', { kind: 'code_only', name: null }));
const HIDDEN = withSupplier(3, supplier('4000004', { kind: 'hidden', name: null }));

const build = async (purchases: readonly DaPurchaseRecord[]): Promise<FastifyInstance> => {
  const deps: DaReleaseDeps = {
    repo: makeFakeDaRepo({ supplierPrivacyTable: true, purchases }),
    totalsCache: makeDaTotalsCache(),
  };
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'procurement', typeDefs: daReleaseTypeDefs },
  ]);
  const app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeDaReleaseResolvers(deps) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.register(makeDaReleaseRestPlugin(deps), { prefix: '/api/v1/procurement/da' });
  await app.ready();
  return app;
};

interface Party {
  readonly displayKind: string;
  readonly partyId: string | null;
  readonly name: string | null;
  readonly fiscalCode: string | null;
}

const LIST = `{ procurementDaPurchases(pageSize: 100) { items { purchaseId supplier { displayKind partyId name fiscalCode } } } }`;

const list = async (app: FastifyInstance, method: 'GET' | 'POST') => {
  const res =
    method === 'POST'
      ? await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ query: LIST }),
        })
      : await app.inject({ method: 'GET', url: `/graphql?query=${encodeURIComponent(LIST)}` });
  const body = res.json<{
    data?: { procurementDaPurchases: { items: { purchaseId: string; supplier: Party }[] } };
    errors?: unknown[];
  }>();
  expect(body.errors).toBeUndefined();
  const byId = new Map(
    (body.data?.procurementDaPurchases.items ?? []).map((item) => [item.purchaseId, item.supplier])
  );
  return { byId, raw: res.body, cacheControl: res.headers['cache-control'] };
};

describe('DA supplier naming kinds on GraphQL and REST', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await build([NAMED, PERSON, CODE, HIDDEN]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves each kind with its code, and a name only where the kind carries one', async () => {
    const { byId } = await list(app, 'POST');
    expect(byId.get(NAMED.purchaseId)).toEqual({
      displayKind: 'company',
      partyId: '914399840',
      name: 'FIRMA EXEMPLU SRL',
      fiscalCode: '14399840',
    });
    expect(byId.get(PERSON.purchaseId)).toEqual({
      displayKind: 'person_masked',
      partyId: '92000002',
      name: MASKED,
      fiscalCode: '2000002',
    });
    expect(byId.get(CODE.purchaseId)).toEqual({
      displayKind: 'code_only',
      partyId: '93000003',
      name: null,
      fiscalCode: '3000003',
    });
    // A code the names view may not show: withheld, like a supplier D6 withholds.
    expect(byId.get(HIDDEN.purchaseId)).toEqual({
      displayKind: 'natural_person',
      partyId: null,
      name: null,
      fiscalCode: null,
    });
  });

  it('never serves the hidden code on any read', async () => {
    const { raw } = await list(app, 'GET');
    expect(raw).not.toContain('4000004');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/procurement/da/purchases/lookup?purchaseId=${HIDDEN.purchaseId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('4000004');
  });

  it('marks an answer serving a masked name no-store, GET and POST; a code-only one not', async () => {
    const masked = await build([PERSON]);
    const codeOnly = await build([CODE]);
    try {
      for (const method of ['GET', 'POST'] as const) {
        const withName = await list(masked, method);
        expect(withName.raw).toContain(MASKED);
        expect(withName.cacheControl).toBe('no-store');
        expect((await list(codeOnly, method)).cacheControl).toBeUndefined();
      }
    } finally {
      await masked.close();
      await codeOnly.close();
    }
  });
});
