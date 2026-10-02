/**
 * P26 reader paths on the REAL procurement DDL. Point
 * PROCUREMENT_LINK_TEST_DATABASE_URL at a THROWAWAY database built by the
 * scrapper's prod migration chain (`applyProdChainTo`); the suite seeds its own
 * rows and is skipped without that variable. Never point it at a live database.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeProcurementDetailRepo } from '@/modules/procurement/shell/repo/detail-repo.js';
import { makeProcurementRepo } from '@/modules/procurement/shell/repo/procurement-repo.js';

import type { ProcurementContract } from '@/modules/procurement/core/types.js';
import type { FilterInput, ProdDatabase } from '@/modules/shared/index.js';

const URL = process.env['PROCUREMENT_LINK_TEST_DATABASE_URL'] ?? '';
const d = URL.length > 0 ? describe : describe.skip;

const PROCEDURE_TITLE = 'Furnizare echipamente medicale pentru Spitalul Judetean';

d('procedure links on real DDL (P26)', () => {
  let pool: Pool;
  let db: Kysely<ProdDatabase>;
  const p: Record<string, string> = {};
  const c: Record<string, string> = {};

  const procedure = async (
    key: string,
    source: 'elicitatie' | 'seap_notice',
    ref: string,
    notice: string,
    buyer: string | null,
    kind: string
  ): Promise<void> => {
    const res = await pool.query<{ id: string }>(
      `insert into procurement.procedures
         (source_system, source_ref, notice_no, authority_cui, notice_kind, title, source_url)
       values ($1, $2, $3, $4, $5, $6, 'https://fixture.invalid/' || $2)
       returning procedure_id::text as id`,
      [source, `${source}:${ref}`, notice, buyer, kind, PROCEDURE_TITLE]
    );
    p[key] = res.rows[0]?.id ?? '';
  };

  const contract = async (
    key: string,
    input: {
      source: 'elicitatie_ca_award' | 'seap_contracts';
      parent: string | null;
      notice: string | null;
      buyer: string | null;
      caNoticeId?: string;
      canonical?: boolean;
      identity?: string;
      title?: string;
      dupMethod?: string;
    }
  ): Promise<void> => {
    const attrs =
      input.source === 'elicitatie_ca_award'
        ? { ca_notice_id: input.caNoticeId ?? null, contract_type: '2' }
        : {};
    const res = await pool.query<{ id: string }>(
      `insert into procurement.contracts
         (contract_key, source_system, procedure_id, notice_no, authority_cui,
          title, contract_date, is_canonical, canonical_contract_key,
          dup_method, dup_confidence, attrs, source_url)
       values ($1, $2, $3::bigint, $4, $5, $6, '2025-01-01', $7, $8, $9, $10, $11::jsonb,
               'https://fixture.invalid/' || $1)
       returning contract_id::text as id`,
      [
        key,
        input.source,
        input.parent,
        input.notice,
        input.buyer,
        input.title ?? null,
        input.canonical ?? true,
        input.identity ?? null,
        input.dupMethod ?? null,
        input.dupMethod === undefined ? null : 1,
        JSON.stringify(attrs),
      ]
    );
    c[key] = res.rows[0]?.id ?? '';
  };

  const native = (parent: string, caNoticeId: string, notice: string, buyer: string | null) => ({
    source: 'elicitatie_ca_award' as const,
    parent: p[parent] ?? null,
    notice,
    buyer,
    caNoticeId,
  });
  const seap = (parent: string | null, notice: string | null, buyer: string | null) => ({
    source: 'seap_contracts' as const,
    parent: parent === null ? null : (p[parent] ?? null),
    notice,
    buyer,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    await procedure('ownCa', 'elicitatie', '101', 'CAN1', '111', 'award_no_init');
    await procedure('siblingCa', 'elicitatie', '100', 'CAN1', '111', 'award_no_init');
    await procedure('scna', 'elicitatie', '200', 'SCNA1', '222', 'unknown');
    await procedure('call', 'seap_notice', 'call', '92137', '10874881', 'initiation');
    await procedure('seapAward', 'seap_notice', 'award', 'CAN9', '333', 'award_no_init');
    await procedure('ambiguousA', 'seap_notice', 'amb-a', 'CAN12', '444', 'award');
    await procedure('ambiguousB', 'seap_notice', 'amb-b', 'CAN12', '444', 'award_no_init');
    const ted = await pool.query<{ id: string }>(
      `insert into procurement.ted_notices
         (source_ref, publication_number, source_channel, source_url)
       values ('TED-1', 'TED-1', 'eforms', 'https://ted.example/TED-1')
       returning ted_notice_id::text as id`
    );
    await pool.query(
      `insert into procurement.procedure_ted_links
         (ted_source_ref, detail_source_ref, ted_notice_id, procedure_id, match_token, match_method)
       values ('TED-1', '100', $1::bigint, $2::bigint, 'TED1', 'publication_number')`,
      [ted.rows[0]?.id, p['siblingCa']]
    );

    await contract('ownLink', native('ownCa', '101', 'CAN1', '111'));
    await contract('siblingLink', native('siblingCa', '101', 'CAN1', '111'));
    await contract('scnaLink', native('scna', '200', 'SCNA1', '222'));
    await contract('noBuyer', native('scna', '200', 'SCNA1', null));
    await contract('otherBuyer', native('scna', '200', 'SCNA1', '999'));
    await contract('callOtherBuyer', seap('call', '92137', '4267117'));
    await contract('callSameBuyer', seap('call', '92137', '10874881'));
    await contract('seapAward', seap('seapAward', 'CAN9', '333'));
    await contract('ambiguous', seap('ambiguousA', 'CAN12', '444'));
    await contract('seapNoBuyer', seap('seapAward', 'CAN9', null));
    await contract('seapToNativeCa', seap('scna', 'SCNA1', '222'));
    // Matched-award title evidence: the other-buyer award must not count.
    await contract('titleless', { ...seap(null, 'CAN50', '555'), identity: 'K1' });
    await contract('awardOtherBuyer', {
      ...native('ownCa', '900', 'CAN50', '666'),
      parent: null,
      canonical: false,
      identity: 'K1',
      dupMethod: 'cross_source_suppressed',
      title: 'Lucrari de reabilitare a altei institutii',
    });
    await contract('awardSameBuyer', {
      ...native('ownCa', '901', 'CAN50', '555'),
      parent: null,
      canonical: false,
      identity: 'K1',
      dupMethod: 'cross_source_suppressed',
      title: 'Servicii de mentenanta pentru sediul autoritatii',
    });
    // The identity key carries no buyer: an unknown buyer on EITHER side, or a
    // different one, lends nothing. Each award title would be used otherwise.
    const award = (key: string, identity: string, caNoticeId: string, buyer: string | null) =>
      contract(key, {
        ...native('ownCa', caNoticeId, 'CAN60', buyer),
        parent: null,
        canonical: false,
        identity,
        dupMethod: 'cross_source_suppressed',
        title: `Furnizare echipamente informatice pentru sediul ${key}`,
      });
    await contract('contractBuyerMissing', { ...seap(null, 'CAN60', null), identity: 'K2' });
    await award('awardForMissingContractBuyer', 'K2', '902', '555');
    await contract('awardBuyerMissing', { ...seap(null, 'CAN61', '777'), identity: 'K3' });
    await award('awardWithoutBuyer', 'K3', '903', null);
    await contract('differentBuyerOnly', { ...seap(null, 'CAN62', '888'), identity: 'K4' });
    await award('awardOfAnotherBuyer', 'K4', '904', '999');
    // A native award keeps its own title whatever its buyer.
    await contract('nativeOwnTitle', {
      ...native('ownCa', '905', 'CAN63', null),
      parent: null,
      title: 'Titlu propriu al atribuirii native',
    });
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  const repo = () => makeProcurementRepo(db);

  const detail = async (key: string) => {
    const res = await repo().getContractDetail(c[key] ?? '');
    const value = res._unsafeUnwrap();
    if (value === null) throw new Error(`no contract ${key}`);
    return value;
  };

  it('serves only source-supported links on the contract detail, with no inherited TED', async () => {
    const linked: Record<string, string> = {
      ownLink: 'ownCa',
      scnaLink: 'scna',
      noBuyer: 'scna',
      seapAward: 'seapAward',
      seapToNativeCa: 'scna',
    };
    for (const [key, parent] of Object.entries(linked)) {
      const bundle = await detail(key);
      expect(bundle.contract.procedureId, key).toBe(p[parent]);
      expect(bundle.procedure?.procedureId, key).toBe(p[parent]);
    }
    for (const key of [
      'siblingLink',
      'otherBuyer',
      'callOtherBuyer',
      'callSameBuyer',
      'ambiguous',
      'seapNoBuyer',
    ]) {
      const bundle = await detail(key);
      expect(bundle.contract.procedureId, key).toBeNull();
      expect(bundle.procedure, key).toBeNull();
      expect(bundle.ted, key).toBeNull();
    }
  });

  it('lists only supported contracts on the procedure page; its own TED stays', async () => {
    const ids = async (key: string): Promise<string[]> => {
      const res = (await repo().getProcedureDetail(p[key] ?? ''))._unsafeUnwrap();
      return (res?.contracts ?? []).map((row) => row.contractId).sort();
    };
    expect(await ids('siblingCa')).toEqual([]);
    expect(await ids('call')).toEqual([]);
    expect(await ids('ambiguousA')).toEqual([]);
    expect(await ids('scna')).toEqual(
      [c['scnaLink'], c['noBuyer'], c['seapToNativeCa']].map(String).sort()
    );
    const sibling = (await repo().getProcedureDetail(p['siblingCa'] ?? ''))._unsafeUnwrap();
    expect(sibling?.ted?.tedNoticeNo).toBe('TED-1');
  });

  it('applies the same policy to the procedureId filter, the offset page and batch loads', async () => {
    const page = async (filter: FilterInput): Promise<string[]> =>
      (await repo().listContracts(filter, { first: 50 }))
        ._unsafeUnwrap()
        .items.map((row: ProcurementContract) => row.contractId)
        .sort();
    expect(await page({ procedureId: { eq: p['scna'] ?? '' } })).toEqual(
      [c['scnaLink'], c['noBuyer'], c['seapToNativeCa']].map(String).sort()
    );
    expect(await page({ procedureId: { eq: p['call'] ?? '' } })).toEqual([]);
    expect(await page({ procedureId: { isNull: true }, authorityCui: { eq: '10874881' } })).toEqual(
      [c['callSameBuyer']]
    );

    const offset = (
      await repo().searchContractsOffset(
        { authorityCui: '4267117' },
        { page: 1, pageSize: 10, sort: 'date_desc' }
      )
    )._unsafeUnwrap();
    expect(offset.items.map((row) => [row.contractId, row.procedureId])).toEqual([
      [c['callOtherBuyer'], null],
    ]);

    const batch = (
      await makeProcurementDetailRepo(db).contractsByIds([
        c['siblingLink'] ?? '',
        c['ownLink'] ?? '',
      ])
    )._unsafeUnwrap();
    expect(batch.get(c['siblingLink'] ?? '')?.procedureId).toBeNull();
    expect(batch.get(c['ownLink'] ?? '')?.procedureId).toBe(p['ownCa']);
  });

  it('never borrows a title from another institution', async () => {
    expect((await detail('seapAward')).contract.displayTitle).toMatchObject({
      text: PROCEDURE_TITLE,
      source: 'procedure',
    });
    expect((await detail('callOtherBuyer')).contract.displayTitle).toBeNull();
    // The exact native CA edge keeps serving the parent's title with an unknown buyer.
    expect((await detail('noBuyer')).contract.displayTitle).toMatchObject({
      text: PROCEDURE_TITLE,
      source: 'procedure',
    });
    expect((await detail('nativeOwnTitle')).contract.displayTitle).toMatchObject({
      text: 'Titlu propriu al atribuirii native',
      source: 'native',
    });
  });

  it('borrows a matched award title only when both buyers are present and equal', async () => {
    expect((await detail('titleless')).contract.displayTitle).toMatchObject({
      text: 'Servicii de mentenanta pentru sediul autoritatii',
      source: 'matched_award',
    });
    const keys = ['contractBuyerMissing', 'awardBuyerMissing', 'differentBuyerOnly'];
    const sources = Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => [key, (await detail(key)).contract.displayTitle?.source ?? null])
      )
    );
    expect(sources).toEqual({
      contractBuyerMissing: null,
      awardBuyerMissing: null,
      differentBuyerOnly: null,
    });
  });
});
