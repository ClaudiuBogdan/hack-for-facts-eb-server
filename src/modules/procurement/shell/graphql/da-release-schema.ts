/**
 * Direct acquisitions, release 1 — GraphQL. New names beside the legacy
 * `ProcurementDirectAcquisition` surface, which this slice does not touch.
 * The SDL is always served; with PROCUREMENT_DA_V3_ENABLED off,
 * `procurementDaRelease.enabled` is false and every data query answers
 * SERVICE_UNAVAILABLE. Same usecases as REST and MCP.
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

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
  """
  type ProcurementDaRelease {
    enabled: Boolean!
    "When the served data was published (ISO 8601, UTC). Null when not enabled."
    dataAsOf: DateTime
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

  "One direct acquisition (release 1). Money is decimal text in lei excluding VAT."
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
    "The closing value as the portal reports it. Shown on every row, never summed."
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
    title: String
    description: String
    "CPV code as written."
    categoryCode: String
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
    name: String
    unit: String
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

  type ProcurementDaPurchasePage {
    items: [ProcurementDaPurchase!]!
    page: Int!
    pageSize: Int!
    "Exact unless totalCapped; then a lower bound (10000)."
    total: Int!
    totalCapped: Boolean!
    hasMore: Boolean!
    dataAsOf: DateTime!
    valueBasis: String!
  }

  type ProcurementDaPurchaseDetail {
    purchase: ProcurementDaPurchase!
    "In itemIndex order."
    items: [ProcurementDaPurchaseItem!]!
    dataAsOf: DateTime!
    valueBasis: String!
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
    "Party id (null for the withheld and no-supplier buckets), CPV division, YYYY-MM or YYYY."
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
    valueBasis: String!
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

export const makeDaReleaseResolvers = (deps: DaReleaseDeps) => ({
  Query: {
    procurementDaRelease: () => daReleaseStatus(deps),
    procurementDaPurchases: async (_root: unknown, args: PageArgs & { filter?: unknown }) =>
      unwrap(await listDaPurchases(deps, { filter: withoutNulls(args.filter), ...pageOf(args) })),
    procurementDaPurchase: async (_root: unknown, args: { purchaseId: string }) =>
      unwrap(await getDaPurchase(deps, args.purchaseId)),
    procurementDaTotals: async (
      _root: unknown,
      args: PageArgs & { filter?: unknown; groupBy?: string | null }
    ) =>
      unwrap(
        await daPurchaseTotals(deps, {
          filter: withoutNulls(args.filter),
          groupBy: args.groupBy ?? null,
          ...pageOf(args),
        })
      ),
  },
});
