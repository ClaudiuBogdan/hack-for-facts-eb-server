/**
 * "Never a CNP" on party names: the rule (the free-text rule's numeric checks only), and every
 * output edge outside the GraphQL party block (tested in integration): search highlights, the
 * analysis records (GraphQL and MCP), the MCP record search tools, the DA release parties and
 * the DA supplier bucket names. The code is synthetic, built for the test.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisRecords,
} from '@/modules/procurement/core/analysis-usecases.js';
import { toBuyer, toSupplier } from '@/modules/procurement/core/da-release.js';
import { carriesPersonalCode, publicPartyName } from '@/modules/procurement/core/free-text-rule.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';
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
    const rows = [
      { contract_id: '1', authority_name: 'COMUNA EXEMPLU', supplier_name: ORDINARY_NAME },
      { contract_id: '2', authority_name: 'COMUNA EXEMPLU', supplier_name: CODED_NAME },
      { contract_id: '3', authority_name: CODED_NAME, supplier_name: null },
    ];
    expect([...codedNamesOf(rows, 'contract_id')].map(([id, fields]) => [id, [...fields]])).toEqual(
      [
        ['2', ['supplierName']],
        ['3', ['authorityName']],
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

const noTitles = {
  contractsByIds: () => Promise.resolve(ok(new Map())),
} as unknown as ProcurementRepo;

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
    const analysis = fakeAnalysisRepo({ records: RECORDS }).repo;
    const resolvers = makeProcurementResolvers({ repo: noTitles, analysis }) as {
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
      repo: noTitles,
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
    // A CNP-shaped code (kernel P0 containment) never leaves the tool either.
    item('3', SYNTHETIC_CNP, 'ION POPESCU'),
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
      ['3', null, 'ION POPESCU'],
    ]);
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
});
