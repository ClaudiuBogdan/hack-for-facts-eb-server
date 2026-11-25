/**
 * Naming step 2: a supplier D6 discloses is named from
 * `procurement_v3.supplier_names_public` once this login may read it
 * (`company` / `person_masked` / `code_only`, unknown values fail closed, a code
 * that may not be shown is withheld or refuses a ranking); without the grant,
 * exactly as before. Synthetic codes and names only.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { analysisBreakdown } from '@/modules/procurement/core/analysis-usecases.js';
import {
  toSupplier,
  toTotalsGroup,
  type DaPartyRecord,
} from '@/modules/procurement/core/da-release.js';
import {
  namingFromRegistry,
  namingFromView,
  servedSupplierName,
  undisclosedNaming,
  type SupplierNaming,
} from '@/modules/procurement/core/supplier-naming.js';
import { supplierNamesByCode } from '@/modules/procurement/shell/repo/da-v3-sql.js';

import {
  fakeAnalysisRepo,
  generation,
  PUBLISHED_CAPABILITIES,
  statsRead,
} from './analysis-fakes.js';
import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';
import { CODED_NAME, SYNTHETIC_CNP } from '../../fixtures/procurement/personal-code.js';

const REGISTRY = 'FIRMA EXEMPLU SRL';
const MASKED = 'EXEMPLU M*** PFA';

const view = (
  naming: string | null,
  displayName: string | null,
  codeShown: boolean | null = true
) => ({
  naming,
  displayName,
  codeShown,
});

describe('namingFromView', () => {
  it.each([
    ['named, with a name', view('named', REGISTRY), { kind: 'company', name: REGISTRY }],
    ['masked, with a name', view('masked', MASKED), { kind: 'person_masked', name: MASKED }],
    ['code_only', view('code_only', null), { kind: 'code_only', name: null }],
    ['withheld', view('withheld', null), { kind: 'code_only', name: null }],
    ['withheld, even with a name', view('withheld', REGISTRY), { kind: 'code_only', name: null }],
    ['an unknown naming value', view('something_new', REGISTRY), { kind: 'code_only', name: null }],
    ['a null naming value', view(null, REGISTRY), { kind: 'code_only', name: null }],
    ['named with no name', view('named', null), { kind: 'code_only', name: null }],
    ['masked with no name', view('masked', null), { kind: 'code_only', name: null }],
    [
      'named, the name carrying a personal code',
      view('named', CODED_NAME),
      { kind: 'code_only', name: null },
    ],
    [
      'masked, the name carrying a personal code',
      view('masked', CODED_NAME),
      { kind: 'code_only', name: null },
    ],
    [
      'named, the name carrying 11 digits',
      view('named', 'FIRMA 12345678901 SRL'),
      { kind: 'code_only', name: null },
    ],
    [
      'masked, the name carrying 12 split digits',
      view('masked', 'EXEMPLU 123 456 789 012'),
      { kind: 'code_only', name: null },
    ],
    [
      'named, a 10-digit number is not a person code',
      view('named', 'FIRMA 1234567890 SRL'),
      { kind: 'company', name: 'FIRMA 1234567890 SRL' },
    ],
    [
      'named, 11 digits split by NEL (U+0085, outside \\s)',
      view('named', 'FIRMA 12345\u008567890 1 SRL'.replace(' 1 ', '1 ')),
      { kind: 'code_only', name: null },
    ],
    ['code_shown false', view('named', REGISTRY, false), { kind: 'hidden', name: null }],
    ['code_shown null', view('masked', MASKED, null), { kind: 'hidden', name: null }],
    ['no row', undefined, { kind: 'code_only', name: null }],
  ] as const)('%s', (_label, row, expected) => {
    expect(namingFromView(row)).toEqual({
      ...expected,
      source: row === undefined ? 'none' : 'view',
    });
  });

  it('before the grant: a company, by its public registry name or with none', () => {
    expect(namingFromRegistry(REGISTRY)).toEqual({ kind: 'company', name: REGISTRY });
    expect(namingFromRegistry(undefined)).toEqual({ kind: 'company', name: null });
    expect(namingFromRegistry(CODED_NAME)).toEqual({ kind: 'company', name: null });
  });

  it('serves a name only for company and person_masked, always screened', () => {
    expect(servedSupplierName({ kind: 'company', name: REGISTRY })).toBe(REGISTRY);
    expect(servedSupplierName({ kind: 'person_masked', name: MASKED })).toBe(MASKED);
    expect(servedSupplierName({ kind: 'person_masked', name: CODED_NAME })).toBeNull();
    expect(servedSupplierName({ kind: 'code_only', name: REGISTRY })).toBeNull();
    expect(servedSupplierName({ kind: 'hidden', name: REGISTRY })).toBeNull();
  });
});

const DISCLOSED: DaPartyRecord = {
  portalPartyId: '900',
  name: null,
  fiscalCode: '14399840',
  fiscalCodeStatus: 'valid',
  supplierPublic: true,
};
const named = (naming: SupplierNaming): DaPartyRecord => ({
  ...DISCLOSED,
  name: naming.name,
  naming,
});
const WITHHELD = { displayKind: 'natural_person', partyId: null, name: null, fiscalCode: null };

describe('toSupplier', () => {
  it('serves each kind with its code, and a name only where the kind carries one', () => {
    expect(toSupplier(named({ kind: 'company', name: REGISTRY }))).toEqual({
      displayKind: 'company',
      partyId: '900',
      name: REGISTRY,
      fiscalCode: '14399840',
    });
    expect(toSupplier(named({ kind: 'person_masked', name: MASKED }))).toEqual({
      displayKind: 'person_masked',
      partyId: '900',
      name: MASKED,
      fiscalCode: '14399840',
    });
    expect(toSupplier(named({ kind: 'code_only', name: REGISTRY }))).toEqual({
      displayKind: 'code_only',
      partyId: '900',
      name: null,
      fiscalCode: '14399840',
    });
  });

  it('withholds a code the names view may not show, as D6 does', () => {
    expect(toSupplier(named({ kind: 'hidden', name: null }))).toEqual(WITHHELD);
  });

  it('leaves D6 the gate: a withheld supplier stays withheld whatever its naming says', () => {
    const gated = { ...named({ kind: 'company', name: REGISTRY }), supplierPublic: false };
    expect(toSupplier(gated)).toEqual(WITHHELD);
    const person = { ...named({ kind: 'person_masked', name: MASKED }), fiscalCode: SYNTHETIC_CNP };
    expect(toSupplier(person)).toEqual(WITHHELD);
  });

  it('without a naming, exactly as before step 2', () => {
    expect(toSupplier({ ...DISCLOSED, name: REGISTRY })).toEqual({
      displayKind: 'company',
      partyId: '900',
      name: REGISTRY,
      fiscalCode: '14399840',
    });
  });
});

describe('toTotalsGroup', () => {
  const group = (party: DaPartyRecord) => ({
    key: '14399840',
    supplierBucket: 'named' as const,
    party,
    countedValue: '5.00',
    countedCount: '1',
    symbolicPriceCount: '0',
    purchaseCount: '1',
  });

  it('keys a disclosed supplier group by its party and serves its kind', () => {
    const answer = toTotalsGroup(group(named({ kind: 'person_masked', name: MASKED })), 'supplier');
    expect(answer._unsafeUnwrap()).toMatchObject({
      key: '900',
      party: { displayKind: 'person_masked', name: MASKED, fiscalCode: '14399840' },
    });
  });

  it('refuses a ranked group whose code the names view may not show, naming nothing', () => {
    const answer = toTotalsGroup(group(named({ kind: 'hidden', name: null })), 'supplier');
    expect(answer._unsafeUnwrapErr().type).toBe('Database');
    expect(JSON.stringify(answer._unsafeUnwrapErr())).not.toContain('14399840');
  });
});

describe('supplierNamesByCode', () => {
  const db = (
    readable: boolean,
    viewRows: readonly unknown[],
    registryRows: readonly unknown[] = []
  ) => {
    const captured: CapturedQuery[] = [];
    const kysely = makeCapturingDb(captured, {
      respond: (text) => {
        if (text.includes('as names_readable')) return [{ names_readable: readable }];
        if (text.includes('supplier_names_public')) return viewRows;
        if (text.includes('party_public_names')) return registryRows;
        return [];
      },
    });
    return { kysely, captured };
  };

  it('with the grant: reads the view by code only, and names every code asked for', async () => {
    const { kysely, captured } = db(true, [
      { code: '14399840', naming: 'named', display_name: REGISTRY, code_shown: true },
      { code: '2000002', naming: 'masked', display_name: MASKED, code_shown: true },
      { code: '3000003', naming: 'withheld', display_name: null, code_shown: true },
    ]);
    const names = await supplierNamesByCode(kysely, [
      '14399840',
      '2000002',
      '3000003',
      '4000004',
      '14399840',
    ]);
    expect([...names]).toEqual([
      ['14399840', { kind: 'company', name: REGISTRY, source: 'view' }],
      ['2000002', { kind: 'person_masked', name: MASKED, source: 'view' }],
      ['3000003', { kind: 'code_only', name: null, source: 'view' }],
      // No row in the view: the code only.
      ['4000004', { kind: 'code_only', name: null, source: 'none' }],
    ]);
    const probe = captured.find((q) => q.sql.includes('as names_readable'));
    expect(probe?.sql).toContain("has_table_privilege(to_regclass($1), 'SELECT')");
    expect(probe?.parameters).toEqual(['procurement_v3.supplier_names_public']);
    const reads = captured.filter((q) => q.sql.includes('supplier_names_public'));
    expect(reads).toHaveLength(1);
    // Never the whole view: fenced by the page's codes.
    expect(reads[0]?.sql.trim()).toMatch(/where v\.fiscal_code_clean = any\(\$1::text\[\]\)$/u);
    expect(reads[0]?.parameters).toEqual([['14399840', '2000002', '3000003', '4000004']]);
    expect(captured.some((q) => q.sql.includes('party_public_names'))).toBe(false);
  });

  it('with the grant: two rows for one code serve the stricter', async () => {
    const { kysely } = db(true, [
      { code: '14399840', naming: 'named', display_name: REGISTRY, code_shown: true },
      { code: '14399840', naming: 'masked', display_name: MASKED, code_shown: true },
      { code: '2000002', naming: 'named', display_name: REGISTRY, code_shown: true },
      { code: '2000002', naming: 'named', display_name: REGISTRY, code_shown: false },
    ]);
    const names = await supplierNamesByCode(kysely, ['14399840', '2000002']);
    expect(names.get('14399840')).toEqual({ kind: 'person_masked', name: MASKED, source: 'view' });
    expect(names.get('2000002')).toEqual({ kind: 'hidden', name: null, source: 'view' });
  });

  it('without the grant: exactly the registry read of before step 2, and never the view', async () => {
    const { kysely, captured } = db(
      false,
      [{ code: '14399840', naming: 'masked', display_name: MASKED, code_shown: true }],
      [{ code: '14399840', name: REGISTRY }]
    );
    const names = await supplierNamesByCode(kysely, ['14399840', '2000002']);
    expect([...names]).toEqual([
      ['14399840', { kind: 'company', name: REGISTRY }],
      ['2000002', { kind: 'company', name: null }],
    ]);
    const lookup = captured.find((q) => q.sql.includes('party_public_names'));
    expect(lookup?.sql).toContain(
      'where n.fiscal_code_clean = any($1::text[]) and n.supplier_name_public is true'
    );
    expect(captured.some((q) => q.sql.includes('supplier_names_public'))).toBe(false);
  });

  it('fails a lookup with only its SQLSTATE, never the database message', async () => {
    const kysely = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('as names_readable')) return [{ names_readable: true }];
        throw Object.assign(new Error(`invalid input syntax: "${SYNTHETIC_CNP}"`), {
          code: '22P02',
        });
      },
    });
    const failure = await supplierNamesByCode(kysely, ['14399840']).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: '22P02',
      message: 'Supplier names lookup failed (22P02)',
    });
    expect(JSON.stringify(failure)).not.toContain(SYNTHETIC_CNP);
    expect((failure as Error).message).not.toContain(SYNTHETIC_CNP);
    expect((failure as Error).cause).toBeUndefined();
  });

  it('reads nothing, not even the grant, for a page with no supplier code', async () => {
    const { kysely, captured } = db(true, []);
    expect((await supplierNamesByCode(kysely, [])).size).toBe(0);
    expect(captured).toHaveLength(0);
  });
});

describe('DA supplier buckets', () => {
  const breakdown = (names: ReadonlyMap<string, SupplierNaming>) => {
    const { repo } = fakeAnalysisRepo({
      generation: generation(undefined, { ...PUBLISHED_CAPABILITIES, directAcquisitionV3: true }),
      breakdown: {
        totals: statsRead({ rows: '10', withValue: '10', valueAwardedSum: '40' }),
        buckets: [
          { kind: 'top', key: '14399840', recordCount: '4', withValue: '4', valueAwardedSum: '16' },
          { kind: 'top', key: '2000002', recordCount: '3', withValue: '3', valueAwardedSum: '12' },
          { kind: 'top', key: '3000003', recordCount: '2', withValue: '2', valueAwardedSum: '8' },
          {
            kind: 'top',
            key: 'natural_person',
            recordCount: '1',
            withValue: '1',
            valueAwardedSum: '4',
          },
          { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
          { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
        ],
      },
    });
    return analysisBreakdown(
      { analysisRepo: repo, daSupplierNames: { namesOf: () => Promise.resolve(ok(names)) } },
      { scope: { grain: 'direct_acquisition' }, dimension: 'supplier', topN: 5 }
    );
  };

  it('serves each bucket its kind and only the names a kind carries', async () => {
    const result = await breakdown(
      new Map<string, SupplierNaming>([
        ['14399840', { kind: 'company', name: REGISTRY }],
        ['2000002', { kind: 'person_masked', name: MASKED }],
        ['3000003', { kind: 'code_only', name: null }],
      ])
    );
    const top = (result._unsafeUnwrap()[0]?.buckets ?? []).filter((b) => b.kind === 'top');
    expect(top.map((b) => [b.key, b.displayKind, b.displayName])).toEqual([
      ['14399840', 'company', REGISTRY],
      ['2000002', 'person_masked', MASKED],
      ['3000003', 'code_only', null],
      ['natural_person', 'natural_person', null],
    ]);
  });

  it('refuses the whole breakdown when it ranks a code the names view may not show', async () => {
    const result = await breakdown(
      new Map<string, SupplierNaming>([
        ['14399840', { kind: 'company', name: REGISTRY }],
        ['2000002', { kind: 'hidden', name: null }],
        ['3000003', { kind: 'code_only', name: null }],
      ])
    );
    expect(result._unsafeUnwrapErr().type).toBe('Database');
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain('2000002');
  });
});

describe('naming step 2b: a code shown without D6 disclosing it', () => {
  it.each([
    [
      'masked',
      { kind: 'person_masked', name: MASKED, source: 'view' },
      { kind: 'person_masked', name: MASKED, source: 'view' },
    ],
    [
      'named: never the registry name',
      { kind: 'company', name: REGISTRY, source: 'view' },
      { kind: 'code_only', name: null, source: 'view' },
    ],
    [
      'code only',
      { kind: 'code_only', name: null, source: 'view' },
      { kind: 'code_only', name: null, source: 'view' },
    ],
    [
      'no row in the view',
      { kind: 'code_only', name: null, source: 'none' },
      { kind: 'hidden', name: null },
    ],
    [
      'before the grant (the registry rule)',
      { kind: 'company', name: REGISTRY },
      { kind: 'hidden', name: null },
    ],
    [
      'a code the view hides',
      { kind: 'hidden', name: null, source: 'view' },
      { kind: 'hidden', name: null },
    ],
  ] as const)('%s', (_label, naming: SupplierNaming, expected) => {
    expect(undisclosedNaming(naming)).toEqual(expected);
  });

  const undisclosed = (naming: SupplierNaming | undefined): DaPartyRecord => ({
    ...DISCLOSED,
    supplierPublic: false,
    supplierUndisclosed: true,
    ...(naming !== undefined && { naming }),
  });

  it('serves the code with its masked name, or the code only', () => {
    expect(
      toSupplier(undisclosed({ kind: 'person_masked', name: MASKED, source: 'view' }))
    ).toEqual({
      displayKind: 'person_masked',
      partyId: null,
      name: MASKED,
      fiscalCode: '14399840',
    });
    expect(toSupplier(undisclosed({ kind: 'company', name: REGISTRY, source: 'view' }))).toEqual({
      displayKind: 'code_only',
      partyId: null,
      name: null,
      fiscalCode: '14399840',
    });
  });

  it('withholds it without a view naming, with a person code, or when not marked shown', () => {
    for (const party of [
      undisclosed(undefined),
      undisclosed({ kind: 'company', name: REGISTRY }),
      undisclosed({ kind: 'code_only', name: null, source: 'none' }),
      undisclosed({ kind: 'hidden', name: null, source: 'view' }),
      {
        ...undisclosed({ kind: 'person_masked', name: MASKED, source: 'view' }),
        fiscalCode: SYNTHETIC_CNP,
      },
      {
        ...undisclosed({ kind: 'person_masked', name: MASKED, source: 'view' }),
        supplierUndisclosed: false,
      },
      {
        ...undisclosed({ kind: 'person_masked', name: MASKED, source: 'view' }),
        fiscalCodeStatus: 'invalid',
      },
    ]) {
      expect(toSupplier(party)).toEqual(WITHHELD);
    }
  });

  it('never makes a shown-only supplier its own totals group', () => {
    const answer = toTotalsGroup(
      {
        key: null,
        supplierBucket: 'withheld',
        party: null,
        countedValue: '5.00',
        countedCount: '1',
        symbolicPriceCount: '0',
        purchaseCount: '1',
      },
      'supplier'
    );
    expect(answer._unsafeUnwrap()).toMatchObject({ key: 'natural_person', party: WITHHELD });
  });
});
