/**
 * Direct acquisitions, release 1 (`procurement_v3`): the public shape, the
 * supplier-name rule (owner decision D6) and the row invariants.
 *
 * Built to the data platform's serving contract
 * (`docs/domains/public-contracts/reference/DIRECT_ACQUISITION_SERVING_CONTRACT.md`).
 * Per purchase the API serves the value the portal reported, whether it is
 * included in totals and why not, and, when a reviewed correction applies, the
 * corrected value with the correction rule's public sentence. Only
 * `counted_value` is ever summed; reported values and item lines never are.
 *
 * D6: a supplier's name and fiscal code are served only for a company
 * (`supplier_kind = 'company'` with a valid fiscal code; until the loader adds
 * `supplier_kind`, a valid fiscal code). Every other supplier is served as a
 * natural person with no name, no fiscal code and no party id. Buyers are
 * public authorities: the name is served, the code only when it is valid.
 *
 * Pure: no I/O. A row that breaks the contract's invariants is refused, never
 * served half-right.
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '@/modules/shared/index.js';

// ── Contract enums ───────────────────────────────────────────────────────────

export const DA_OUTCOMES = ['accepted', 'refused', 'expired', 'unknown'] as const;
export type DaOutcome = (typeof DA_OUTCOMES)[number];

export const DA_NOT_COUNTED_REASONS = [
  'not_accepted',
  'value_not_qualified',
  'reviewed_entry_error',
  'closing_value_missing',
  'detail_unusable',
  'state_disagrees',
  'finalization_day_disagrees',
  'value_disagrees',
] as const;
export type DaNotCountedReasonCode = (typeof DA_NOT_COUNTED_REASONS)[number];

const DISAGREES = {
  en: "The portal's list and detail pages disagree.",
  ro: 'Lista și pagina de detaliu ale portalului nu concordă.',
} as const;

/** The contract's labels; the API holds this map (the rule sentences live in the database). */
export const DA_NOT_COUNTED_REASON_LABELS: Readonly<
  Record<DaNotCountedReasonCode, { readonly en: string; readonly ro: string }>
> = {
  not_accepted: {
    en: 'Refused or expired: no purchase took place.',
    ro: 'Respinsă sau expirată: achiziția nu s-a realizat.',
  },
  value_not_qualified: {
    en: "The value's currency and VAT basis are not yet confirmed for this period (before 2025).",
    ro: 'Moneda și baza TVA ale valorii nu sunt încă confirmate pentru această perioadă (înainte de 2025).',
  },
  reviewed_entry_error: {
    en: 'Left out after review: see the rule.',
    ro: 'Exclusă după verificare: vezi regula.',
  },
  closing_value_missing: {
    en: 'The portal gives no closing value.',
    ro: 'Portalul nu indică valoarea finală.',
  },
  detail_unusable: {
    en: "The purchase's detail page could not be read completely.",
    ro: 'Pagina de detaliu nu a putut fi citită complet.',
  },
  state_disagrees: DISAGREES,
  finalization_day_disagrees: DISAGREES,
  value_disagrees: DISAGREES,
};

export const DA_RULE_EFFECTS = ['correct', 'exclude', 'keep'] as const;
export type DaRuleEffect = (typeof DA_RULE_EFFECTS)[number];

export const DA_FISCAL_CODE_STATUSES = [
  'valid',
  'checksum_failed',
  'not_romanian_format',
  'personal_code',
] as const;

export const DA_SUPPLIER_KINDS = [
  'company',
  'sole_trader',
  'natural_person',
  'unverified',
] as const;

/** Totals dimensions for release 1; `year` is a roll-up of the contract's month. */
export const DA_TOTALS_GROUPS = ['buyer', 'supplier', 'cpvDivision', 'month', 'year'] as const;
export type DaTotalsDimension = (typeof DA_TOTALS_GROUPS)[number];

/** The basis of every served money value. */
export const DA_VALUE_BASIS = 'RON excluding VAT';

/** The fixed text a withheld supplier is shown as (D6). */
export const DA_NATURAL_PERSON_LABEL = { en: 'natural person', ro: 'persoană fizică' } as const;

// ── Records (repo → core) ────────────────────────────────────────────────────

/** One `da_parties` row as read; never served directly. */
export interface DaPartyRecord {
  readonly portalPartyId: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly fiscalCodeStatus: string | null;
  /** Null when the row has no kind or the column does not exist yet (see `supplierKindColumn`). */
  readonly supplierKind: string | null;
}

export interface DaRuleRecord {
  readonly rule: string;
  readonly effect: string;
  readonly descriptionEn: string | null;
  readonly descriptionRo: string | null;
}

export interface DaPurchaseRecord {
  readonly purchaseId: string;
  readonly nativeId: string | null;
  readonly code: string | null;
  readonly sourceUrl: string | null;
  readonly outcome: string;
  readonly stateLabel: string | null;
  readonly publicationDay: string | null;
  readonly finalizationDay: string | null;
  readonly buyerDecisionAt: string | null;
  readonly supplierDecisionAt: string | null;
  readonly reportedValue: string | null;
  readonly counted: boolean;
  readonly countedValue: string | null;
  readonly notCountedReason: string | null;
  readonly valueCorrected: boolean;
  readonly valueReviewRule: string | null;
  /** The joined `da_value_rules` row; null when `valueReviewRule` is null or unmatched. */
  readonly rule: DaRuleRecord | null;
  readonly symbolicPrice: boolean;
  readonly listedNow: boolean | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly categoryCode: string | null;
  readonly categoryAsWritten: string | null;
  readonly acquisitionTypeLabel: string | null;
  /** Null when the purchase names no buyer, or the party row is missing. */
  readonly buyer: DaPartyRecord | null;
  readonly supplier: DaPartyRecord | null;
}

export interface DaItemRecord {
  readonly itemIndex: number;
  readonly name: string | null;
  readonly unit: string | null;
  readonly quantity: string | null;
  readonly requestedQuantity: string | null;
  readonly unitPrice: string | null;
  readonly cataloguePrice: string | null;
  readonly supplierRejected: boolean | null;
  readonly quantityCorrection: boolean | null;
}

/** The measures of one totals scope or group, as SQL numeric/bigint text. */
export interface DaTotalsRecord {
  readonly countedValue: string | null;
  readonly countedCount: string;
  readonly symbolicPriceCount: string;
  readonly purchaseCount: string;
}

/**
 * One group's key as read. `party` is filled for buyer and named-supplier
 * groups; a supplier group is `withheld` (every supplier D6 does not name, one
 * bucket) or `none` (purchases that name no supplier).
 */
export interface DaTotalsGroupRecord extends DaTotalsRecord {
  readonly key: string | null;
  readonly supplierBucket: 'named' | 'withheld' | 'none' | null;
  readonly party: DaPartyRecord | null;
}

// ── Public shape ─────────────────────────────────────────────────────────────

export interface DaParty {
  /** `authority` for buyers; `company` for a named supplier; `natural_person` when D6 withholds it. */
  readonly displayKind: 'authority' | 'company' | 'natural_person';
  /** The portal's party id; null when withheld. */
  readonly partyId: string | null;
  /** Null when withheld (D6) or when the source gives no name. */
  readonly name: string | null;
  /** Digits only, no RO prefix; null when withheld or not a valid code. */
  readonly fiscalCode: string | null;
}

export interface DaLabel {
  readonly code: string;
  readonly labelEn: string;
  readonly labelRo: string;
}

export interface DaValueRule {
  readonly rule: string;
  readonly effect: DaRuleEffect;
  readonly descriptionEn: string | null;
  readonly descriptionRo: string | null;
}

export interface DaPurchase {
  readonly purchaseId: string;
  readonly nativeId: string | null;
  readonly code: string | null;
  readonly sourceUrl: string | null;
  readonly outcome: DaOutcome;
  readonly stateLabel: string | null;
  readonly publicationDay: string | null;
  readonly finalizationDay: string | null;
  readonly buyerDecisionAt: string | null;
  readonly supplierDecisionAt: string | null;
  /** The closing value as the portal reports it. Never summed. */
  readonly reportedValue: string | null;
  /** Included in totals. */
  readonly counted: boolean;
  /** The only summable value; null when not counted. Lei excluding VAT. */
  readonly countedValue: string | null;
  readonly notCountedReason: DaLabel | null;
  /** True when `countedValue` is an approved correction of the reported value. */
  readonly valueCorrected: boolean;
  /** `countedValue` when it is a correction, otherwise null. */
  readonly correctedValue: string | null;
  /** The review rule that corrected or excluded this purchase, with its public sentence. */
  readonly reviewRule: DaValueRule | null;
  /** A value of 0 or 0.01 lei: counted, flagged. */
  readonly symbolicPrice: boolean;
  /** False when the portal no longer lists the purchase. */
  readonly listedNow: boolean | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly categoryCode: string | null;
  readonly categoryLabel: string | null;
  readonly cpvDivision: string | null;
  readonly acquisitionTypeLabel: string | null;
  readonly buyer: DaParty | null;
  readonly supplier: DaParty | null;
}

export interface DaItem {
  readonly itemIndex: number;
  readonly name: string | null;
  readonly unit: string | null;
  readonly quantity: string | null;
  readonly requestedQuantity: string | null;
  readonly unitPrice: string | null;
  readonly cataloguePrice: string | null;
  /** quantity × unitPrice as reported; never summed. Null when either is missing. */
  readonly reportedLineValue: string | null;
  readonly supplierRejected: boolean | null;
  readonly quantityCorrection: boolean | null;
}

export interface DaTotals {
  /** Sum of counted values; null when nothing in scope is counted. */
  readonly countedValue: string | null;
  readonly countedCount: string;
  readonly symbolicPriceCount: string;
  /** Every purchase in scope, counted or not. */
  readonly purchaseCount: string;
}

export interface DaTotalsGroup extends DaTotals {
  /** The group's key: party id (null for withheld/none), CPV division, YYYY-MM or YYYY. */
  readonly key: string | null;
  /** Buyer or supplier groups only. A withheld supplier group is `natural_person` with no name. */
  readonly party: DaParty | null;
  /** Supplier groups: true for the one bucket of purchases that name no supplier. */
  readonly noSupplier: boolean;
}

// ── D6 ───────────────────────────────────────────────────────────────────────

/**
 * Whether D6 lets a supplier be named. With the `supplier_kind` column present
 * only a `company` with a valid code is named (a null kind is withheld); before
 * the column exists, a valid code is the contract's fallback.
 */
export const isNamedSupplier = (party: DaPartyRecord, supplierKindColumn: boolean): boolean =>
  party.fiscalCodeStatus === 'valid' &&
  party.fiscalCode !== null &&
  (!supplierKindColumn || party.supplierKind === 'company');

const WITHHELD: DaParty = {
  displayKind: 'natural_person',
  partyId: null,
  name: null,
  fiscalCode: null,
};

export const toSupplier = (party: DaPartyRecord, supplierKindColumn: boolean): DaParty =>
  isNamedSupplier(party, supplierKindColumn)
    ? {
        displayKind: 'company',
        partyId: party.portalPartyId,
        name: party.name,
        fiscalCode: party.fiscalCode,
      }
    : WITHHELD;

export const toBuyer = (party: DaPartyRecord): DaParty => ({
  displayKind: 'authority',
  partyId: party.portalPartyId,
  name: party.name,
  fiscalCode: party.fiscalCodeStatus === 'valid' ? party.fiscalCode : null,
});

// ── Mapping with invariants ──────────────────────────────────────────────────

const member = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

const refused = (what: string): ApiError =>
  databaseError(`Direct-acquisition ${what} breaks the serving contract; response refused.`);

const DECIMAL_TEXT = /^-?[0-9]+(\.[0-9]+)?$/u;
const isDecimalText = (value: string | null): boolean => value === null || DECIMAL_TEXT.test(value);

export const cpvDivisionOf = (categoryCode: string | null): string | null =>
  categoryCode !== null && /^[0-9]{2}/u.test(categoryCode) ? categoryCode.slice(0, 2) : null;

const toRule = (record: DaPurchaseRecord): Result<DaValueRule | null, ApiError> => {
  if (record.valueReviewRule === null) return ok(null);
  const rule = record.rule;
  if (rule?.rule !== record.valueReviewRule || !member(DA_RULE_EFFECTS, rule.effect))
    return err(refused('review rule'));
  return ok({
    rule: rule.rule,
    effect: rule.effect,
    descriptionEn: rule.descriptionEn,
    descriptionRo: rule.descriptionRo,
  });
};

export const toPurchase = (
  record: DaPurchaseRecord,
  supplierKindColumn: boolean
): Result<DaPurchase, ApiError> => {
  if (!member(DA_OUTCOMES, record.outcome)) return err(refused('outcome'));
  if (!isDecimalText(record.reportedValue) || !isDecimalText(record.countedValue))
    return err(refused('value'));
  // counted ⇔ counted_value present ⇔ no reason.
  if (record.counted !== (record.countedValue !== null)) return err(refused('counted value'));
  if (record.counted !== (record.notCountedReason === null))
    return err(refused('not-counted reason'));
  if (record.notCountedReason !== null && !member(DA_NOT_COUNTED_REASONS, record.notCountedReason))
    return err(refused('not-counted reason'));
  if (record.valueCorrected && (!record.counted || record.valueReviewRule === null))
    return err(refused('correction'));
  const rule = toRule(record);
  if (rule.isErr()) return err(rule.error);

  const reason = record.notCountedReason;
  return ok({
    purchaseId: record.purchaseId,
    nativeId: record.nativeId,
    code: record.code,
    sourceUrl: record.sourceUrl,
    outcome: record.outcome,
    stateLabel: record.stateLabel,
    publicationDay: record.publicationDay,
    finalizationDay: record.finalizationDay,
    buyerDecisionAt: record.buyerDecisionAt,
    supplierDecisionAt: record.supplierDecisionAt,
    reportedValue: record.reportedValue,
    counted: record.counted,
    countedValue: record.countedValue,
    notCountedReason:
      reason !== null && member(DA_NOT_COUNTED_REASONS, reason)
        ? {
            code: reason,
            labelEn: DA_NOT_COUNTED_REASON_LABELS[reason].en,
            labelRo: DA_NOT_COUNTED_REASON_LABELS[reason].ro,
          }
        : null,
    valueCorrected: record.valueCorrected,
    correctedValue: record.valueCorrected ? record.countedValue : null,
    reviewRule: rule.value,
    symbolicPrice: record.symbolicPrice,
    listedNow: record.listedNow,
    title: record.title,
    description: record.description,
    categoryCode: record.categoryCode,
    categoryLabel: record.categoryAsWritten,
    cpvDivision: cpvDivisionOf(record.categoryCode),
    acquisitionTypeLabel: record.acquisitionTypeLabel,
    buyer: record.buyer === null ? null : toBuyer(record.buyer),
    supplier: record.supplier === null ? null : toSupplier(record.supplier, supplierKindColumn),
  });
};

export const toItem = (record: DaItemRecord): Result<DaItem, ApiError> => {
  if (
    !isDecimalText(record.quantity) ||
    !isDecimalText(record.requestedQuantity) ||
    !isDecimalText(record.unitPrice) ||
    !isDecimalText(record.cataloguePrice)
  )
    return err(refused('item value'));
  return ok({
    itemIndex: record.itemIndex,
    name: record.name,
    unit: record.unit,
    quantity: record.quantity,
    requestedQuantity: record.requestedQuantity,
    unitPrice: record.unitPrice,
    cataloguePrice: record.cataloguePrice,
    reportedLineValue:
      record.quantity !== null && record.unitPrice !== null
        ? new Decimal(record.quantity).times(record.unitPrice).toFixed()
        : null,
    supplierRejected: record.supplierRejected,
    quantityCorrection: record.quantityCorrection,
  });
};

const COUNT_TEXT = /^[0-9]+$/u;

export const toTotals = (record: DaTotalsRecord): Result<DaTotals, ApiError> => {
  if (
    !COUNT_TEXT.test(record.countedCount) ||
    !COUNT_TEXT.test(record.symbolicPriceCount) ||
    !COUNT_TEXT.test(record.purchaseCount) ||
    !isDecimalText(record.countedValue)
  )
    return err(refused('total'));
  const nothingCounted = record.countedCount === '0';
  if (nothingCounted !== (record.countedValue === null)) return err(refused('total'));
  return ok({
    countedValue: record.countedValue,
    countedCount: record.countedCount,
    symbolicPriceCount: record.symbolicPriceCount,
    purchaseCount: record.purchaseCount,
  });
};

export const toTotalsGroup = (
  record: DaTotalsGroupRecord,
  groupBy: DaTotalsDimension,
  supplierKindColumn: boolean
): Result<DaTotalsGroup, ApiError> => {
  const totals = toTotals(record);
  if (totals.isErr()) return err(totals.error);
  if (groupBy === 'buyer')
    return ok({
      ...totals.value,
      key: record.party?.portalPartyId ?? null,
      party: record.party === null ? null : toBuyer(record.party),
      noSupplier: false,
    });
  if (groupBy === 'supplier') {
    if (record.supplierBucket === 'none')
      return ok({ ...totals.value, key: null, party: null, noSupplier: true });
    // A named bucket is re-checked here: the SQL bucket and this rule must agree.
    const party =
      record.supplierBucket === 'named' && record.party !== null
        ? toSupplier(record.party, supplierKindColumn)
        : WITHHELD;
    return ok({ ...totals.value, key: party.partyId, party, noSupplier: false });
  }
  return ok({ ...totals.value, key: record.key, party: null, noSupplier: false });
};
