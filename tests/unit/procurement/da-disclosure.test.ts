/**
 * Site-wide D6 and the free-text gate on the legacy direct-acquisition reads:
 * the decorator over the procurement repository, with the rule enforced and
 * off. Public set: the company only. The sole trader, the CNP-coded person and
 * a supplier with no code are all withheld, and their names never leave.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { withDaDisclosure } from '@/modules/procurement/shell/repo/da-disclosure-repo.js';
import {
  FiscalCodeSet,
  type FilterInput,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import type { ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type {
  DirectAcquisitionDetail,
  ProcurementDirectAcquisition,
  SupplierRecordConnection,
} from '@/modules/procurement/core/types.js';

const COMPANY = '14399840';
const SOLE_TRADER = '30254716';
const PERSON = '2850101123456';

const da = (id: string, supplierCui: string | null, supplierName: string | null) =>
  ({
    daId: id,
    title: `SECRET title ${id}`,
    authorityCui: '4305857',
    authorityName: 'COMUNA EXEMPLU',
    supplierCui,
    supplierName,
    cpvCode: '44110000-4',
    valueRon: '100.00',
  }) as unknown as ProcurementDirectAcquisition;

const ROWS = [
  da('1', COMPANY, 'FIRMA EXEMPLU SRL'),
  da('2', SOLE_TRADER, 'SECRET POPESCU ION PFA'),
  da('3', PERSON, 'SECRET IONESCU MARIA'),
  da('4', null, 'SECRET NO CODE'),
];

const fakeRepo = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const repo = {
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
    listDirectAcquisitions: (f: FilterInput) => {
      note('list', f);
      return Promise.resolve(ok({ items: ROWS, next: null }));
    },
    searchDirectAcquisitionsOffset: (f: unknown, _p: unknown, facets?: readonly string[]) => {
      note('search', f, facets);
      return Promise.resolve(
        ok({ items: ROWS, total: 4, estimated: false, highlights: [{ supplierName: 'SECRET' }] })
      );
    },
    getDirectAcquisition: (id: string) =>
      Promise.resolve(ok(ROWS.find((r) => r.daId === id) ?? null)),
    getDirectAcquisitionDetail: (id: string) =>
      Promise.resolve(
        ok({
          directAcquisition: ROWS.find((r) => r.daId === id),
          duplicates: [],
          detailAvailability: 'available',
          detail: {
            description: 'SECRET description',
            deliveryCondition: 'SECRET delivery',
            paymentCondition: 'SECRET payment',
            caRejectionReason: null,
            supplierRejectionReason: null,
            correctionReason: 'SECRET correction',
            textRedacted: false,
            items: [
              {
                catalogItemName: 'SECRET item',
                catalogItemDescription: 'SECRET desc',
                itemMeasureUnit: 'SECRET 0722 000 000',
                cpvText: 'SECRET cpv text',
                cpvCode: '44110000-4',
              },
            ],
            contractTypeText: 'SECRET type',
            euFundText: 'SECRET fund',
          },
        } as unknown as DirectAcquisitionDetail)
      ),
    supplierRecords: (cui: string, _f: number, _a: unknown, _c: boolean, includeDas?: boolean) => {
      note('records', cui, includeDas);
      const connection: SupplierRecordConnection = {
        total: null,
        hasNextPage: false,
        endCursor: null,
        edges: (includeDas === false ? [] : ROWS.filter((r) => r.supplierCui === cui)).map((r) => ({
          cursor: r.daId,
          node: { grain: 'direct_acquisition', directAcquisition: r },
        })),
      };
      return Promise.resolve(ok(connection));
    },
  } as unknown as ProcurementRepo;
  return { calls, repo };
};

const enforced: SupplierDisclosurePort = {
  enforced: true,
  privacyAsOf: () => Promise.resolve(ok(null)),
  publicSupplierCodes: () => Promise.resolve(ok(new Set([COMPANY]))),
};

describe('legacy DA disclosure, enforced', () => {
  it('names only public suppliers and withholds every title, with the CPV label in its place', async () => {
    const { repo } = fakeRepo();
    const page = (
      await withDaDisclosure(repo, enforced).listDirectAcquisitions({}, { first: 10 })
    )._unsafeUnwrap();
    expect(JSON.stringify(page)).not.toContain('SECRET');
    expect(page.items.map((d) => [d.supplierCui, d.supplierName, d.supplierDisplayKind])).toEqual([
      [COMPANY, 'FIRMA EXEMPLU SRL', 'company'],
      [null, null, 'natural_person'],
      [null, null, 'natural_person'],
      [null, null, 'natural_person'],
    ]);
    expect(page.items.every((d) => d.title === null && d.titleWithheld === 'privacy')).toBe(true);
    expect(page.items[0]?.cpvLabel).toBe('Materiale de constructii');
  });

  it('matches nothing for a withheld supplier filter and keeps only public codes in a list', async () => {
    const { calls, repo } = fakeRepo();
    const gated = withDaDisclosure(repo, enforced);
    const none = await gated.listDirectAcquisitions(
      { supplierCui: { in: [SOLE_TRADER] } },
      { first: 10 }
    );
    expect(none._unsafeUnwrap().items).toEqual([]);
    await gated.listDirectAcquisitions(
      { supplierCui: { in: [SOLE_TRADER, COMPANY] } },
      { first: 10 }
    );
    expect(calls.filter((c) => c.method === 'list').map((c) => c.args[0])).toEqual([
      { supplierCui: { in: [COMPANY] } },
    ]);
    const search = await gated.searchDirectAcquisitionsOffset({ supplierCui: PERSON }, {
      page: 1,
      pageSize: 10,
    } as never);
    expect(search._unsafeUnwrap()).toEqual({ items: [], total: 0, estimated: false });
  });

  it('refuses free-text search and supplier geography, and drops highlights', async () => {
    const { repo } = fakeRepo();
    const gated = withDaDisclosure(repo, enforced);
    const page = { page: 1, pageSize: 10 } as never;
    expect(
      (await gated.searchDirectAcquisitionsOffset({ q: 'popescu' }, page))._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
    expect(
      (await gated.searchDirectAcquisitionsOffset({ supplierGeo: {} }, page))._unsafeUnwrapErr()
        .type
    ).toBe('InvalidInput');
    expect(
      (await gated.searchDirectAcquisitionsOffset({}, page, ['supplierCounty']))._unsafeUnwrapErr()
        .type
    ).toBe('InvalidInput');
    const served = (
      await gated.searchDirectAcquisitionsOffset({ authorityCui: '4305857' }, page)
    )._unsafeUnwrap();
    expect(served.highlights).toBeUndefined();
    expect(JSON.stringify(served)).not.toContain('SECRET');
  });

  it('withholds the detail free text and item names', async () => {
    const { repo } = fakeRepo();
    const detail = (
      await withDaDisclosure(repo, enforced).getDirectAcquisitionDetail('2')
    )._unsafeUnwrap();
    expect(JSON.stringify(detail)).not.toContain('SECRET');
    expect(detail?.detail?.textRedacted).toBe(true);
    expect(detail?.detail?.items[0]?.cpvCode).toBe('44110000-4');
  });

  it("leaves a withheld supplier's records without direct acquisitions", async () => {
    const { calls, repo } = fakeRepo();
    const gated = withDaDisclosure(repo, enforced);
    const pfa = (await gated.supplierRecords(SOLE_TRADER, 10, undefined, false))._unsafeUnwrap();
    expect(pfa.edges).toEqual([]);
    await gated.supplierRecords(COMPANY, 10, undefined, false);
    expect(calls.filter((c) => c.method === 'records').map((c) => c.args)).toEqual([
      [SOLE_TRADER, false],
      [COMPANY, true],
    ]);
  });
});

describe('legacy DA disclosure, padded codes', () => {
  // The kernel's public set, as the supplier-disclosure repo returns it.
  const padded: SupplierDisclosurePort = {
    enforced: true,
    privacyAsOf: () => Promise.resolve(ok(null)),
    publicSupplierCodes: () => Promise.resolve(ok(new FiscalCodeSet([COMPANY]))),
  };
  const PADDED = `00${COMPANY}`; // 10 digits: still a CUI, the public company
  const OVERLONG = `00000${COMPANY}`; // 13 digits: no company code, never the company
  const rows = [da('1', PADDED, 'FIRMA EXEMPLU SRL'), da('2', OVERLONG, 'SECRET OVERLONG')];
  const repoOf = () => {
    const filters: FilterInput[] = [];
    const repo = {
      listCpvCodeLabels: () => Promise.resolve(ok([])),
      listDirectAcquisitions: (f: FilterInput) => {
        filters.push(f);
        const wanted = (f['supplierCui'] as { in?: readonly string[] } | undefined)?.in;
        return Promise.resolve(
          ok({
            items: rows.filter((r) => wanted === undefined || wanted.includes(r.supplierCui ?? '')),
            next: null,
          })
        );
      },
      getDirectAcquisition: (id: string) =>
        Promise.resolve(ok(rows.find((r) => r.daId === id) ?? null)),
    } as unknown as ProcurementRepo;
    return { filters, repo };
  };

  it('names a padded public company after the final check and never an overlong padded code', async () => {
    const { repo } = repoOf();
    const gated = withDaDisclosure(repo, padded);
    const page = (await gated.listDirectAcquisitions({}, { first: 10 }))._unsafeUnwrap();
    expect(JSON.stringify(page)).not.toContain('SECRET');
    expect(page.items.map((d) => [d.supplierCui, d.supplierDisplayKind])).toEqual([
      [PADDED, 'company'],
      [null, 'natural_person'],
    ]);
    const detail = (await gated.getDirectAcquisition('2'))._unsafeUnwrap();
    expect([detail?.supplierCui, detail?.supplierName]).toEqual([null, null]);
  });

  it('keeps a padded public filter code and matches nothing for an overlong one', async () => {
    const { filters, repo } = repoOf();
    const gated = withDaDisclosure(repo, padded);
    const scoped = (
      await gated.listDirectAcquisitions({ supplierCui: { in: [PADDED] } }, { first: 10 })
    )._unsafeUnwrap();
    expect(scoped.items.map((d) => d.supplierCui)).toEqual([PADDED]);
    const none = (
      await gated.listDirectAcquisitions({ supplierCui: { in: [OVERLONG] } }, { first: 10 })
    )._unsafeUnwrap();
    expect(none.items).toEqual([]);
    expect(filters).toEqual([{ supplierCui: { in: [PADDED] } }]);
  });
});

describe('legacy DA disclosure, not enforced', () => {
  it('returns the repository unchanged', () => {
    const { repo } = fakeRepo();
    expect(
      withDaDisclosure(repo, {
        enforced: false,
        privacyAsOf: () => Promise.resolve(ok(null)),
        publicSupplierCodes: enforced.publicSupplierCodes,
      })
    ).toBe(repo);
    expect(withDaDisclosure(repo, undefined)).toBe(repo);
  });
});
