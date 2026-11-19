/**
 * Direct acquisitions release 1 — records built from the serving contract's
 * example rows (DIRECT_ACQUISITION_SERVING_CONTRACT.md, one per case), and an
 * in-memory repository.
 *
 * The fake is deliberately ADVERSARIAL on D6: it hands the core every party's
 * real name and code, and in supplier totals it marks every supplier group as
 * "named". Whatever reaches a response is therefore decided by the core rule
 * alone. Every non-company supplier's name starts with SECRET, so a surface
 * test can search the whole response body for it.
 *
 * It also records which snapshot each read ran in, so tests can prove one
 * request reads through exactly one snapshot handle.
 */
import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';

import type {
  DaPurchaseFilter,
  DaReleaseReader,
  DaReleaseRepo,
} from '@/modules/procurement/core/da-release-ports.js';
import type {
  DaItemRecord,
  DaPartyRecord,
  DaPurchaseRecord,
  DaRuleRecord,
  DaTotalsGroupRecord,
  DaTotalsRecord,
} from '@/modules/procurement/core/da-release.js';

export const DATA_AS_OF = '2026-11-18T03:10:00Z';
export const SECRET = 'SECRET';

const hex = (n: number): string => n.toString(16).padStart(64, '0');

// ── Parties ──────────────────────────────────────────────────────────────────

export const BUYER: DaPartyRecord = {
  portalPartyId: '7302',
  name: 'COMUNA EXEMPLU',
  fiscalCode: '4305857',
  fiscalCodeStatus: 'valid',
  supplierPublic: false,
};
/** A buyer whose code fails the checksum: the name is served, the code is not. */
export const BUYER_BAD_CODE: DaPartyRecord = {
  portalPartyId: '7303',
  name: 'SCOALA GIMNAZIALA EXEMPLU',
  fiscalCode: '1234567',
  fiscalCodeStatus: 'checksum_failed',
  supplierPublic: false,
};
export const COMPANY: DaPartyRecord = {
  portalPartyId: '900',
  name: 'FIRMA EXEMPLU SRL',
  fiscalCode: '14399840',
  fiscalCodeStatus: 'valid',
  supplierPublic: true,
};
/** Valid code, but a sole trader (PFA): not public in supplier_privacy. */
export const SOLE_TRADER: DaPartyRecord = {
  portalPartyId: '901',
  name: `${SECRET} POPESCU ION PFA`,
  fiscalCode: '30254716',
  fiscalCodeStatus: 'valid',
  supplierPublic: false,
};
export const NATURAL_PERSON: DaPartyRecord = {
  portalPartyId: '902',
  name: `${SECRET} IONESCU MARIA`,
  fiscalCode: '2850101123456',
  fiscalCodeStatus: 'personal_code',
  supplierPublic: false,
};
export const UNVERIFIED: DaPartyRecord = {
  portalPartyId: '903',
  name: `${SECRET} UNVERIFIED NAME`,
  fiscalCode: '30254717',
  fiscalCodeStatus: 'valid',
  supplierPublic: false,
};
export const BAD_CODE_SUPPLIER: DaPartyRecord = {
  portalPartyId: '904',
  name: `${SECRET} CHECKSUM FAILED`,
  fiscalCode: '1111111',
  fiscalCodeStatus: 'checksum_failed',
  supplierPublic: false,
};

// ── Rules (the value review page's sentences) ────────────────────────────────

export const RULES: Readonly<Record<string, DaRuleRecord>> = {
  quantity_unit_mix: {
    rule: 'quantity_unit_mix',
    effect: 'correct',
    descriptionEn:
      'We use the quantity stated for the purchase when the reported total was calculated with the wrong unit or quantity scale.',
    descriptionRo: 'RO: quantity_unit_mix',
  },
  approximate_only: {
    rule: 'approximate_only',
    effect: 'exclude',
    descriptionEn:
      'We leave the purchase out of spending totals when the reported value is unreliable and the record does not establish an exact replacement.',
    descriptionRo: 'RO: approximate_only',
  },
  exceeds_buyer_spending: {
    rule: 'exceeds_buyer_spending',
    effect: 'exclude',
    descriptionEn:
      "We leave the purchase out of spending totals when its reported price is above the buyer's whole annual spending.",
    descriptionRo: 'RO: exceeds_buyer_spending',
  },
};

// ── Purchases: the contract's example rows ───────────────────────────────────

const base = (n: number, over: Partial<DaPurchaseRecord>): DaPurchaseRecord => ({
  purchaseId: hex(n),
  nativeId: String(119000000 + n),
  code: `DA${String(37700000 + n)}`,
  sourceUrl: `https://e-licitatie.ro/pub/direct-acquisition/view/${String(119000000 + n)}`,
  outcome: 'accepted',
  stateLabel: 'Finalizata',
  publicationDay: null,
  finalizationDay: null,
  buyerDecisionAt: '2025-06-01T08:00:00Z',
  supplierDecisionAt: '2025-06-01T09:00:00Z',
  reportedValue: null,
  counted: false,
  countedValue: null,
  notCountedReason: null,
  valueCorrected: false,
  valueReviewRule: null,
  rule: null,
  symbolicPrice: false,
  listedNow: true,
  // Free text the loader has not marked public: the core must never serve it.
  title: `${SECRET} title ${String(n)} Popescu Ion PFA`,
  titlePublic: false,
  description: `${SECRET} Servicii prestate de Popescu Ion PFA (${String(n)})`,
  descriptionPublic: false,
  categoryCode: '44110000-4',
  categoryAsWritten: 'Materiale de constructii',
  acquisitionTypeLabel: 'Furnizare',
  buyer: BUYER,
  supplier: COMPANY,
  ...over,
});

const counted = (value: string) => ({ counted: true, countedValue: value, reportedValue: value });

export const PURCHASES: readonly DaPurchaseRecord[] = [
  base(1, {
    finalizationDay: '2025-06-02',
    ...counted('12500.00'),
    title: 'Public title 1',
    titlePublic: true,
  }),
  base(2, {
    finalizationDay: '2025-03-04',
    reportedValue: '3150000.00',
    counted: true,
    countedValue: '3150.00',
    valueCorrected: true,
    valueReviewRule: 'quantity_unit_mix',
    rule: RULES['quantity_unit_mix'] ?? null,
  }),
  base(3, {
    finalizationDay: '2025-09-10',
    reportedValue: '1680000.00',
    notCountedReason: 'reviewed_entry_error',
    valueReviewRule: 'approximate_only',
    rule: RULES['approximate_only'] ?? null,
  }),
  base(4, {
    finalizationDay: '2026-09-18',
    reportedValue: '358324000.00',
    notCountedReason: 'reviewed_entry_error',
    valueReviewRule: 'exceeds_buyer_spending',
    rule: RULES['exceeds_buyer_spending'] ?? null,
    buyer: BUYER_BAD_CODE,
  }),
  base(5, { finalizationDay: '2025-10-02', ...counted('188800000.00') }),
  base(6, {
    outcome: 'refused',
    finalizationDay: '2025-05-12',
    reportedValue: '40000.00',
    notCountedReason: 'not_accepted',
    supplier: SOLE_TRADER,
  }),
  base(7, {
    finalizationDay: '2021-11-30',
    reportedValue: '8400.00',
    notCountedReason: 'value_not_qualified',
    categoryCode: '30190000-7',
  }),
  base(8, { finalizationDay: '2026-11-13', ...counted('5200.00'), listedNow: false }),
  base(9, {
    finalizationDay: '2025-02-11',
    ...counted('0.01'),
    symbolicPrice: true,
    supplier: UNVERIFIED,
  }),
  base(10, { finalizationDay: '2025-07-07', ...counted('900.00'), supplier: NATURAL_PERSON }),
  base(11, { finalizationDay: '2025-07-08', ...counted('450.00'), supplier: SOLE_TRADER }),
  base(12, { finalizationDay: '2025-07-09', ...counted('300.00'), supplier: BAD_CODE_SUPPLIER }),
  base(13, { finalizationDay: '2025-07-10', ...counted('100.00'), supplier: null }),
];

export const ITEMS: Readonly<Record<string, readonly DaItemRecord[]>> = {
  [hex(2)]: [
    {
      itemIndex: 0,
      name: 'Beton refractar',
      namePublic: true,
      unit: 'tona',
      unitPublic: true,
      quantity: '375',
      requestedQuantity: '375',
      unitPrice: '8400.00',
      cataloguePrice: '210.00',
      reportedLineValue: '3150000.00',
      supplierRejected: false,
      quantityCorrection: false,
    },
    {
      itemIndex: 1,
      name: `${SECRET} Transport Popescu Ion`,
      namePublic: false,
      unit: `${SECRET} 0722 000 000`,
      unitPublic: false,
      quantity: '15.2',
      requestedQuantity: null,
      unitPrice: '180.00',
      cataloguePrice: null,
      reportedLineValue: '2736.000',
      supplierRejected: null,
      quantityCorrection: null,
    },
  ],
};

// ── Fake repository ──────────────────────────────────────────────────────────

export interface SnapshotLog {
  /** How many snapshots were opened. */
  opened: number;
  /** Each read, tagged with the snapshot it ran in and whether that snapshot was still open. */
  readonly reads: { readonly snapshot: number; readonly method: string; readonly open: boolean }[];
  /** Per snapshot opened: whether it asked to be settled (the after-read rule). */
  readonly settled?: boolean[];
}

/** The fake's version of the SQL D6 predicate, used ONLY for filtering (as the SQL is). */
const namedForFilter = (party: DaPartyRecord | null, privacyTable: boolean): boolean =>
  party !== null && party.fiscalCodeStatus === 'valid' && privacyTable && party.supplierPublic;

const matches = (row: DaPurchaseRecord, filter: DaPurchaseFilter, privacyTable: boolean) =>
  (filter.code === undefined || row.code === filter.code) &&
  (filter.nativeId === undefined || row.nativeId === filter.nativeId) &&
  (filter.counted === undefined || row.counted === filter.counted) &&
  (filter.outcomes === undefined || (filter.outcomes as readonly string[]).includes(row.outcome)) &&
  (filter.cpvDivision === undefined || row.categoryCode?.slice(0, 2) === filter.cpvDivision) &&
  (filter.finalizationFrom === undefined ||
    (row.finalizationDay !== null && row.finalizationDay >= filter.finalizationFrom)) &&
  (filter.finalizationTo === undefined ||
    (row.finalizationDay !== null && row.finalizationDay <= filter.finalizationTo)) &&
  (filter.buyerFiscalCode === undefined ||
    (row.buyer?.fiscalCode === filter.buyerFiscalCode && row.buyer.fiscalCodeStatus === 'valid')) &&
  (filter.supplierFiscalCode === undefined ||
    (row.supplier?.fiscalCode === filter.supplierFiscalCode &&
      namedForFilter(row.supplier, privacyTable)));

const measure = (rows: readonly DaPurchaseRecord[]): DaTotalsRecord => {
  const countedRows = rows.filter((row) => row.counted);
  return {
    countedValue:
      countedRows.length === 0
        ? null
        : countedRows
            .reduce((sum, row) => sum.plus(row.countedValue ?? '0'), new Decimal(0))
            .toFixed(2),
    countedCount: String(countedRows.length),
    symbolicPriceCount: String(countedRows.filter((row) => row.symbolicPrice).length),
    purchaseCount: String(rows.length),
  };
};

export interface FakeDaRepoOptions {
  readonly enabled?: boolean;
  /** False: `supplier_privacy` is absent, so every supplier is withheld. */
  readonly supplierPrivacyTable?: boolean;
  readonly purchases?: readonly DaPurchaseRecord[];
  readonly dataAsOf?: string | null;
  readonly log?: SnapshotLog;
}

export const makeFakeDaRepo = (options: FakeDaRepoOptions = {}): DaReleaseRepo => {
  const privacyTable = options.supplierPrivacyTable ?? true;
  const purchases = (options.purchases ?? PURCHASES).map((row) =>
    privacyTable
      ? row
      : {
          ...row,
          supplier: row.supplier === null ? null : { ...row.supplier, supplierPublic: false },
        }
  );
  const log = options.log ?? { opened: 0, reads: [] };
  return {
    enabled: options.enabled ?? true,
    snapshot: async (read, snapshotOptions) => {
      log.opened += 1;
      log.settled?.push(snapshotOptions?.settle === true);
      const id = log.opened;
      let open = true;
      const note = (method: string) => log.reads.push({ snapshot: id, method, open });
      const reader: DaReleaseReader = {
        dataAsOf: () => {
          note('dataAsOf');
          return Promise.resolve(
            ok(options.dataAsOf === undefined ? DATA_AS_OF : options.dataAsOf)
          );
        },
        supplierPrivacyTable: () => privacyTable,
        listPurchases: (query) => {
          note('listPurchases');
          const rows = purchases
            .filter((row) => matches(row, query.filter, privacyTable))
            .sort((a, b) => {
              if (query.sort === 'countedValueDesc') {
                const av = a.countedValue === null ? -1 : Number(a.countedValue);
                const bv = b.countedValue === null ? -1 : Number(b.countedValue);
                return av !== bv ? bv - av : b.purchaseId.localeCompare(a.purchaseId);
              }
              const sign = query.sort === 'finalizationAsc' ? -1 : 1;
              const byDay = (b.finalizationDay ?? '').localeCompare(a.finalizationDay ?? '');
              return byDay !== 0 ? sign * byDay : sign * b.purchaseId.localeCompare(a.purchaseId);
            });
          const offset = (query.page - 1) * query.pageSize;
          return Promise.resolve(
            ok({
              rows: rows.slice(offset, offset + query.pageSize),
              total: rows.length,
              capped: false,
            })
          );
        },
        purchaseById: (purchaseId) => {
          note('purchaseById');
          return Promise.resolve(
            ok(purchases.find((row) => row.purchaseId === purchaseId) ?? null)
          );
        },
        itemsOf: (purchaseId) => {
          note('itemsOf');
          return Promise.resolve(ok(ITEMS[purchaseId] ?? []));
        },
        totals: (query) => {
          note('totals');
          const rows = purchases.filter((row) => matches(row, query.filter, privacyTable));
          const groups = new Map<
            string,
            { rows: DaPurchaseRecord[]; record: Omit<DaTotalsGroupRecord, keyof DaTotalsRecord> }
          >();
          for (const row of rows) {
            let id: string;
            let record: Omit<DaTotalsGroupRecord, keyof DaTotalsRecord>;
            switch (query.groupBy) {
              case 'buyer':
                id = row.buyer?.portalPartyId ?? '~none';
                record = { key: null, supplierBucket: null, party: row.buyer };
                break;
              case 'supplier':
                // Adversarial: every supplier group claims to be named, with its real party.
                id = row.supplier?.portalPartyId ?? '~none';
                record =
                  row.supplier === null
                    ? { key: null, supplierBucket: 'none', party: null }
                    : { key: null, supplierBucket: 'named', party: row.supplier };
                break;
              case 'cpvDivision':
                id = row.categoryCode?.slice(0, 2) ?? '~null';
                record = {
                  key: row.categoryCode?.slice(0, 2) ?? null,
                  supplierBucket: null,
                  party: null,
                };
                break;
              case 'month':
                id = row.finalizationDay?.slice(0, 7) ?? '~null';
                record = {
                  key: row.finalizationDay?.slice(0, 7) ?? null,
                  supplierBucket: null,
                  party: null,
                };
                break;
              case 'year':
                id = row.finalizationDay?.slice(0, 4) ?? '~null';
                record = {
                  key: row.finalizationDay?.slice(0, 4) ?? null,
                  supplierBucket: null,
                  party: null,
                };
                break;
              case null:
                continue;
            }
            const group = groups.get(id) ?? { rows: [], record };
            group.rows.push(row);
            groups.set(id, group);
          }
          const all = [...groups.values()].map((group) => ({
            ...measure(group.rows),
            ...group.record,
          }));
          const offset = (query.page - 1) * query.pageSize;
          return Promise.resolve(
            ok({
              overall: measure(rows),
              groups: all.slice(offset, offset + query.pageSize),
              groupCount: all.length,
            })
          );
        },
      };
      try {
        return await read(reader);
      } finally {
        open = false;
      }
    },
  };
};
