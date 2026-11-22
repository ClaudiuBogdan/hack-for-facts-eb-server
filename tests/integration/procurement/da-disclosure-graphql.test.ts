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
import { FiscalCodeSet, type SupplierDisclosurePort } from '@/modules/shared/index.js';

import {
  fakeAnalysisRepo,
  generation,
  PUBLISHED_CAPABILITIES,
  statsRead,
} from '../../unit/procurement/analysis-fakes.js';

import type {
  AnalysisRepo,
  DaSupplierNamesPort,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type {
  DirectAcquisitionDetail,
  ProcurementDirectAcquisition,
} from '@/modules/procurement/core/types.js';

/** The supplier_privacy publication the fake port's set was read from. */
const PUBLISHED = '2026-11-19T03:10:00.000000Z';

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

const build = async (
  enforced: boolean,
  analysis: AnalysisRepo = {} as AnalysisRepo,
  daSupplierNames?: DaSupplierNamesPort
): Promise<FastifyInstance> => {
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
    searchDirectAcquisitionsOffset: () =>
      Promise.resolve(ok({ items: [ROWS['1']], total: 1, estimated: false })),
    supplierRecords: () =>
      Promise.resolve(
        ok({
          total: null,
          hasNextPage: false,
          endCursor: null,
          edges: [
            {
              cursor: 'c1',
              node: { grain: 'direct_acquisition', directAcquisition: ROWS['1'] },
            },
          ],
        })
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
    privacyAsOf: () => Promise.resolve(ok(null)),
    publicSupplierCodes: () => Promise.resolve(ok(new FiscalCodeSet(['14399840'], PUBLISHED))),
  };
  const repo = withDaDisclosure(base, disclosure);
  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeGraphQLPlugin({
      schema: [KERNEL_STUB_SDL, procurementTypeDefs],
      resolvers: [
        makeProcurementResolvers({
          repo,
          analysis,
          supplierDisclosure: disclosure,
          ...(daSupplierNames !== undefined && { daSupplierNames }),
        }) as unknown as Record<string, never>,
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
  return {
    raw: res.body,
    body: res.json<{ data?: Record<string, unknown>; errors?: unknown }>(),
    cacheControl: res.headers['cache-control'],
  };
};

const get = async (instance: FastifyInstance, query: string) => {
  const res = await instance.inject({
    method: 'GET',
    url: `/graphql?query=${encodeURIComponent(query)}`,
  });
  return { raw: res.body, cacheControl: res.headers['cache-control'] };
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
  it('answers as before; displayKind stays null until D6 is on (root, 18 Nov)', async () => {
    app = await build(false);
    const { body } = await post(app, QUERY('2'));
    expect(directAcquisitionOf(body)).toMatchObject({
      title: 'SECRET title 2',
      titleWithheld: null,
      supplier: { cui: '30254716', name: 'SECRET POPESCU ION PFA', displayKind: null },
    });
  });
});

describe('legacy DA GraphQL disclosure keys (docs 10, monotonic keys)', () => {
  const KEYS = /* GraphQL */ `
    query {
      procurementDirectAcquisitions(pageSize: 5) {
        meta {
          disclosureKey
        }
      }
      procurementDirectAcquisition(id: "1") {
        meta {
          disclosureKey
        }
      }
      procurementSupplierRecords(supplierCui: "14399840", first: 5) {
        meta {
          disclosureKey
        }
        edges {
          cursor
        }
      }
    }
  `;
  const keysOf = (body: { data?: Record<string, unknown> }) =>
    [
      'procurementDirectAcquisitions',
      'procurementDirectAcquisition',
      'procurementSupplierRecords',
    ].map(
      (field) => (body.data?.[field] as { meta: { disclosureKey: string } }).meta.disclosureKey
    );

  it('every legacy DA list page, detail and supplier-records page carries its publication', async () => {
    app = await build(true);
    const { body } = await post(app, KEYS);
    expect(body.errors).toBeUndefined();
    expect(keysOf(body)).toEqual([PUBLISHED, PUBLISHED, PUBLISHED]);
  });

  it('reads off while D6 is not enforced', async () => {
    app = await build(false);
    const { body } = await post(app, KEYS);
    expect(body.errors).toBeUndefined();
    expect(keysOf(body)).toEqual(['off', 'off', 'off']);
  });
});

describe('DA supplier bucket names over GraphQL (PROC-B51G)', () => {
  const BREAKDOWN = /* GraphQL */ `
    query {
      procurementBreakdown(scope: { grain: direct_acquisition }, dimension: supplier, topN: 5) {
        buckets {
          kind
          key
          displayKind
          displayName
        }
      }
    }
  `;
  const analysis = () =>
    fakeAnalysisRepo({
      generation: generation(undefined, { ...PUBLISHED_CAPABILITIES, directAcquisitionV3: true }),
      breakdown: {
        totals: statsRead({ rows: '6', withValue: '6', valueAwardedSum: '21' }),
        buckets: [
          {
            kind: 'top',
            key: 'natural_person',
            recordCount: '2',
            withValue: '2',
            valueAwardedSum: '8',
          },
          { kind: 'top', key: '14399840', recordCount: '1', withValue: '1', valueAwardedSum: '5' },
          { kind: 'top', key: '2000002', recordCount: '3', withValue: '3', valueAwardedSum: '8' },
          { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
          { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
        ],
      },
    }).repo;
  const names: DaSupplierNamesPort = {
    namesOf: (_buildId, codes) =>
      Promise.resolve(
        ok(new Map(codes.includes('14399840') ? [['14399840', 'FIRMA EXEMPLU SRL']] : []))
      ),
  };

  it('serves displayName for a public company name only, null otherwise', async () => {
    app = await build(true, analysis(), names);
    const { body } = await post(app, BREAKDOWN);
    expect(body.errors).toBeUndefined();
    const blocks = body.data?.['procurementBreakdown'] as {
      buckets: {
        kind: string;
        key: string | null;
        displayKind: string | null;
        displayName: string | null;
      }[];
    }[];
    const byKey = Object.fromEntries(
      (blocks[0]?.buckets ?? []).map((b) => [b.key ?? b.kind, [b.displayKind, b.displayName]])
    );
    expect(byKey).toEqual({
      '14399840': ['company', 'FIRMA EXEMPLU SRL'],
      '2000002': ['company', null],
      natural_person: ['natural_person', null],
      other: [null, null],
      unknown: [null, null],
    });
  });
});

describe('PROC-VDWQ: GraphQL answers naming a DA supplier are never cacheable', () => {
  it('marks a legacy DA answer naming its supplier no-store, GET and POST; not a withheld one', async () => {
    app = await build(true);
    const named = await post(app, QUERY('1'));
    expect(named.raw).toContain('FIRMA EXEMPLU SRL');
    expect(named.cacheControl).toBe('no-store');
    expect((await get(app, QUERY('1'))).cacheControl).toBe('no-store');
    // natural_person: no supplier name (the buyer's name is not a supplier's).
    const withheld = await post(app, QUERY('2'));
    expect(withheld.raw).not.toContain('SECRET POPESCU');
    expect(withheld.cacheControl).toBeUndefined();
    expect((await get(app, QUERY('2'))).cacheControl).toBeUndefined();
  });

  it('marks a breakdown with a named DA supplier bucket no-store; not one without names', async () => {
    const BREAKDOWN = /* GraphQL */ `
      query {
        procurementBreakdown(scope: { grain: direct_acquisition }, dimension: supplier, topN: 5) {
          buckets {
            key
            displayKind
            displayName
          }
        }
      }
    `;
    const repo = () =>
      fakeAnalysisRepo({
        generation: generation(undefined, { ...PUBLISHED_CAPABILITIES, directAcquisitionV3: true }),
        breakdown: {
          totals: statsRead({ rows: '3', withValue: '3', valueAwardedSum: '13' }),
          buckets: [
            {
              kind: 'top',
              key: 'natural_person',
              recordCount: '2',
              withValue: '2',
              valueAwardedSum: '8',
            },
            {
              kind: 'top',
              key: '14399840',
              recordCount: '1',
              withValue: '1',
              valueAwardedSum: '5',
            },
          ],
        },
      }).repo;
    const namesOf = (known: boolean): DaSupplierNamesPort => ({
      namesOf: () => Promise.resolve(ok(new Map(known ? [['14399840', 'FIRMA EXEMPLU SRL']] : []))),
    });
    app = await build(true, repo(), namesOf(true));
    expect((await post(app, BREAKDOWN)).cacheControl).toBe('no-store');
    expect((await get(app, BREAKDOWN)).cacheControl).toBe('no-store');
    await app.close();
    app = await build(true, repo(), namesOf(false));
    const unnamed = await post(app, BREAKDOWN);
    expect(unnamed.raw).not.toContain('FIRMA EXEMPLU SRL');
    expect(unnamed.cacheControl).toBeUndefined();
  });
});
