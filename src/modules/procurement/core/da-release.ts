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
 * D6 (site-wide): a supplier's name and fiscal code are served only when its
 * code is disclosed: the supplier has a row in `da_parties_public`, whose
 * suppliers are the codes in `supplier_disclosure` (the data platform's one
 * classification, shared with the legacy surfaces). Every other supplier,
 * including any supplier when that view is unreadable, is served as a natural
 * person with no name, no fiscal code and no party id. A named supplier's name
 * is its public registry name (`party_public_names`). Buyers are public
 * authorities: the name is served, the code only when it is valid.
 *
 * Pure: no I/O. A row that breaks the contract's invariants is refused, never
 * served half-right.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  isWithheldOrganizationIdentifier,
  type ApiError,
} from '@/modules/shared/index.js';

import { DA_NATURAL_PERSON_BUCKET } from './constants.js';
import { publicPartyName } from './free-text-rule.js';
import {
  servedSupplierName,
  undisclosedNaming,
  type ServedSupplierKind,
  type SupplierNaming,
} from './supplier-naming.js';

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
  'removed_from_portal',
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
    // 22 Nov 2026: no cause named (the 2018–2024 holds, and other pre-2025 cases the build allows).
    en: "The currency and VAT basis of this purchase's value are not confirmed.",
    ro: 'Moneda și baza TVA ale valorii acestei achiziții nu sunt confirmate.',
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
  // D3 (20 Nov 2026): delisted purchases; the platform sets it before every other reason.
  removed_from_portal: {
    en: 'The purchase is no longer on any portal list.',
    ro: 'Achiziția nu mai apare în nicio listă a portalului.',
  },
};

export const DA_RULE_EFFECTS = ['correct', 'exclude', 'keep'] as const;
export type DaRuleEffect = (typeof DA_RULE_EFFECTS)[number];

export const DA_FISCAL_CODE_STATUSES = [
  'valid',
  'checksum_failed',
  'not_romanian_format',
  'personal_code',
] as const;

/** List orders; purchaseId breaks every tie. countedValueDesc puts uncounted purchases last. */
export const DA_LIST_SORTS = ['finalizationDesc', 'finalizationAsc', 'countedValueDesc'] as const;
export type DaListSort = (typeof DA_LIST_SORTS)[number];

/** Totals dimensions for release 1; `year` is a roll-up of the contract's month. */
export const DA_TOTALS_GROUPS = ['buyer', 'supplier', 'cpvDivision', 'month', 'year'] as const;
export type DaTotalsDimension = (typeof DA_TOTALS_GROUPS)[number];

/**
 * The basis of counted (and corrected) values only. A reported value is as the
 * portal published it: its currency and VAT basis are confirmed only where the
 * purchase is counted (see `value_not_qualified`).
 */
export const DA_COUNTED_VALUE_BASIS = 'RON excluding VAT';

/** The fixed text a withheld supplier is shown as (D6). */
export const DA_NATURAL_PERSON_LABEL = { en: 'natural person', ro: 'persoană fizică' } as const;

// ── Records (repo → core) ────────────────────────────────────────────────────

/** One public party as read (`da_parties_public`); never served directly. */
export interface DaPartyRecord {
  readonly portalPartyId: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly fiscalCodeStatus: string | null;
  /** D6 in SQL: the supplier has a public row and its code is valid. False for a buyer. */
  readonly supplierPublic: boolean;
  /**
   * Naming step 2b, row level only: the supplier's code is shown without D6 disclosing it
   * (`da_parties_public.supplier_disclosed` false). Never counted, ranked, filtered or scoped.
   */
  readonly supplierShown?: boolean;
  /**
   * A disclosed supplier's naming, read by code after the page (`supplierNamesByCode`); when
   * set, its name is the one served. Absent on buyers and on withheld suppliers.
   */
  readonly naming?: SupplierNaming;
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
  /** Null unless `titlePublic` (the reader selects the text only when the loader marks it public). */
  readonly title: string | null;
  readonly titlePublic: boolean;
  readonly description: string | null;
  readonly descriptionPublic: boolean;
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
  readonly namePublic: boolean;
  readonly unit: string | null;
  readonly unitPublic: boolean;
  readonly quantity: string | null;
  readonly requestedQuantity: string | null;
  readonly unitPrice: string | null;
  readonly cataloguePrice: string | null;
  /** quantity × unit_price computed in SQL numeric (exact); never summed. */
  readonly reportedLineValue: string | null;
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

/** Why a served field is null: free text that has not passed the privacy review. */
export type DaWithheld = 'privacy';

/** A free-text field: served only when its row is marked public; otherwise null with a marker. */
const gated = (
  text: string | null,
  isPublic: boolean
): { readonly value: string | null; readonly withheld: DaWithheld | null } =>
  isPublic ? { value: text, withheld: null } : { value: null, withheld: 'privacy' };

export interface DaParty {
  /**
   * `authority` for buyers. A supplier D6 discloses: `company` (its registry name, or no name),
   * `person_masked` (a masked name) or `code_only` (no name), see `core/supplier-naming.ts`.
   * `natural_person` when D6 withholds it.
   */
  readonly displayKind: 'authority' | ServedSupplierKind | 'natural_person';
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
  /** The closing value as the portal published it. Never summed; basis confirmed only when counted. */
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
  /** Free text, withheld (null) unless reviewed public; then `titleWithheld` is null. */
  readonly title: string | null;
  readonly titleWithheld: DaWithheld | null;
  readonly description: string | null;
  readonly descriptionWithheld: DaWithheld | null;
  readonly categoryCode: string | null;
  /** The CPV label as written: the purchase's visible name while the title is withheld. */
  readonly categoryLabel: string | null;
  readonly cpvDivision: string | null;
  readonly acquisitionTypeLabel: string | null;
  readonly buyer: DaParty | null;
  readonly supplier: DaParty | null;
}

export interface DaItem {
  readonly itemIndex: number;
  readonly name: string | null;
  readonly nameWithheld: DaWithheld | null;
  /** Free text: null with `unitWithheld` "privacy" unless the loader marks it public. */
  readonly unit: string | null;
  readonly unitWithheld: DaWithheld | null;
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
 * A party's code as served: a valid one, and never a person's (longer than an organization code,
 * kernel P0 containment), whatever the status says.
 */
const servedFiscalCode = (party: DaPartyRecord): string | null =>
  party.fiscalCodeStatus === 'valid' &&
  party.fiscalCode !== null &&
  !isWithheldOrganizationIdentifier(party.fiscalCode)
    ? party.fiscalCode
    : null;

/**
 * Whether D6 lets a supplier be named: its code is disclosed (`da_parties_public`)
 * (and, defensively, present and valid; public implies both).
 */
export const isNamedSupplier = (party: DaPartyRecord): boolean =>
  party.supplierPublic && servedFiscalCode(party) !== null;

const WITHHELD: DaParty = {
  displayKind: 'natural_person',
  partyId: null,
  name: null,
  fiscalCode: null,
};

export const toSupplier = (party: DaPartyRecord): DaParty => {
  if (!isNamedSupplier(party)) return shownSupplier(party);
  const naming = party.naming;
  // A code the names view does not let us show: served like a supplier D6 withholds.
  if (naming?.kind === 'hidden') return WITHHELD;
  return {
    displayKind: naming?.kind ?? 'company',
    partyId: party.portalPartyId,
    // "Never a CNP": a name written with a personal numeric code is withheld.
    name: naming === undefined ? publicPartyName(party.name) : servedSupplierName(naming),
    fiscalCode: party.fiscalCode,
  };
};

/**
 * Naming step 2b: a supplier whose code is shown without D6 disclosing it is served by its code,
 * as `person_masked` or `code_only` (`undisclosedNaming`); anything less is withheld.
 */
const shownSupplier = (party: DaPartyRecord): DaParty => {
  const code = servedFiscalCode(party);
  if (party.supplierShown !== true || party.supplierPublic || code === null) return WITHHELD;
  if (party.naming === undefined) return WITHHELD;
  const naming = undisclosedNaming(party.naming);
  if (naming.kind !== 'person_masked' && naming.kind !== 'code_only') return WITHHELD;
  return {
    displayKind: naming.kind,
    // Not disclosed: the code is the only identifier served (no portal party id).
    partyId: null,
    name: servedSupplierName(naming),
    fiscalCode: code,
  };
};

export const toBuyer = (party: DaPartyRecord): DaParty => ({
  displayKind: 'authority',
  partyId: party.portalPartyId,
  name: publicPartyName(party.name),
  fiscalCode: servedFiscalCode(party),
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

export const toPurchase = (record: DaPurchaseRecord): Result<DaPurchase, ApiError> => {
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
  const title = gated(record.title, record.titlePublic);
  const description = gated(record.description, record.descriptionPublic);
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
    title: title.value,
    titleWithheld: title.withheld,
    description: description.value,
    descriptionWithheld: description.withheld,
    categoryCode: record.categoryCode,
    categoryLabel: record.categoryAsWritten,
    cpvDivision: cpvDivisionOf(record.categoryCode),
    acquisitionTypeLabel: record.acquisitionTypeLabel,
    buyer: record.buyer === null ? null : toBuyer(record.buyer),
    supplier: record.supplier === null ? null : toSupplier(record.supplier),
  });
};

export const toItem = (record: DaItemRecord): Result<DaItem, ApiError> => {
  if (
    !isDecimalText(record.quantity) ||
    !isDecimalText(record.requestedQuantity) ||
    !isDecimalText(record.unitPrice) ||
    !isDecimalText(record.cataloguePrice) ||
    !isDecimalText(record.reportedLineValue)
  )
    return err(refused('item value'));
  const name = gated(record.name, record.namePublic);
  const unit = gated(record.unit, record.unitPublic);
  return ok({
    itemIndex: record.itemIndex,
    name: name.value,
    nameWithheld: name.withheld,
    unit: unit.value,
    unitWithheld: unit.withheld,
    quantity: record.quantity,
    requestedQuantity: record.requestedQuantity,
    unitPrice: record.unitPrice,
    cataloguePrice: record.cataloguePrice,
    reportedLineValue: record.reportedLineValue,
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
  groupBy: DaTotalsDimension
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
    // A disclosed supplier whose code the names view does not let us show would be a ranked
    // group of one supplier's totals: refused whole, never relabelled after grouping.
    if (record.supplierBucket === 'named' && record.party?.naming?.kind === 'hidden')
      return err(refused('supplier group'));
    // A named bucket is re-checked here: the SQL bucket and this rule must agree.
    const party =
      record.supplierBucket === 'named' && record.party !== null
        ? toSupplier(record.party)
        : WITHHELD;
    // One key for every withheld supplier (as in the analysis API); null is reserved
    // for the bucket of purchases that name no supplier.
    return ok({
      ...totals.value,
      key: party.displayKind === 'natural_person' ? DA_NATURAL_PERSON_BUCKET : party.partyId,
      party,
      noSupplier: false,
    });
  }
  return ok({ ...totals.value, key: record.key, party: null, noSupplier: false });
};
