/**
 * P33 e-licitatie pages on the REAL procurement DDL. Point
 * PROCUREMENT_LINK_TEST_DATABASE_URL at a THROWAWAY database built by the
 * scrapper's prod migration chain (`applyProdChainTo`); the suite seeds its own
 * rows (numbers and buyers in the 33xxx range, distinct from the P26 suite) and
 * is skipped without that variable. Never point it at a live database.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeElicitatiePageRepo } from '@/modules/procurement/shell/repo/elicitatie-page-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const URL = process.env['PROCUREMENT_LINK_TEST_DATABASE_URL'] ?? '';
const d = URL.length > 0 ? describe : describe.skip;

const NOTICE = 'https://e-licitatie.ro/pub/notices/ca-notices/view-c/';

d('e-licitatie pages on real DDL (P33)', () => {
  let pool: Pool;
  let db: Kysely<ProdDatabase>;
  const p: Record<string, string> = {};
  const c: Record<string, string> = {};
  const m: Record<string, string> = {};
  const d: string[] = [];

  const procedure = async (
    key: string,
    source: 'elicitatie' | 'seap_notice',
    ref: string,
    notice: string | null,
    buyer: string | null,
    kind: string,
    privacy: 'public' | 'restricted' = 'public'
  ): Promise<void> => {
    const res = await pool.query<{ id: string }>(
      `insert into procurement.procedures
         (source_system, source_ref, notice_no, authority_cui, notice_kind, privacy_class,
          source_url)
       values ($1, $2, $3, $4, $5, $6, 'https://fixture.invalid/' || $2)
       returning procedure_id::text as id`,
      [source, `${source}:${ref}`, notice, buyer, kind, privacy]
    );
    p[key] = res.rows[0]?.id ?? '';
  };

  const contract = async (
    key: string,
    source: 'elicitatie_ca_award' | 'seap_contracts',
    notice: string | null,
    buyer: string | null,
    caNoticeId?: string,
    supplier: { readonly cui: string; readonly date: string } | null = null,
    procedureId: string | null = null,
    privacy: 'public' | 'restricted' = 'public'
  ): Promise<void> => {
    // The P04 marker fence requires a native award's contract_type (1 = standalone).
    const attrs =
      source === 'elicitatie_ca_award'
        ? { ca_notice_id: caNoticeId ?? null, contract_type: '1' }
        : {};
    const res = await pool.query<{ id: string }>(
      `insert into procurement.contracts
         (contract_key, source_system, notice_no, authority_cui, supplier_cui, contract_date,
          attrs, procedure_id, privacy_class, source_url)
       values ($1, $2, $3, $4, $5, $6::date, $7::jsonb, $8::bigint, $9,
               'https://fixture.invalid/' || $1)
       returning contract_id::text as id`,
      [
        `p33:${key}`,
        source,
        notice,
        buyer,
        supplier?.cui ?? null,
        supplier?.date ?? null,
        JSON.stringify(attrs),
        procedureId,
        privacy,
      ]
    );
    c[key] = res.rows[0]?.id ?? '';
  };

  const modification = async (
    key: string,
    notice: string | null,
    buyer: string | null
  ): Promise<void> => {
    const res = await pool.query<{ id: string }>(
      `insert into procurement.contract_modifications
         (source_ref, notice_no, authority_cui, source_url)
       values ($1, $2, $3, 'https://fixture.invalid/' || $1)
       returning modification_id::text as id`,
      [`seap_mod:p33-${key}`, notice, buyer]
    );
    m[key] = res.rows[0]?.id ?? '';
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });

    // Captured e-licitatie notices.
    await procedure('native', 'elicitatie', '100033001', 'CAN33001', '33001', 'award_no_init');
    await procedure('twinA', 'elicitatie', '100033002', 'CAN33002', '33002', 'award_no_init');
    await procedure('twinB', 'elicitatie', '100033012', 'CAN33002', '33002', 'award_no_init');
    // PCA/SCNA native rows carry the generic kind 'unknown'; they still count.
    await procedure('scna', 'elicitatie', '100033003', 'SCNA33003', '33003', 'unknown');
    // A restricted native notice is never served, and still counts as a candidate.
    await procedure(
      'restricted',
      'elicitatie',
      '100033005',
      'CAN33005',
      '33005',
      'unknown',
      'restricted'
    );
    await procedure('pairPublic', 'elicitatie', '100033006', 'CAN33006', '33006', 'award_no_init');
    await procedure(
      'pairRestricted',
      'elicitatie',
      '100033016',
      'CAN33006',
      '33006',
      'award_no_init',
      'restricted'
    );
    // An old digits-only number, captured natively with its award.
    await procedure('digits', 'elicitatie', '100033004', '330004', '33004', 'unknown');

    // data.gov.ro notices.
    await procedure('seapAward', 'seap_notice', 'p33-award', 'CAN33001', '33001', 'award_no_init');
    // An initiation number equal to an award number is a coincidence, never a link.
    await procedure('seapCall', 'seap_notice', 'p33-call', 'CAN33001', '33001', 'initiation');
    // A digits-only award notice carries no supplier evidence: never a link.
    await procedure('seapDigits', 'seap_notice', 'p33-digits', '330004', '33004', 'award_no_init');

    await contract('exact', 'seap_contracts', 'CAN33001', '33001');
    await contract('ambiguous', 'seap_contracts', 'CAN33002', '33002');
    await contract('otherBuyer', 'seap_contracts', 'CAN33001', '99999');
    await contract('noBuyer', 'seap_contracts', 'CAN33001', null);
    await contract('blankNumber', 'seap_contracts', ' ', '33001');
    await contract('caseDiffers', 'seap_contracts', 'can33001', '33001');
    await contract('scna', 'seap_contracts', 'SCNA33003', '33003');
    await contract('nativeAward', 'elicitatie_ca_award', 'CAN33009', '33009', '100033009');
    await contract('nativeAwardNoId', 'elicitatie_ca_award', 'CAN33001', '33001');

    // Digits-only numbers repeat across years: the native award must name the same
    // supplier within 31 days of the contract date.
    // The loader stores a native award's own notice as its procedure_id.
    await contract(
      'digitsAward',
      'elicitatie_ca_award',
      '330004',
      '33004',
      '100033004',
      { cui: '44001', date: '2016-03-10' },
      p['digits'] ?? null
    );
    await contract('digitsSameSupplier', 'seap_contracts', '330004', '33004', undefined, {
      cui: '44001',
      date: '2016-03-31',
    });
    await contract('digitsOtherSupplier', 'seap_contracts', '330004', '33004', undefined, {
      cui: '44002',
      date: '2016-03-10',
    });
    await contract('digitsLongGap', 'seap_contracts', '330004', '33004', undefined, {
      cui: '44001',
      date: '2016-05-10',
    });
    await contract('digitsNoSupplier', 'seap_contracts', '330004', '33004');

    await contract('toRestricted', 'seap_contracts', 'CAN33005', '33005');
    await contract('toPublicOfRestrictedPair', 'seap_contracts', 'CAN33006', '33006');
    await contract(
      'restrictedSource',
      'seap_contracts',
      'CAN33001',
      '33001',
      undefined,
      null,
      null,
      'restricted'
    );

    const da = await pool.query<{ id: string }>(
      `insert into procurement.direct_acquisitions
         (da_key, source_system, value_ron, value_rules_version, source_url)
       values ('elicitatie_da:121033001', 'elicitatie_da', 1, 6, 'https://fixture.invalid/da1'),
              ('seap_da:p33-da', 'seap_da', 1, 6, 'https://fixture.invalid/da2')
       returning da_id::text as id`
    );
    d.push(...da.rows.map((row) => row.id));

    await modification('exact', 'CAN33001', '33001');
    await modification('ambiguous', 'CAN33002', '33002');
    await modification('digits', '330004', '33004');
  });

  afterAll(async () => {
    await pool.query(
      `delete from procurement.contract_modifications where source_ref like 'seap_mod:p33-%'`
    );
    await pool.query(`delete from procurement.contracts where contract_key like 'p33:%'`);
    await pool.query(
      `delete from procurement.direct_acquisitions
        where da_key in ('elicitatie_da:121033001', 'seap_da:p33-da')`
    );
    await pool.query(
      `delete from procurement.procedures where source_ref in
         ('elicitatie:100033001', 'elicitatie:100033002', 'elicitatie:100033012',
          'elicitatie:100033003', 'elicitatie:100033004', 'elicitatie:100033005',
          'elicitatie:100033006', 'elicitatie:100033016', 'seap_notice:p33-award',
          'seap_notice:p33-call', 'seap_notice:p33-digits')`
    );
    await db.destroy();
  });

  it('links contracts only on an exact, unique number and buyer match', async () => {
    const pages = (await makeElicitatiePageRepo(db).forContracts(Object.values(c)))._unsafeUnwrap();
    expect(pages.get(c['exact'] ?? '')).toEqual({
      url: `${NOTICE}100033001`,
      kind: 'award_notice',
      match: 'number_and_buyer',
    });
    expect(pages.get(c['scna'] ?? '')?.url).toBe(`${NOTICE}100033003`);
    expect(pages.get(c['digitsSameSupplier'] ?? '')?.url).toBe(`${NOTICE}100033004`);
    expect(pages.get(c['digitsAward'] ?? '')?.match).toBe('own_record');
    expect(pages.get(c['nativeAward'] ?? '')).toEqual({
      url: `${NOTICE}100033009`,
      kind: 'award_notice',
      match: 'own_record',
    });
    for (const unlinked of [
      'ambiguous',
      'otherBuyer',
      'noBuyer',
      'blankNumber',
      'caseDiffers',
      // A native award without its own id is not resolved by number.
      'nativeAwardNoId',
      'digitsOtherSupplier',
      'digitsLongGap',
      'digitsNoSupplier',
      // Privacy: a restricted candidate is never served and still counts.
      'toRestricted',
      'toPublicOfRestrictedPair',
      'restrictedSource',
    ]) {
      expect(pages.has(c[unlinked] ?? ''), unlinked).toBe(false);
    }
  });

  it('links modifications by the same rule', async () => {
    const pages = (
      await makeElicitatiePageRepo(db).forModifications(Object.values(m))
    )._unsafeUnwrap();
    expect(pages.get(m['exact'] ?? '')?.url).toBe(`${NOTICE}100033001`);
    expect(pages.has(m['ambiguous'] ?? '')).toBe(false);
    expect(pages.has(m['digits'] ?? '')).toBe(false);
  });

  it('links native notices to themselves and only award-kind data.gov.ro notices', async () => {
    const pages = (
      await makeElicitatiePageRepo(db).forProcedures(Object.values(p))
    )._unsafeUnwrap();
    expect(pages.get(p['native'] ?? '')).toEqual({
      url: `${NOTICE}100033001`,
      kind: 'award_notice',
      match: 'own_record',
    });
    expect(pages.get(p['seapAward'] ?? '')).toEqual({
      url: `${NOTICE}100033001`,
      kind: 'award_notice',
      match: 'number_and_buyer',
    });
    expect(pages.has(p['seapCall'] ?? '')).toBe(false);
    expect(pages.has(p['seapDigits'] ?? '')).toBe(false);
    // A native notice always links to itself, whatever its number's shape.
    expect(pages.get(p['digits'] ?? '')?.match).toBe('own_record');
  });

  it('gives an e-licitatie direct purchase its own page and a data.gov.ro one none', async () => {
    const pages = (await makeElicitatiePageRepo(db).forDirectAcquisitions(d))._unsafeUnwrap();
    expect(pages.get(d[0] ?? '')).toEqual({
      url: 'https://e-licitatie.ro/pub/direct-acquisition/view/121033001',
      kind: 'direct_acquisition',
      match: 'own_record',
    });
    expect(pages.has(d[1] ?? '')).toBe(false);
  });
});
