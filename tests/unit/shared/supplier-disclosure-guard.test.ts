/**
 * Guard for site-wide D6 on the kernel paths nothing calls yet: the per-flow
 * list, the counterparty network and the shared document view. The kernel
 * builds them ONLY through `makeDisclosedReadRepos`, so this drives that
 * function over a capturing database that answers every read with
 * direct-acquisition rows. With D6 enforced, no such row reaches the caller
 * and the flow SQL excludes the flow type; with it off, nothing changes.
 * Wiring one of these into a surface later cannot bypass D6 without breaking
 * this test.
 */
import { describe, expect, it } from 'vitest';

import { makeDisclosedReadRepos } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

const PERSON = 'SECRET POPESCU ION PFA';

const flowRow = {
  flow_id: '1',
  flow_type: 'direct_acquisition',
  source_id: 'da:1',
  source_ref: null,
  payer_cui: '4305857',
  payer_name: 'COMUNA EXEMPLU',
  payer_org_id: null,
  payee_cui: '30254716',
  payee_name: PERSON,
  payee_org_id: null,
  amount_ron: '100.00',
  currency: 'RON',
  flow_date: '2025-06-02',
  flow_year: 2025,
};

const docRow = {
  doc_id: 'procurement_direct_acquisition:1',
  doc_type: 'procurement_direct_acquisition',
  title: PERSON,
  body: PERSON,
  cuis: ['30254716'],
  visibility: 'public',
  privacy_class: 'public',
};

const build = (enforced: boolean) => {
  const captured: CapturedQuery[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (text.includes('money_flows')) {
        // Answer only reads that do NOT exclude the DA flow type, as Postgres would.
        return /"?flow_type"? not in/u.test(text) ? [] : [flowRow];
      }
      if (text.includes('search.documents') || text.includes('"search"."documents"')) {
        // As Postgres would: a statement that excludes the DA doc type returns no DA row.
        if (/"?doc_type"? not in/u.test(text))
          return text.includes('count(*)') ? [{ total: '0' }] : [];
        return text.includes('count(*)') ? [{ total: '1' }] : [docRow];
      }
      return [];
    },
  });
  return { captured, repos: makeDisclosedReadRepos(db, enforced) };
};

describe('D6 guard on the latent kernel paths, enforced', () => {
  it('listFlows serves no direct-acquisition flow and its SQL excludes the type', async () => {
    const { captured, repos } = build(true);
    const page = await repos.flowsRepo.listFlows('4305857', { direction: 'out', limit: 10 });
    expect(JSON.stringify(page)).not.toContain('SECRET');
    const typed = await repos.flowsRepo.listFlows('4305857', {
      direction: 'out',
      limit: 10,
      flowType: 'direct_acquisition',
    });
    expect(typed._unsafeUnwrap().items).toEqual([]);
    expect(captured.some((q) => q.sql.includes('money_flows') && q.sql.includes('not in'))).toBe(
      true
    );
  });

  it('the counterparty network names no direct-acquisition counterparty', async () => {
    const { repos } = build(true);
    const network = await repos.flowsRepo.getCounterpartyNetwork('4305857', 1, 10);
    expect(JSON.stringify(network)).not.toContain('SECRET');
  });

  it('the document view serves no direct-acquisition document', async () => {
    const { repos } = build(true);
    expect(JSON.stringify(await repos.documentRepo.findById(docRow.doc_id))).not.toContain(
      'SECRET'
    );
    expect(JSON.stringify(await repos.documentRepo.listByCui('4305857', 10))).not.toContain(
      'SECRET'
    );
  });
});

describe('D6 guard on the document count', () => {
  it('never counts a direct-acquisition document while enforced', async () => {
    const on = build(true);
    expect((await on.repos.searchRepo.countByCui('30254716'))._unsafeUnwrap()).toBe(0);
    const off = build(false);
    expect((await off.repos.searchRepo.countByCui('30254716'))._unsafeUnwrap()).toBe(1);
  });
});

describe('D6 guard off', () => {
  it('passes direct-acquisition rows through unchanged', async () => {
    const { repos } = build(false);
    const page = await repos.flowsRepo.listFlows('4305857', { direction: 'out', limit: 10 });
    expect(JSON.stringify(page)).toContain('SECRET');
  });
});
