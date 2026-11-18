/**
 * Site-wide D6 on the legacy GraphQL direct-acquisition type, over the real
 * procurement slice and the disclosure decorator: a withheld supplier serves
 * `displayKind: natural_person` with cui, name and displayName all null, the
 * title is withheld with the CPV label in its place, buyers are `authority`,
 * and a named company stays `company`. Off, the type answers as before with
 * `displayKind` filled.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';
import { withDaDisclosure } from '@/modules/procurement/shell/repo/da-disclosure-repo.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type {
  DirectAcquisitionDetail,
  ProcurementDirectAcquisition,
} from '@/modules/procurement/core/types.js';
import type { SupplierDisclosurePort } from '@/modules/shared/index.js';

const KERNEL_STUB_SDL = /* GraphQL */ `
  scalar Date
  scalar SIRUTA
  type Query {
    _empty: String
  }
`;

const row = (id: string, supplierCui: string, supplierName: string) =>
  ({
    daId: id,
    sourceSystem: 'elicitatie',
    uniqueCode: `DA${id}`,
    title: `SECRET title ${id}`,
    authorityCui: '4305857',
    authorityName: 'COMUNA EXEMPLU',
    supplierCui,
    supplierName,
    cpvCode: '44110000-4',
    valueRon: '100.00',
    status: 'finalized',
    isCanonical: true,
    dupGroupId: null,
  }) as unknown as ProcurementDirectAcquisition;

const ROWS: Record<string, ProcurementDirectAcquisition> = {
  '1': row('1', '14399840', 'FIRMA EXEMPLU SRL'),
  '2': row('2', '30254716', 'SECRET POPESCU ION PFA'),
};

const QUERY = (id: string) => /* GraphQL */ `
  query {
    procurementDirectAcquisition(id: "${id}") {
      directAcquisition {
        title titleWithheld cpvLabel
        authority { cui name displayName displayKind }
        supplier { cui name displayName displayKind }
      }
    }
  }
`;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (enforced: boolean): Promise<FastifyInstance> => {
  const base = {
    listCpvCodeLabels: (codes: readonly string[]) =>
      Promise.resolve(
        ok(
          codes.map((code) => ({
            code,
            labelRo: 'Materiale de constructii',
            labelEn: null,
            divisionCode: '44',
          }))
        )
      ),
    getDirectAcquisitionDetail: (id: string) =>
      Promise.resolve(
        ok({
          directAcquisition: ROWS[id],
          duplicates: [],
          detail: null,
          detailAvailability: 'not_captured',
        } as unknown as DirectAcquisitionDetail)
      ),
  } as unknown as ProcurementRepo;
  const disclosure: SupplierDisclosurePort = {
    enforced,
    publicSupplierCodes: () => Promise.resolve(ok(new Set(['14399840']))),
  };
  const repo = withDaDisclosure(base, disclosure);
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

const post = async (instance: FastifyInstance, query: string) => {
  const res = await instance.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  return { raw: res.body, body: res.json<{ data?: Record<string, unknown>; errors?: unknown }>() };
};

const directAcquisitionOf = (body: { data?: Record<string, unknown> }) =>
  (body.data?.['procurementDirectAcquisition'] as { directAcquisition: Record<string, unknown> })
    .directAcquisition;

describe('legacy DA GraphQL with D6 enforced', () => {
  it('serves a withheld supplier as natural_person with nothing that names it', async () => {
    app = await build(true);
    const { raw, body } = await post(app, QUERY('2'));
    expect(body.errors).toBeUndefined();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('30254716');
    expect(directAcquisitionOf(body)).toEqual({
      title: null,
      titleWithheld: 'privacy',
      cpvLabel: 'Materiale de constructii',
      authority: {
        cui: '4305857',
        name: 'COMUNA EXEMPLU',
        displayName: 'COMUNA EXEMPLU',
        displayKind: 'authority',
      },
      supplier: { cui: null, name: null, displayName: null, displayKind: 'natural_person' },
    });
  });

  it('keeps a public company named', async () => {
    app = await build(true);
    const { body } = await post(app, QUERY('1'));
    expect(directAcquisitionOf(body)['supplier']).toEqual({
      cui: '14399840',
      name: 'FIRMA EXEMPLU SRL',
      displayName: 'FIRMA EXEMPLU SRL',
      displayKind: 'company',
    });
  });
});

describe('legacy DA GraphQL with D6 off', () => {
  it('answers as before, with displayKind filled', async () => {
    app = await build(false);
    const { body } = await post(app, QUERY('2'));
    expect(directAcquisitionOf(body)).toMatchObject({
      title: 'SECRET title 2',
      titleWithheld: null,
      supplier: { cui: '30254716', name: 'SECRET POPESCU ION PFA', displayKind: 'company' },
    });
  });
});
