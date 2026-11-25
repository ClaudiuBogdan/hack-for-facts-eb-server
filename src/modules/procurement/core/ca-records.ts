/**
 * Contract awards (PROC-KB0Z step 1): the records the data platform serves in
 * `procurement_v3.ca_records_public` and its winners, lots and keys views, as
 * the API shows them. Records, a buyer's records and one record's detail only:
 * no lei sum is served here (root, 25 Nov: the band's money figure waits for
 * the owner; the money build's contract_award total is the candidate).
 *
 * Rules held here (design page contract-award-public-views.md, procurement-prod's
 * reader rules of 25 Nov):
 * - One floor for every dated list and count: the first award day the release serves
 *   (`da_release.ca_award_day_from`, read in the request's snapshot), or `CA_FLOOR_DAY` while
 *   that is not published or not readable. A record with no award day is in no dated list or
 *   count, only in `undatedCount`. A record before the floor is refused by id as outside the
 *   published window.
 * - A buyer that is a person (`buyer_person`) is served with its masked name only,
 *   never a name resolved by code (KR9T). Any other buyer is named by code from
 *   `party_public_names`, where its buyer name is public.
 * - A winner's code is shown only through `supplier_names_public` (`code_shown`):
 *   a disclosed (gate) code with its naming, an undisclosed one by code only or
 *   masked (naming step 2b), never a registry name; no row or an unreadable names
 *   view shows no code.
 * - Titles pass the free-text rule; names the personal-code screen.
 */

import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '@/modules/shared/index.js';

import { hasPersonCodeRun, publicFreeText, publicPartyName } from './free-text-rule.js';
import { servedSupplierName, undisclosedNaming, type SupplierNaming } from './supplier-naming.js';

/**
 * The published window's first award day when the release names none (owner, 24 Nov: contracts
 * from 2021). Release 2 publishes its own in `da_release.ca_award_day_from` (PROC-ACX6).
 */
export const CA_FLOOR_DAY = '2021-01-01';

/** A calendar day `YYYY-MM-DD` that PostgreSQL also has (no year 0). */
export const isCalendarDay = (day: string): boolean => {
  // PostgreSQL has no year 0 (a JavaScript Date does); any other year is clamped or kept.
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(day) || day.startsWith('0000')) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

/**
 * The floor a snapshot serves: the release's published first award day, or `CA_FLOOR_DAY` when
 * none was read (no column, no column grant, a null) or it is not a calendar day.
 */
export const servedFloor = (published: string | null): string =>
  published !== null && isCalendarDay(published) ? published : CA_FLOOR_DAY;
/** The deepest row a list page may reach. */
export const CA_LIST_MAX_DEPTH = 10_000;
/**
 * The most keys one winner code's list is drawn from (prod, 25 Nov: at most 46,785 for one code,
 * read in 0.12-0.14 s); a code past it is refused rather than paged from a cut key set.
 */
export const CA_WINNER_MAX_KEYS = 100_000;
export const CA_MAX_PAGE_SIZE = 50;

export const CA_LIST_SORTS = ['awardDayDesc', 'awardDayAsc', 'amountDesc'] as const;
export type CaListSort = (typeof CA_LIST_SORTS)[number];

/** A record's key in every view: `(source_name, match_id)`; `record_id` is the two joined by `:`. */
export interface CaKey {
  readonly sourceName: string;
  readonly matchId: string;
}

/** An appearance's portal ids, parsed from a `match_id` (`ca:<publication>:<contract>`). */
export interface CaAppearance {
  readonly sourceName: string;
  readonly publicationId: string;
  readonly contractId: string;
}

const SOURCE_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const PUBLIC_CODE = /^[1-9][0-9]{1,9}$/u;

/** A fiscal code with an organization code's shape (never a personal code's 13 digits). */
export const isPublicCode = (code: string): boolean => PUBLIC_CODE.test(code);
const PORTAL_ID = /^[0-9A-Za-z_-]{1,64}$/u;

/**
 * A `record_id` as `money_facts` and the views build it: `<source_name>:ca:<publication>:<contract>`.
 * Null when it is not one (never queried).
 */
export const parseCaRecordId = (recordId: string): (CaKey & CaAppearance) | null => {
  const parts = recordId.split(':');
  if (parts.length !== 4) return null;
  const [sourceName, prefix, publicationId, contractId] = parts as [string, string, string, string];
  if (!SOURCE_NAME.test(sourceName) || prefix !== 'ca') return null;
  if (!PORTAL_ID.test(publicationId) || !PORTAL_ID.test(contractId)) return null;
  return {
    sourceName,
    matchId: `ca:${publicationId}:${contractId}`,
    publicationId,
    contractId,
  };
};

export const caRecordIdOf = (key: CaKey): string => `${key.sourceName}:${key.matchId}`;

// ── Records (repo → core) ────────────────────────────────────────────────────

/** One `ca_records_public` row as read by key (the rows step); never served directly. */
export interface CaRecordRow extends CaKey {
  readonly contractKind: string | null;
  readonly valueKind: string;
  readonly additive: boolean;
  readonly status: string;
  readonly caHeadStatus: string | null;
  readonly amountLei: string | null;
  readonly nativeAmount: string | null;
  readonly currency: string | null;
  readonly fxSource: string | null;
  readonly vatBasis: string;
  readonly amountOrigin: string | null;
  readonly flags: readonly string[];
  readonly changeLei: string | null;
  readonly changePublicationDay: string | null;
  readonly awardDay: string | null;
  readonly publicationDay: string | null;
  readonly buyerCode: string | null;
  readonly buyerCountyCode: string | null;
  readonly buyerSiruta: string | null;
  readonly buyerRegion: string | null;
  readonly buyerPerson: boolean | null;
  readonly buyerNameMasked: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivision: string | null;
  readonly cpvGroup: string | null;
  readonly cpvClass: string | null;
  readonly procedureId: string | null;
  readonly noticeNo: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null;
  readonly winnerCount: number;
  readonly lotCount: number;
}

/** One `ca_record_winners_public` row, with the naming its code was read with. */
export interface CaWinnerRow extends CaKey {
  readonly winnerOrder: number | null;
  readonly fiscalCode: string | null;
  readonly supplierDisclosed: boolean | null;
  /** From `supplier_names_public` by code; absent when there is no code or the view is unreadable. */
  readonly naming?: SupplierNaming;
}

export interface CaLotRow extends CaKey {
  readonly lotOrder: number;
  readonly lotNumber: string | null;
  readonly title: string | null;
  readonly cpvCode: string | null;
  readonly estimatedValue: string | null;
  readonly currency: string | null;
  readonly isEuFunded: boolean | null;
  readonly cancelledStatus: string | null;
}

/** What the views and the registry say about a buyer code. */
export interface CaBuyerRecord {
  readonly code: string;
  /** `buyer_person` of the buyer's records; null when it has none to read it from. */
  readonly person: boolean | null;
  readonly maskedName: string | null;
  /** `party_public_names.registry_name` where the buyer name is public; never read for a person. */
  readonly registryName: string | null;
}

// ── Served shapes ────────────────────────────────────────────────────────────

/**
 * authority (named by its registry name, or no name) | person_masked (a person: a masked name or
 * none) | unknown (no record says which: no name).
 */
export type CaBuyerKind = 'authority' | 'person_masked' | 'unknown';

export interface CaBuyer {
  readonly fiscalCode: string;
  readonly displayKind: CaBuyerKind;
  readonly name: string | null;
  readonly countyCode: string | null;
  readonly siruta: string | null;
  readonly region: string | null;
}

/**
 * company | person_masked | code_only (as on the DA path) | withheld (a code the naming rule does
 * not show: no code, no name) | unidentified (the source gives no usable code).
 */
export type CaWinnerKind = 'company' | 'person_masked' | 'code_only' | 'withheld' | 'unidentified';

export interface CaWinner {
  readonly order: number | null;
  readonly displayKind: CaWinnerKind;
  readonly fiscalCode: string | null;
  readonly name: string | null;
  /** True for a code in the DA gate (supplier_disclosure); null when no code is shown. */
  readonly disclosed: boolean | null;
}

export interface CaLot {
  readonly lotOrder: number;
  readonly lotNumber: string | null;
  readonly title: string | null;
  readonly cpvCode: string | null;
  /** An estimate as published, never in a total. */
  readonly estimatedValue: string | null;
  readonly currency: string | null;
  readonly isEuFunded: boolean | null;
  readonly cancelledStatus: string | null;
}

export interface CaRecord {
  readonly recordId: string;
  readonly contractKind: string | null;
  readonly valueKind: string;
  readonly additive: boolean;
  readonly status: string;
  readonly headStatus: string | null;
  readonly amountLei: string | null;
  readonly nativeAmount: string | null;
  readonly currency: string | null;
  readonly fxSource: string | null;
  readonly vatBasis: string;
  readonly amountOrigin: string | null;
  readonly flags: readonly string[];
  readonly changeLei: string | null;
  readonly changePublicationDay: string | null;
  readonly awardDay: string | null;
  readonly publicationDay: string | null;
  readonly buyer: CaBuyer | null;
  readonly cpvCode: string | null;
  readonly cpvDivision: string | null;
  readonly cpvGroup: string | null;
  readonly cpvClass: string | null;
  readonly procedureId: string | null;
  readonly noticeNo: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null;
  readonly winnerCount: number;
  readonly lotCount: number;
  readonly winners: readonly CaWinner[];
}

// ── Mapping with invariants ──────────────────────────────────────────────────

const refused = (what: string): ApiError =>
  databaseError(`Contract-award ${what} breaks the serving contract; response refused.`);

const DECIMAL_TEXT = /^-?[0-9]+(\.[0-9]{1,2})?$/u;
const DAY_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const VALUE_KINDS: ReadonlySet<string> = new Set(['awarded', 'framework_ceiling']);
const STATUSES: ReadonlySet<string> = new Set(['awarded', 'identity_review']);
const FLAGS: ReadonlySet<string> = new Set([
  'list_value',
  'page_value',
  'foreign_equivalent',
  'native_disagreement',
  'zero',
  'negative',
  'joint_win',
]);

const isMoney = (value: string | null): boolean => value === null || DECIMAL_TEXT.test(value);
const isDay = (value: string | null): boolean => value === null || DAY_TEXT.test(value);

/** An identifier as served: none when it carries a run of 11+ digits (a person's code's length). */
const withoutCodeRun = (text: string | null): string | null =>
  text === null || hasPersonCodeRun(text) ? null : text;

/**
 * The portal's public identifier formats, allowlisted: a notice number is digits after an optional
 * letter prefix (CAN1234567; about 1.5% of prod's are digits only), a procedure id digits.
 * Anything else (free text, a dotted or spaced code) is not served. The digit runs stay under 11
 * (a person's code's length), as `withoutCodeRun` also checks.
 */
const NOTICE_NO = /^[A-Z]{0,6}[0-9]{1,10}$/u;
const PROCEDURE_ID = /^[0-9]{1,10}$/u;
const allowlisted = (text: string | null, format: RegExp): string | null =>
  text !== null && format.test(text) ? withoutCodeRun(text) : null;

/** A masked or registry name as served: the personal-code screen and any 11+ digit run withhold it. */
const servedName = (name: string | null): string | null => {
  const screened = publicPartyName(name);
  return screened === null || hasPersonCodeRun(screened) ? null : screened;
};

/**
 * The buyer as served. A person (or a buyer whose person flag is unknown) is never named by code:
 * only the masked name the view gives, screened.
 */
export const toCaBuyer = (
  buyer: CaBuyerRecord,
  place: Pick<CaBuyer, 'countyCode' | 'siruta' | 'region'>
): CaBuyer =>
  buyer.person === false
    ? {
        fiscalCode: buyer.code,
        displayKind: 'authority',
        name: servedName(buyer.registryName),
        ...place,
      }
    : {
        fiscalCode: buyer.code,
        displayKind: buyer.person === true ? 'person_masked' : 'unknown',
        name: buyer.person === true ? servedName(buyer.maskedName) : null,
        ...place,
      };

const WITHHELD: Omit<CaWinner, 'order'> = {
  displayKind: 'withheld',
  fiscalCode: null,
  name: null,
  disclosed: null,
};

/**
 * A winner as served. The code is shown only when the names view shows it (`source: 'view'`, not
 * hidden): a D6 code with its naming (company, person_masked or code_only). A code outside D6 is
 * shown as a company with the view's registry name when the view names it (owner, 25 Nov: the
 * contract-award gate is widened for registry-named companies seen only in awards), else by code
 * only or masked (naming step 2b).
 */
export const toCaWinner = (row: CaWinnerRow): CaWinner => {
  const order = row.winnerOrder;
  if (row.fiscalCode === null || !isPublicCode(row.fiscalCode)) {
    return { order, displayKind: 'unidentified', fiscalCode: null, name: null, disclosed: null };
  }
  const naming = row.naming;
  if (naming?.source !== 'view' || naming.kind === 'hidden') return { order, ...WITHHELD };
  if (row.supplierDisclosed === true) {
    return {
      order,
      displayKind: naming.kind,
      fiscalCode: row.fiscalCode,
      name: naming.kind === 'code_only' ? null : servedName(servedSupplierName(naming)),
      disclosed: true,
    };
  }
  if (row.supplierDisclosed !== false) return { order, ...WITHHELD };
  // `company` comes only from the view's `named` with a name that passed the screens.
  if (naming.kind === 'company')
    return {
      order,
      displayKind: 'company',
      fiscalCode: row.fiscalCode,
      name: servedName(servedSupplierName(naming)),
      disclosed: false,
    };
  const shown = undisclosedNaming(naming);
  if (shown.kind !== 'person_masked' && shown.kind !== 'code_only') return { order, ...WITHHELD };
  return {
    order,
    displayKind: shown.kind,
    fiscalCode: row.fiscalCode,
    name: shown.kind === 'person_masked' ? servedName(servedSupplierName(shown)) : null,
    disclosed: false,
  };
};

export const toCaLot = (row: CaLotRow): Result<CaLot, ApiError> => {
  if (!Number.isSafeInteger(row.lotOrder)) return err(refused('lot order'));
  if (row.estimatedValue !== null && !/^-?[0-9]+(\.[0-9]+)?$/u.test(row.estimatedValue))
    return err(refused('lot estimate'));
  return ok({
    lotOrder: row.lotOrder,
    lotNumber: publicFreeText(row.lotNumber),
    title: publicFreeText(row.title),
    cpvCode: row.cpvCode,
    estimatedValue: row.estimatedValue,
    currency: row.currency,
    isEuFunded: row.isEuFunded,
    cancelledStatus: row.cancelledStatus,
  });
};

/** Winners by their order, unordered rows last (stable: the read order breaks ties). */
const byWinnerOrder = (a: CaWinnerRow, b: CaWinnerRow): number => {
  if (a.winnerOrder === b.winnerOrder) return 0;
  if (a.winnerOrder === null) return 1;
  if (b.winnerOrder === null) return -1;
  return a.winnerOrder - b.winnerOrder;
};

/** Whether an award day is before the floor (a null day is undated, not outside). */
export const isBeforeFloor = (awardDay: string | null, floor: string): boolean =>
  awardDay !== null && awardDay < floor;

export const toCaRecord = (
  row: CaRecordRow,
  buyer: CaBuyerRecord | null,
  winners: readonly CaWinnerRow[]
): Result<CaRecord, ApiError> => {
  if (!VALUE_KINDS.has(row.valueKind)) return err(refused('value kind'));
  if (!STATUSES.has(row.status)) return err(refused('status'));
  // A record under identity review is shown, never additive (owner, 20 Nov).
  if (row.status === 'identity_review' && row.additive) return err(refused('review record'));
  if (![row.amountLei, row.nativeAmount, row.changeLei].every(isMoney))
    return err(refused('amount'));
  if (![row.awardDay, row.publicationDay, row.changePublicationDay].every(isDay))
    return err(refused('day'));
  if (!row.flags.every((flag) => FLAGS.has(flag))) return err(refused('flag'));
  if (!Number.isSafeInteger(row.winnerCount) || !Number.isSafeInteger(row.lotCount))
    return err(refused('count'));
  if (winners.length !== row.winnerCount) return err(refused('winner count'));
  if (row.buyerCode !== null && buyer !== null && buyer.code !== row.buyerCode)
    return err(refused('buyer'));
  // A buyer code without an organization code's shape is not served (the view does not check it).
  const servedBuyer =
    row.buyerCode === null || !isPublicCode(row.buyerCode)
      ? null
      : toCaBuyer(
          // The row's own person flag decides, whatever the buyer lookup carried.
          {
            code: row.buyerCode,
            person: row.buyerPerson,
            maskedName: row.buyerNameMasked,
            registryName: row.buyerPerson === false ? (buyer?.registryName ?? null) : null,
          },
          { countyCode: row.buyerCountyCode, siruta: row.buyerSiruta, region: row.buyerRegion }
        );
  return ok({
    recordId: caRecordIdOf(row),
    contractKind: row.contractKind,
    valueKind: row.valueKind,
    additive: row.additive,
    status: row.status,
    headStatus: row.caHeadStatus,
    amountLei: row.amountLei,
    nativeAmount: row.nativeAmount,
    currency: row.currency,
    fxSource: row.fxSource,
    vatBasis: row.vatBasis,
    amountOrigin: row.amountOrigin,
    flags: row.flags,
    changeLei: row.changeLei,
    changePublicationDay: row.changePublicationDay,
    awardDay: row.awardDay,
    publicationDay: row.publicationDay,
    buyer: servedBuyer,
    cpvCode: row.cpvCode,
    cpvDivision: row.cpvDivision,
    cpvGroup: row.cpvGroup,
    cpvClass: row.cpvClass,
    procedureId: allowlisted(row.procedureId, PROCEDURE_ID),
    noticeNo: allowlisted(row.noticeNo, NOTICE_NO),
    title: publicFreeText(row.title),
    sourceUrl: row.sourceUrl,
    winnerCount: row.winnerCount,
    lotCount: row.lotCount,
    winners: [...winners].sort(byWinnerOrder).map(toCaWinner),
  });
};
