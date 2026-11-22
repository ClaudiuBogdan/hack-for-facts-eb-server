/**
 * Direct acquisitions, release 1 — GraphQL. New names beside the legacy
 * `ProcurementDirectAcquisition` surface, which this slice does not touch.
 * The SDL is always served; with PROCUREMENT_DA_V3_ENABLED off,
 * `procurementDaRelease.enabled` is false and every data query answers
 * SERVICE_UNAVAILABLE. Same usecases as REST and MCP.
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import { markNoStore } from './no-store.js';
import {
  daPurchaseTotals,
  daReleaseStatus,
  getDaPurchase,
  listDaPurchases,
  type DaReleaseDeps,
} from '../../core/da-release-usecases.js';

import type { Result } from 'neverthrow';

export const daReleaseTypeDefs = /* GraphQL */ `
  """
  Direct acquisitions release 1: whether this server serves it, and the data's as-of time.
  Choose the release-1 path from enabled; the legacy direct-acquisition fields stay until the switch.
  Each release-1 query field reads in its own database snapshot and reports its dataAsOf: when one
  operation combines several, compare their dataAsOf and refetch if they differ.
  """
  type ProcurementDaRelease {
    enabled: Boolean!
    "When the served data was published (ISO 8601, UTC, microseconds). Null when not enabled."
    dataAsOf: DateTime
    "Site-wide D6 is enforced (its own switch, independent of enabled)."
    privacyEnforced: Boolean!
    """
    The supplier_privacy publication in force; null when D6 is off or its source is absent (every
    DA supplier is then withheld). Key caches by (privacyEnforced, privacyAsOf, dataAsOf):
    privacyAsOf is null both while D6 is off and while it is on but unreadable; never cache a DA
    answer received while privacyEnforced is true and privacyAsOf is null. Supplier names come from
    the live registry and can be withdrawn without any key moving: keys cover codes, counts and
    values, never names. Do not keep a supplier name beyond the response that carried it.
    """
    privacyAsOf: DateTime
  }

  """
  A buyer or supplier as served. Supplier names follow D6: a supplier is named only when it is a
  company with a valid fiscal code; every other supplier is natural_person with name, fiscalCode
  and partyId all null. Never fill a withheld name from another source.
  """
  type ProcurementDaParty {
    "authority (every buyer) | company (a named supplier) | natural_person (a withheld supplier)"
    displayKind: String!
    "The portal's party id; null when withheld."
    partyId: String
    name: String
    "Digits only, no RO prefix; null when withheld or not a valid code."
    fiscalCode: String
  }

  "A coded label served in English and Romanian."
  type ProcurementDaLabel {
    code: String!
    labelEn: String!
    labelRo: String!
  }

  "A value-review rule and its public sentence."
  type ProcurementDaValueRule {
    rule: String!
    "correct | exclude | keep"
    effect: String!
    descriptionEn: String
    descriptionRo: String
  }

  """
  One direct acquisition (release 1). Money is decimal text. countedValue is in lei excluding VAT;
  reportedValue is as published.
  """
  type ProcurementDaPurchase {
    "Stable public id (64 hex); use it in URLs."
    purchaseId: ID!
    nativeId: String
    "The portal's code, e.g. DA37709621 (unique)."
    code: String
    sourceUrl: String
    "accepted | refused | expired | unknown"
    outcome: String!
    "The portal's state label as written."
    stateLabel: String
    publicationDay: Date
    finalizationDay: Date
    buyerDecisionAt: DateTime
    supplierDecisionAt: DateTime
    """
    The closing value as the portal published it. Shown on every row, never summed. Its currency
    and VAT basis are confirmed only when the purchase is counted (see countedValueBasis).
    """
    reportedValue: String
    "Included in totals."
    counted: Boolean!
    "The only summable value; null when not counted. Equals reportedValue or the approved correction."
    countedValue: String
    "Why the purchase is not counted; null when counted."
    notCountedReason: ProcurementDaLabel
    "True when countedValue is an approved correction of reportedValue."
    valueCorrected: Boolean!
    "countedValue when it is a correction, otherwise null."
    correctedValue: String
    "The review rule that corrected or excluded this purchase, with its public sentence."
    reviewRule: ProcurementDaValueRule
    "Value of 0 or 0.01 lei: counted, flagged."
    symbolicPrice: Boolean!
    "False when the portal no longer lists the purchase; null when not known."
    listedNow: Boolean
    """
    Free text is restricted until it passes the privacy review: title and description are null
    with titleWithheld / descriptionWithheld = "privacy" unless the field is marked public. Show
    categoryLabel as the purchase's name while the title is withheld.
    """
    title: String
    titleWithheld: String
    description: String
    descriptionWithheld: String
    "CPV code as written."
    categoryCode: String
    "The CPV label as written; the purchase's visible name while its title is withheld."
    categoryLabel: String
    "First two digits of categoryCode."
    cpvDivision: String
    "Furnizare / Servicii / Lucrari as written."
    acquisitionTypeLabel: String
    buyer: ProcurementDaParty
    "Null when the purchase names no supplier."
    supplier: ProcurementDaParty
  }

  "One line of a purchase, as reported. Line values are never summed."
  type ProcurementDaPurchaseItem {
    itemIndex: Int!
    "Null, with nameWithheld set to privacy, unless the line's name is marked public."
    name: String
    nameWithheld: String
    "Free text: null, with unitWithheld set to privacy, unless the line's unit is marked public."
    unit: String
    unitWithheld: String
    quantity: String
    requestedQuantity: String
    "Closing unit price."
    unitPrice: String
    "Catalogue price (catalogue items only)."
    cataloguePrice: String
    "quantity × unitPrice as reported; never summed."
    reportedLineValue: String
    supplierRejected: Boolean
    quantityCorrection: Boolean
  }

  """
  The D6 state a release answer was served under. disclosureKey is the release's dataAsOf when
  supplier_privacy was readable in its snapshot, else unavailable (everyone withheld; never cache).
  Dated keys only move forward: keep the newest seen, never cache an answer with an older key.
  Supplier names come from the live registry and can be withdrawn without any key moving: keys
  cover codes, counts and values, never names. Do not keep a supplier name beyond the response that
  carried it.
  """
  type ProcurementDaReleaseMeta {
    disclosureKey: String
  }

  type ProcurementDaPurchasePage {
    items: [ProcurementDaPurchase!]!
    page: Int!
    pageSize: Int!
    "Exact unless totalCapped; then 10000, the last row a page can reach (a page may start below it)."
    total: Int!
    totalCapped: Boolean!
    hasMore: Boolean!
    dataAsOf: DateTime!
    countedValueBasis: String!
    "D6: the key this answer was served under (docs 10, monotonic keys)."
    meta: ProcurementDaReleaseMeta!
  }

  type ProcurementDaPurchaseDetail {
    purchase: ProcurementDaPurchase!
    "In itemIndex order."
    items: [ProcurementDaPurchaseItem!]!
    dataAsOf: DateTime!
    countedValueBasis: String!
    "D6: the key this answer was served under (docs 10, monotonic keys)."
    meta: ProcurementDaReleaseMeta!
  }

  "Totals of a scope: only countedValue is a sum; counts are integers as text."
  type ProcurementDaTotals {
    "Sum of counted values; null when nothing in scope is counted."
    countedValue: String
    countedCount: String!
    symbolicPriceCount: String!
    "Every purchase in scope, counted or not."
    purchaseCount: String!
  }

  type ProcurementDaTotalsGroup {
    "Party id; natural_person for the one withheld-supplier bucket; null for no supplier. Else CPV division, YYYY-MM or YYYY."
    key: String
    "Buyer and supplier groups. Every withheld supplier is one natural_person group with no name."
    party: ProcurementDaParty
    "Supplier groups: the bucket of purchases that name no supplier."
    noSupplier: Boolean!
    countedValue: String
    countedCount: String!
    symbolicPriceCount: String!
    purchaseCount: String!
  }

  "List order; purchaseId breaks ties. countedValueDesc puts uncounted purchases last."
  enum ProcurementDaListSort {
    finalizationDesc
    finalizationAsc
    countedValueDesc
  }

  enum ProcurementDaTotalsGroupBy {
    buyer
    supplier
    cpvDivision
    month
    year
  }

  type ProcurementDaTotalsAnswer {
    groupBy: ProcurementDaTotalsGroupBy
    overall: ProcurementDaTotals!
    "Buyer, supplier and CPV groups by counted value (descending); month and year by key."
    groups: [ProcurementDaTotalsGroup!]!
    page: Int!
    pageSize: Int!
    groupCount: Int!
    hasMore: Boolean!
    dataAsOf: DateTime!
    countedValueBasis: String!
    "D6: the key this answer was served under (docs 10, monotonic keys)."
    meta: ProcurementDaReleaseMeta!
  }

  """
  Narrows direct acquisitions (AND). supplierFiscalCode matches only suppliers D6 names.
  Days are inclusive bounds on finalizationDay.
  """
  input ProcurementDaPurchaseFilter {
    buyerFiscalCode: String
    supplierFiscalCode: String
    cpvDivision: String
    finalizationFrom: Date
    finalizationTo: Date
    "accepted | refused | expired | unknown"
    outcomes: [String!]
    counted: Boolean
    "The portal code; resolves a legacy link's uniqueCode to purchaseId."
    code: String
    nativeId: String
  }

  extend type Query {
    "Whether direct acquisitions release 1 is served here, and its dataAsOf."
    procurementDaRelease: ProcurementDaRelease!
    "Release-1 purchases, newest finalization first. Pages reach at most row 10000."
    procurementDaPurchases(
      filter: ProcurementDaPurchaseFilter
      sort: ProcurementDaListSort = finalizationDesc
      page: Int = 1
      pageSize: Int = 20
    ): ProcurementDaPurchasePage!
    "One release-1 purchase with its lines. NOT_FOUND when absent."
    procurementDaPurchase(purchaseId: ID!): ProcurementDaPurchaseDetail!
    "Totals of counted values for the filtered scope, optionally grouped."
    procurementDaTotals(
      filter: ProcurementDaPurchaseFilter
      groupBy: ProcurementDaTotalsGroupBy
      page: Int = 1
      pageSize: Int = 20
    ): ProcurementDaTotalsAnswer!
  }
`;

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};

/** GraphQL passes absent nullable input fields as null; the shared filter schema wants them absent. */
const withoutNulls = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== null)
  );
};

interface PageArgs {
  page?: number | null;
  pageSize?: number | null;
}

const pageOf = (args: PageArgs) => ({ page: args.page ?? 1, pageSize: args.pageSize ?? 20 });

/**
 * The envelope's D6 key as the GraphQL meta object, built in the Query resolvers
 * themselves: the procurement module merges only `Query` from this factory.
 */
const withMeta = <T extends { readonly disclosureKey: string }>(answer: T) => ({
  ...answer,
  meta: { disclosureKey: answer.disclosureKey },
});

export const makeDaReleaseResolvers = (deps: DaReleaseDeps) => ({
  ProcurementDaParty: {
    // PROC-VDWQ: a named supplier (company) makes the answer never cacheable; buyers do not.
    name: (party: { displayKind: string; name: string | null }, _a: unknown, context: unknown) => {
      if (party.displayKind === 'company' && party.name !== null) markNoStore(context);
      return party.name;
    },
  },
  Query: {
    procurementDaRelease: () => daReleaseStatus(deps),
    procurementDaPurchases: async (
      _root: unknown,
      args: PageArgs & { filter?: unknown; sort?: string | null }
    ) =>
      withMeta(
        unwrap(
          await listDaPurchases(deps, {
            filter: withoutNulls(args.filter),
            sort: args.sort ?? null,
            ...pageOf(args),
          })
        )
      ),
    procurementDaPurchase: async (_root: unknown, args: { purchaseId: string }) =>
      withMeta(unwrap(await getDaPurchase(deps, args.purchaseId))),
    procurementDaTotals: async (
      _root: unknown,
      args: PageArgs & { filter?: unknown; groupBy?: string | null }
    ) =>
      withMeta(
        unwrap(
          await daPurchaseTotals(deps, {
            filter: withoutNulls(args.filter),
            groupBy: args.groupBy ?? null,
            ...pageOf(args),
          })
        )
      ),
  },
});
