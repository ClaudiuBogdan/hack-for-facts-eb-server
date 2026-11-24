/**
 * "Never a CNP" on party names: the rule (the free-text rule's numeric checks only), and every
 * output edge outside the GraphQL party block (tested in integration): search highlights, the
 * analysis records (GraphQL and MCP), the MCP record search tools, the DA release parties and
 * the DA supplier bucket names. The code is synthetic, built for the test.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { parseAnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import {
  analysisBreakdown,
  analysisRecords,
  analysisStats,
} from '@/modules/procurement/core/analysis-usecases.js';
import { toBuyer, toSupplier } from '@/modules/procurement/core/da-release.js';
import { carriesPersonalCode, publicPartyName } from '@/modules/procurement/core/free-text-rule.js';
import { parseTotalsRequest } from '@/modules/procurement/core/money-totals.js';
import { parseQ } from '@/modules/procurement/core/search.js';
import { getSupplierRecords, resolveCpv } from '@/modules/procurement/core/usecases.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';
import { mapModification } from '@/modules/procurement/shell/repo/mappers.js';
import {
  codedNamesOf,
  withPublicTitleHighlights,
} from '@/modules/procurement/shell/repo/offset-search-repo.js';

import {
  fakeAnalysisRepo,
  generation,
  PUBLISHED_CAPABILITIES,
  statsRead,
} from './analysis-fakes.js';
import {
  CODED_NAME,
  ORDINARY_NAME,
  SYNTHETIC_CNP,
  syntheticCnp,
} from '../../fixtures/procurement/personal-code.js';

import type {
  AnalysisRecordRow,
  AnalysisRepo,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';

describe('the personal-code rule for party names', () => {
  it('builds a code with a valid check digit', () => {
    // 2·1+7·9+9·0+1·0+4·1+6·0+3·1+5·9+8·9+2·0+7·0+9·1 = 198, 198 mod 11 = 0.
    expect(SYNTHETIC_CNP).toBe('1900101990010');
    expect(syntheticCnp('279146358279')).toHaveLength(13);
  });

  it.each([
    ['plain', `POPESCU ION ${SYNTHETIC_CNP}`],
    ['as the whole name', SYNTHETIC_CNP],
    ['with spaces', `ION ${SYNTHETIC_CNP.split('').join(' ')}`],
    [
      'with dots and dashes',
      `ION ${SYNTHETIC_CNP.slice(0, 7)}.${SYNTHETIC_CNP.slice(7, 10)}-${SYNTHETIC_CNP.slice(10)}`,
    ],
    ['split by a Hangul filler', `ION ${SYNTHETIC_CNP.slice(0, 6)}\u3164${SYNTHETIC_CNP.slice(6)}`],
    [
      'in fullwidth digits',
      `ION ${SYNTHETIC_CNP.replace(/[0-9]/gu, (d) => String.fromCodePoint(0xff10 + Number(d)))}`,
    ],
    ['inside highlight markers', `ION ⟦${SYNTHETIC_CNP.slice(0, 6)}⟧${SYNTHETIC_CNP.slice(6)}`],
    ['in non-ASCII digits', 'ION ١٢٣'],
  ])('withholds a name with a personal code %s', (_label, name) => {
    expect(carriesPersonalCode(name)).toBe(true);
    expect(publicPartyName(name)).toBeNull();
  });

  it.each([
    ORDINARY_NAME,
    'PRIMARIA COMUNEI EXEMPLU',
    // Sole-trader names stay: the rule's other checks do not apply to names.
    'POPESCU ION PFA',
    'POPESCU ION I.I.',
    // Fewer than 13 digits, alone or with separators.
    'SC 123456789012 SRL',
    'LOT 2 J40/1234/2005',
  ])('serves an ordinary name unchanged: %s', (name) => {
    expect(carriesPersonalCode(name)).toBe(false);
    expect(publicPartyName(name)).toBe(name);
  });

  it('keeps null as null', () => {
    expect(publicPartyName(null)).toBeNull();
  });
});

describe('search highlights (repository edge)', () => {
  const O = '⟦';
  const C = '⟧';

  it('marks the rows whose raw names carry a personal code', () => {
    const row = (id: string, cui: string | null, authority: string, supplier: string | null) => ({
      contract_id: id,
      authority_name: authority,
      supplier_cui: cui,
      supplier_name: supplier,
    });
    const rows = [
      row('1', '14399840', 'COMUNA EXEMPLU', ORDINARY_NAME),
      row('2', '14399840', 'COMUNA EXEMPLU', CODED_NAME),
      row('3', '14399840', CODED_NAME, null),
      // Served masked (a person's code, or no code): the indexed raw name is never quoted.
      row('4', SYNTHETIC_CNP, 'COMUNA EXEMPLU', 'PO*****U ION'),
      row('5', null, 'COMUNA EXEMPLU', ORDINARY_NAME),
    ];
    expect([...codedNamesOf(rows, 'contract_id')].map(([id, fields]) => [id, [...fields]])).toEqual(
      [
        ['2', ['supplierName']],
        ['3', ['authorityName']],
        ['4', ['supplierName']],
        ['5', ['supplierName']],
      ]
    );
  });

  it('withholds a name fragment of a coded name, even one that quotes no digit', () => {
    const codedNames = new Map([['2', new Set(['supplierName'] as const)]]);
    expect(
      withPublicTitleHighlights(
        [
          { id: '1', supplierName: `${O}FIRMA${C} EXEMPLU SRL` },
          // The row's name carries a code: the fragment goes, though it quotes none.
          { id: '2', supplierName: `${O}POPESCU${C} ION`, authorityName: `${O}COMUNA${C}` },
          // The fragment itself carries one (a stale index or an unhydrated row).
          { id: '3', supplierName: `${O}ION${C} ${SYNTHETIC_CNP}` },
        ],
        undefined,
        codedNames
      )
    ).toEqual([
      { id: '1', supplierName: `${O}FIRMA${C} EXEMPLU SRL` },
      { id: '2', authorityName: `${O}COMUNA${C}` },
    ]);
  });
});

const recordRow = (over: Partial<AnalysisRecordRow> = {}): AnalysisRecordRow => ({
  id: '17',
  date: '2025-11-03',
  title: null,
  authorityCui: '4270740',
  authorityName: 'Primaria Sibiu',
  supplierCui: '14399840',
  supplierName: ORDINARY_NAME,
  valueRon: '1234.56',
  status: 'finalized',
  recordKind: null,
  cpvCode: '30192700',
  ...over,
});

const RECORDS = {
  total: '3',
  rows: [
    recordRow({ id: '1' }),
    recordRow({ id: '2', supplierCui: null, supplierName: CODED_NAME }),
    recordRow({ id: '3', authorityName: `PRIMARIA ${SYNTHETIC_CNP}`, supplierName: CODED_NAME }),
  ],
};

const namesById = (items: readonly Record<string, unknown>[]) =>
  items.map((item) => [item['id'], item['authorityName'], item['supplierName']]);

describe('analysis records', () => {
  it('the usecase withholds coded names, for every surface', async () => {
    const { repo } = fakeAnalysisRepo({ records: RECORDS });
    const page = (
      await analysisRecords({ analysisRepo: repo }, { scope: { grain: 'contract' } })
    )._unsafeUnwrap();
    expect(namesById(page.items as unknown as Record<string, unknown>[])).toEqual([
      ['1', 'Primaria Sibiu', ORDINARY_NAME],
      ['2', 'Primaria Sibiu', null],
      ['3', null, null],
    ]);
    // A public code stays.
    expect(page.items[2]?.supplierCui).toBe('14399840');
  });

  it('GraphQL procurementRecords and MCP shape=records serve no coded name', async () => {
    // Contract records name suppliers from the production read only (the build's names never).
    const production = {
      contractsByIds: () =>
        Promise.resolve(
          ok(
            new Map(
              [
                ['1', ORDINARY_NAME],
                ['2', CODED_NAME],
                ['3', CODED_NAME],
              ].map(([id, name]) => [
                id,
                {
                  contractId: id,
                  displayTitle: null,
                  supplierCui: id === '2' ? null : '14399840',
                  supplierName: name,
                },
              ])
            )
          )
        ),
    } as unknown as ProcurementRepo;
    const analysis = fakeAnalysisRepo({ records: RECORDS }).repo;
    const resolvers = makeProcurementResolvers({ repo: production, analysis }) as {
      Query: {
        procurementRecords: (
          r: unknown,
          a: Record<string, unknown>
        ) => Promise<{ items: Record<string, unknown>[] }>;
      };
    };
    const gql = await resolvers.Query.procurementRecords(undefined, {
      scope: { grain: 'contract' },
    });
    expect(JSON.stringify(gql)).not.toContain(SYNTHETIC_CNP);
    expect(gql.items.map((item) => (item['supplier'] as { name: string | null }).name)).toEqual([
      ORDINARY_NAME,
      null,
      null,
    ]);

    const tool = makeProcurementMcpTools({
      repo: production,
      analysis: fakeAnalysisRepo({ records: RECORDS }).repo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    const out = await tool?.handler({ shape: 'records', scope: { grain: 'contract' } });
    expect(out?.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_CNP);
    expect(namesById(out?.items as Record<string, unknown>[])).toEqual([
      ['1', 'Primaria Sibiu', ORDINARY_NAME],
      ['2', 'Primaria Sibiu', null],
      ['3', null, null],
    ]);
  });
});

describe('MCP record search tools', () => {
  const item = (id: string, supplierCui: string | null, supplierName: string) => ({
    id,
    authorityCui: '4305857',
    authorityName: 'COMUNA EXEMPLU',
    supplierCui,
    supplierName,
  });
  const ITEMS = [
    item('1', '14399840', ORDINARY_NAME),
    item('2', null, CODED_NAME),
    // A CNP-shaped code (kernel P0 containment) never leaves the tool either; the repository
    // already served the person's name masked.
    item('3', SYNTHETIC_CNP, 'PO*****U ION'),
  ];
  const repo = {
    listContracts: () => Promise.resolve(ok({ items: ITEMS, next: null })),
    listDirectAcquisitions: () => Promise.resolve(ok({ items: ITEMS, next: null })),
  } as unknown as ProcurementRepo;
  const tools = makeProcurementMcpTools({
    repo,
    analysis: {} as AnalysisRepo,
    clientBaseUrl: 'https://x.test',
  });

  it.each([
    ['search_procurement_contracts', { authorityCui: '4305857' }],
    ['search_procurement_direct_acquisitions', { authorityCui: '4305857' }],
  ])('%s serves no coded name and no CNP-shaped code', async (name, args) => {
    const tool = tools.find((candidate) => candidate.name === name);
    const out = await tool?.handler(args);
    expect(out?.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_CNP);
    expect(
      (out?.items as Record<string, unknown>[]).map((i) => [
        i['id'],
        i['supplierCui'],
        i['supplierName'],
      ])
    ).toEqual([
      ['1', '14399840', ORDINARY_NAME],
      ['2', null, null],
      ['3', null, 'PO*****U ION'],
    ]);
  });

  it.each([
    ['search_procurement_contracts', 'supplierCui'],
    ['search_procurement_contracts', 'authorityCui'],
    ['search_procurement_direct_acquisitions', 'supplierCui'],
    ['search_procurement_direct_acquisitions', 'authorityCui'],
  ])('%s refuses a person code as %s, without a read or an echo', async (name, field) => {
    const reads: string[] = [];
    const counting = {
      listContracts: () => {
        reads.push('contracts');
        return Promise.resolve(ok({ items: [], next: null }));
      },
      listDirectAcquisitions: () => {
        reads.push('das');
        return Promise.resolve(ok({ items: [], next: null }));
      },
    } as unknown as ProcurementRepo;
    const tool = makeProcurementMcpTools({
      repo: counting,
      analysis: {} as AnalysisRepo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === name);
    const out = await tool?.handler({ [field]: SYNTHETIC_CNP });
    expect(out?.ok).toBe(false);
    expect(reads).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_CNP);
  });
});

describe('a person code or a personal code is never a lookup key', () => {
  it('a q carrying a personal code is refused; an ordinary q is not', () => {
    expect(parseQ(`ion ${SYNTHETIC_CNP}`)._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
    });
    expect(parseQ('curatenie')._unsafeUnwrap()).toBe('curatenie');
  });

  it('an analysis scope q or a CPV q carrying a personal code is refused, never echoed', async () => {
    const scope = parseAnalysisScope({ q: `ion ${SYNTHETIC_CNP}` });
    expect(scope._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'q' });
    expect(parseAnalysisScope({ q: 'curatenie' }).isOk()).toBe(true);
    const reads: string[] = [];
    const repo = {
      resolveCpv: (q: string) => {
        reads.push(q);
        return Promise.resolve(ok([]));
      },
    } as unknown as ProcurementRepo;
    const refused = await resolveCpv(repo, SYNTHETIC_CNP, 5);
    expect(refused._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput' });
    expect(JSON.stringify(refused._unsafeUnwrapErr())).not.toContain(SYNTHETIC_CNP);
    expect(reads).toEqual([]);
  });

  it('an analysis scope q or a CPV q with an 11- or 12-digit run is refused; a search q is not', async () => {
    for (const run of ['12345678901', '123456789012']) {
      expect(parseAnalysisScope({ q: `cod ${run}` })._unsafeUnwrapErr()).toMatchObject({
        type: 'InvalidInput',
        field: 'q',
      });
      const repo = {
        resolveCpv: () => Promise.resolve(ok([])),
      } as unknown as ProcurementRepo;
      expect((await resolveCpv(repo, run, 5))._unsafeUnwrapErr()).toMatchObject({
        type: 'InvalidInput',
      });
      // The legacy search still finds contract numbers that long (50 bare ones on 24 Nov); party
      // names are matched with their digits removed.
      expect(parseQ(run)._unsafeUnwrap()).toBe(run);
    }
    expect(parseAnalysisScope({ q: 'lot 1234567890' }).isOk()).toBe(true);
  });

  it.each([
    ['spaced', 'cod 1234 5678 901'],
    ['hyphenated', 'cod 1234-5678-9012'],
    ['dotted', 'cod 123.456.789.01'],
  ])('a %s 11- or 12-digit run is refused in scope q, CPV q and totals q', async (_label, q) => {
    expect(parseAnalysisScope({ q })._unsafeUnwrapErr()).toMatchObject({ field: 'q' });
    const repo = { resolveCpv: () => Promise.resolve(ok([])) } as unknown as ProcurementRepo;
    expect((await resolveCpv(repo, q, 5))._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
    });
    const totals = parseTotalsRequest({
      id: 'x',
      filters: { procurementKinds: ['contract_award'], q },
    });
    expect(totals._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'q' });
    expect(JSON.stringify(totals._unsafeUnwrapErr())).not.toContain(q.slice(4));
  });

  it('totals v2 refuses a q carrying a personal code, and keeps an ordinary one', () => {
    const refused = parseTotalsRequest({
      id: 'x',
      filters: { procurementKinds: ['contract_award'], q: `ion ${SYNTHETIC_CNP}` },
    });
    expect(refused._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'q' });
    expect(JSON.stringify(refused._unsafeUnwrapErr())).not.toContain(SYNTHETIC_CNP);
    const served = parseTotalsRequest({
      id: 'x',
      filters: { procurementKinds: ['contract_award'], q: 'lot 1234567890' },
    });
    expect(served._unsafeUnwrap().filters.q).toBe('lot 1234567890');
  });

  it('a stale build pin is refused without echoing it', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisStats(
      { analysisRepo: repo },
      { scope: { grain: 'contract' }, build: SYNTHETIC_CNP }
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'build' });
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(SYNTHETIC_CNP);
  });

  it('a modification description the free-text rule withholds is not served', () => {
    const mod = (text: string) =>
      mapModification({
        modification_id: '7',
        contract_id: null,
        source_url: null,
        link_method: null,
        link_confidence: null,
        authority_cui: null,
        authority_name: null,
        supplier_cui: null,
        supplier_name: null,
        contract_no: null,
        notice_no: null,
        modification_date: null,
        value_before_ron: null,
        value_after_ron: null,
        value_delta_ron: null,
        currency: null,
        source_value_before: null,
        source_value_after: null,
        modification_type: text,
        year: null,
      });
    expect(mod(`cesionar ${SYNTHETIC_CNP}`).modificationType).toBeNull();
    expect(mod('prelungire termen').modificationType).toBe('prelungire termen');
  });

  it('supplier records refuse a person code without a read', async () => {
    const reads: string[] = [];
    const repo = {
      supplierRecords: (cui: string) => {
        reads.push(cui);
        return Promise.resolve(ok({ total: null, hasNextPage: false, endCursor: null, edges: [] }));
      },
    } as unknown as ProcurementRepo;
    const refused = await getSupplierRecords(repo, SYNTHETIC_CNP, 5, undefined, false);
    expect(refused._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput' });
    expect(JSON.stringify(refused._unsafeUnwrapErr())).not.toContain(SYNTHETIC_CNP);
    expect(reads).toEqual([]);
    expect((await getSupplierRecords(repo, '14399840', 5, undefined, false)).isOk()).toBe(true);
    expect(reads).toEqual(['14399840']);
  });
});

describe("a person's supplier name in analysis records", () => {
  const PERSON = {
    total: '2',
    rows: [
      recordRow({ id: '1' }),
      // The facts hold the raw name of a person supplier: never served.
      recordRow({ id: '2', supplierCui: SYNTHETIC_CNP, supplierName: 'POPESCU ION' }),
    ],
  };
  /** Production's read masks a person's supplier name (procurement_v3.mask_person_name). */
  const masked = {
    contractsByIds: () =>
      Promise.resolve(
        ok(
          new Map([
            [
              '1',
              {
                contractId: '1',
                displayTitle: null,
                supplierCui: '14399840',
                supplierName: ORDINARY_NAME,
              },
            ],
            [
              '2',
              {
                contractId: '2',
                displayTitle: null,
                supplierCui: SYNTHETIC_CNP,
                supplierName: 'PO*****U ION',
              },
            ],
          ])
        )
      ),
  } as unknown as ProcurementRepo;

  it('the usecase nulls it and flags it for the display step', async () => {
    const { repo } = fakeAnalysisRepo({ records: PERSON });
    const page = (
      await analysisRecords({ analysisRepo: repo }, { scope: { grain: 'contract' } })
    )._unsafeUnwrap();
    expect(page.items[1]).toMatchObject({
      supplierCui: null,
      supplierName: null,
      supplierPerson: true,
    });
    expect(page.items[0]?.supplierPerson).toBeUndefined();
  });

  it('GraphQL and MCP serve the masked name production serves, never the raw one', async () => {
    const resolvers = makeProcurementResolvers({
      repo: masked,
      analysis: fakeAnalysisRepo({ records: PERSON }).repo,
    }) as {
      Query: {
        procurementRecords: (
          r: unknown,
          a: Record<string, unknown>
        ) => Promise<{ items: Record<string, unknown>[] }>;
      };
    };
    const gql = await resolvers.Query.procurementRecords(undefined, {
      scope: { grain: 'contract' },
    });
    expect(gql.items.map((item) => item['supplier'])).toEqual([
      { cui: '14399840', name: ORDINARY_NAME, displayName: ORDINARY_NAME, displayKind: null },
      { cui: null, name: 'PO*****U ION', displayName: 'PO*****U ION', displayKind: null },
    ]);
    expect(JSON.stringify(gql)).not.toContain('POPESCU');

    const tool = makeProcurementMcpTools({
      repo: masked,
      analysis: fakeAnalysisRepo({ records: PERSON }).repo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    const out = await tool?.handler({ shape: 'records', scope: { grain: 'contract' } });
    expect(namesById(out?.items as Record<string, unknown>[])).toEqual([
      ['1', 'Primaria Sibiu', ORDINARY_NAME],
      ['2', 'Primaria Sibiu', 'PO*****U ION'],
    ]);
    expect(JSON.stringify(out)).not.toContain('POPESCU');
    expect(JSON.stringify(out)).not.toContain('supplierPerson');
  });

  it('serves no supplier name where the build and production disagree on the supplier', async () => {
    // The build kept an organization code and a raw person name; production holds another (a
    // person's) code: no name, neither the build's raw one nor another supplier's.
    const disagree = {
      total: '1',
      rows: [recordRow({ id: '2', supplierCui: '14399840', supplierName: 'POPESCU ION' })],
    };
    const tool = makeProcurementMcpTools({
      repo: masked,
      analysis: fakeAnalysisRepo({ records: disagree }).repo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    const out = await tool?.handler({ shape: 'records', scope: { grain: 'contract' } });
    expect(namesById(out?.items as Record<string, unknown>[])).toEqual([
      ['2', 'Primaria Sibiu', null],
    ]);
    expect(JSON.stringify(out)).not.toContain('POPESCU');
  });

  it('serves production names only for the record’s own supplier code', async () => {
    const drift = {
      total: '1',
      rows: [recordRow({ id: '1', supplierCui: '30254716', supplierName: 'ALTA FIRMA SRL' })],
    };
    const tool = makeProcurementMcpTools({
      repo: masked,
      analysis: fakeAnalysisRepo({ records: drift }).repo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    const out = await tool?.handler({ shape: 'records', scope: { grain: 'contract' } });
    // Production names 14399840 for this contract: never shown under 30254716.
    expect(namesById(out?.items as Record<string, unknown>[])).toEqual([
      ['1', 'Primaria Sibiu', null],
    ]);
  });

  it('is null when production does not serve the contract (or on the DA grain)', async () => {
    const none = {
      contractsByIds: () => Promise.resolve(ok(new Map())),
    } as unknown as ProcurementRepo;
    const tool = makeProcurementMcpTools({
      repo: none,
      analysis: fakeAnalysisRepo({ records: PERSON }).repo,
      clientBaseUrl: 'https://x.test',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    for (const grain of ['contract', 'direct_acquisition']) {
      const out = await tool?.handler({ shape: 'records', scope: { grain } });
      expect(namesById(out?.items as Record<string, unknown>[])[1]).toEqual([
        '2',
        'Primaria Sibiu',
        null,
      ]);
      expect(JSON.stringify(out)).not.toContain('POPESCU');
    }
  });
});

describe('DA release parties', () => {
  const party = (name: string) => ({
    portalPartyId: '5',
    name,
    fiscalCode: '14399840',
    fiscalCodeStatus: 'valid',
    supplierPublic: true,
  });

  it('withholds a coded buyer or named-supplier name, keeping the rest', () => {
    expect(toBuyer(party(CODED_NAME))).toEqual({
      displayKind: 'authority',
      partyId: '5',
      name: null,
      fiscalCode: '14399840',
    });
    expect(toSupplier(party(CODED_NAME))).toEqual({
      displayKind: 'company',
      partyId: '5',
      name: null,
      fiscalCode: '14399840',
    });
    expect(toSupplier(party(ORDINARY_NAME)).name).toBe(ORDINARY_NAME);
    expect(toBuyer(party('COMUNA EXEMPLU')).name).toBe('COMUNA EXEMPLU');
  });

  it('never serves a person code, whatever its status says', () => {
    const person = { ...party(ORDINARY_NAME), fiscalCode: SYNTHETIC_CNP };
    expect(toSupplier(person)).toEqual({
      displayKind: 'natural_person',
      partyId: null,
      name: null,
      fiscalCode: null,
    });
    expect(toBuyer(person).fiscalCode).toBeNull();
  });

  it('withholds a coded DA supplier bucket name', async () => {
    const { repo } = fakeAnalysisRepo({
      generation: generation(undefined, { ...PUBLISHED_CAPABILITIES, directAcquisitionV3: true }),
      breakdown: {
        totals: statsRead({ rows: '4', withValue: '4', valueAwardedSum: '13' }),
        buckets: [
          { kind: 'top', key: '14399840', recordCount: '1', withValue: '1', valueAwardedSum: '5' },
          { kind: 'top', key: '2000002', recordCount: '3', withValue: '3', valueAwardedSum: '8' },
          { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
          { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
        ],
      },
    });
    const result = await analysisBreakdown(
      {
        analysisRepo: repo,
        daSupplierNames: {
          namesOf: () =>
            Promise.resolve(
              ok(
                new Map([
                  ['14399840', ORDINARY_NAME],
                  ['2000002', CODED_NAME],
                ])
              )
            ),
        },
      },
      { scope: { grain: 'direct_acquisition' }, dimension: 'supplier', topN: 5 }
    );
    const buckets = result._unsafeUnwrap()[0]?.buckets ?? [];
    expect(buckets.filter((b) => b.kind === 'top').map((b) => [b.key, b.displayName])).toEqual([
      ['14399840', ORDINARY_NAME],
      ['2000002', null],
    ]);
  });

  it('refuses a DA supplier breakdown keyed by a person code, naming no code', async () => {
    const asked: string[][] = [];
    const { repo } = fakeAnalysisRepo({
      generation: generation(undefined, { ...PUBLISHED_CAPABILITIES, directAcquisitionV3: true }),
      breakdown: {
        totals: statsRead({ rows: '4', withValue: '4', valueAwardedSum: '13' }),
        buckets: [
          { kind: 'top', key: '14399840', recordCount: '1', withValue: '1', valueAwardedSum: '5' },
          {
            kind: 'top',
            key: SYNTHETIC_CNP,
            recordCount: '3',
            withValue: '3',
            valueAwardedSum: '8',
          },
          { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
          { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
        ],
      },
    });
    const result = await analysisBreakdown(
      {
        analysisRepo: repo,
        daSupplierNames: {
          namesOf: (_build, codes) => {
            asked.push([...codes]);
            return Promise.resolve(ok(new Map([[SYNTHETIC_CNP, ORDINARY_NAME]])));
          },
        },
      },
      { scope: { grain: 'direct_acquisition' }, dimension: 'supplier', topN: 5 }
    );
    // Relabelling after ranking would still serve that person's totals: the answer is refused.
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Database' });
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(SYNTHETIC_CNP);
    expect(asked).toEqual([]);
  });
});
