/**
 * Contract awards (PROC-KB0Z step 1): GraphQL. New names beside the retired
 * legacy `procurementContracts` / `procurementContract`, whose shapes (a numeric
 * id, contract numbers, value states) these views cannot serve. The SDL is always
 * served; with PROCUREMENT_CA_RECORDS_ENABLED off every query answers
 * SERVICE_UNAVAILABLE. Same usecases as REST.
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import { markNoStore } from './no-store.js';
import {
  caBuyerSummary,
  getCaRecord,
  listCaBuyerRecords,
  OUTSIDE_WINDOW_RESOURCE,
  type CaRecordsDeps,
} from '../../core/ca-records-usecases.js';

import type { Result } from 'neverthrow';

export const caRecordsTypeDefs = /* GraphQL */ `
  """
  The published window of contract awards: award days from floor (2021-01-01). from is the
  asked start raised to the floor; to is inclusive. Earlier years are loaded but not published.
  """
  type ProcurementCaWindow {
    floor: Date!
    from: Date!
    to: Date
  }

  """
  A contract award's buyer. authority: named by its public registry name, or a null name.
  person_masked: a buyer that is a person, shown with a masked name or none; never look up its
  name by code elsewhere. unknown: no record says which (a buyer with none); no name.
  """
  type ProcurementCaBuyer {
    fiscalCode: String!
    "authority | person_masked | unknown. Treat any other value as showing no name."
    displayKind: String!
    name: String
    countyCode: String
    siruta: String
    region: String
  }

  """
  A winner of a contract award. company (a name), person_masked (a masked name), code_only (no
  name) carry fiscalCode; withheld and unidentified carry neither code nor name. disclosed is true
  for a supplier in the direct-acquisition gate, false for one shown by code only.
  """
  type ProcurementCaWinner {
    order: Int
    "company | person_masked | code_only | withheld | unidentified"
    displayKind: String!
    fiscalCode: String
    name: String
    disclosed: Boolean
  }

  "A lot of a contract award. estimatedValue is an estimate as published, never a total."
  type ProcurementCaLot {
    lotOrder: Int!
    lotNumber: String
    title: String
    cpvCode: String
    estimatedValue: String
    currency: String
    isEuFunded: Boolean
    cancelledStatus: String
  }

  """
  One contract award (one contract identity). Money is decimal text in lei unless named native.
  recordId is build-scoped: it can move after a later build; procurementContractAward still
  resolves an earlier id (reanchored).
  """
  type ProcurementCaRecord {
    recordId: ID!
    "ordinary | call_off | framework_agreement"
    contractKind: String
    "awarded | framework_ceiling"
    valueKind: String!
    "In market totals (false for a record under identity review)."
    additive: Boolean!
    "awarded | identity_review"
    status: String!
    "confirmed | unverified | null"
    headStatus: String
    amountLei: String
    nativeAmount: String
    currency: String
    fxSource: String
    vatBasis: String!
    amountOrigin: String
    "list_value | page_value | foreign_equivalent | native_disagreement | zero | negative | joint_win"
    flags: [String!]!
    "The latest observed change in reported price, in lei; not added to amountLei."
    changeLei: String
    changePublicationDay: Date
    awardDay: Date
    publicationDay: Date
    buyer: ProcurementCaBuyer
    cpvCode: String
    cpvDivision: String
    cpvGroup: String
    cpvClass: String
    procedureId: String
    noticeNo: String
    title: String
    "The portal page of the current notice."
    sourceUrl: String
    winnerCount: Int!
    lotCount: Int!
    winners: [ProcurementCaWinner!]!
  }

  """
  A buyer's contract awards in the window: counts only (no lei sum yet). undatedCount counts the
  buyer's records with no award day, which no dated list or count includes.
  """
  type ProcurementCaBuyerSummary {
    dataAsOf: DateTime!
    """
    dataAsOf, or unavailable when the names view is not readable (no winner code is then shown).
    Every contract-award answer is no-store: winner codes and names can be withdrawn without
    dataAsOf moving, so never keep them beyond the response that carried them.
    """
    disclosureKey: String!
    window: ProcurementCaWindow!
    buyer: ProcurementCaBuyer!
    recordCount: Int!
    valuedCount: Int!
    identityReviewCount: Int!
    undatedCount: Int!
  }

  type ProcurementCaRecordPage {
    dataAsOf: DateTime!
    disclosureKey: String!
    window: ProcurementCaWindow!
    items: [ProcurementCaRecord!]!
    page: Int!
    pageSize: Int!
    "The records in the window."
    total: Int!
    hasMore: Boolean!
    "True when the window holds more records than a list may reach (row 10000): narrow it."
    depthLimited: Boolean!
  }

  type ProcurementCaRecordDetail {
    dataAsOf: DateTime!
    disclosureKey: String!
    record: ProcurementCaRecord!
    lots: [ProcurementCaLot!]!
    "True when the id asked for was issued by an earlier build; use record.recordId from now on."
    reanchored: Boolean!
  }

  enum ProcurementCaListSort {
    awardDayDesc
    awardDayAsc
    amountDesc
  }

  extend type Query {
    """
    A buyer's contract awards in the published window: counts. Each contract-award query field
    reads in its own database snapshot and reports its dataAsOf: when one operation combines
    several, compare their dataAsOf and refetch if they differ.
    """
    procurementContractAwardSummary(
      buyerFiscalCode: String!
      from: Date
      to: Date
    ): ProcurementCaBuyerSummary!
    "A buyer's contract awards in the published window. Pages reach at most row 10000; pageSize at most 50."
    procurementContractAwards(
      buyerFiscalCode: String!
      from: Date
      to: Date
      sort: ProcurementCaListSort = awardDayDesc
      page: Int = 1
      pageSize: Int = 20
    ): ProcurementCaRecordPage!
    """
    One contract award with its winners and lots. NOT_FOUND when absent; NOT_FOUND with
    extensions.reason OUTSIDE_PUBLISHED_WINDOW when its award day is before the floor.
    """
    procurementContractAward(recordId: ID!): ProcurementCaRecordDetail!
  }
`;

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) {
    const error = result.error;
    throw new GraphQLError(error.message, {
      extensions: {
        code: GRAPHQL_ERROR_CODE[error.type],
        ...(error.type === 'NotFound' &&
          error.resource === OUTSIDE_WINDOW_RESOURCE && { reason: 'OUTSIDE_PUBLISHED_WINDOW' }),
      },
    });
  }
  return result.value;
};

interface WindowArgs {
  buyerFiscalCode: string;
  from?: string | null;
  to?: string | null;
}

export const makeCaRecordsResolvers = (deps: CaRecordsDeps) => ({
  ProcurementCaWinner: {
    name: (winner: { name: string | null }, _a: unknown, context: unknown) => {
      markNoStore(context);
      return winner.name;
    },
  },
  // Every root marks the answer no-store before it reads: a winner code or name can be withdrawn
  // without dataAsOf moving (a selection of fiscalCode alone must not be cached either).
  Query: {
    procurementContractAwardSummary: async (_root: unknown, args: WindowArgs, context: unknown) => {
      markNoStore(context);
      return unwrap(await caBuyerSummary(deps, args));
    },
    procurementContractAwards: async (
      _root: unknown,
      args: WindowArgs & { sort?: string | null; page?: number | null; pageSize?: number | null },
      context: unknown
    ) => {
      markNoStore(context);
      return unwrap(
        await listCaBuyerRecords(deps, {
          ...args,
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
        })
      );
    },
    procurementContractAward: async (
      _root: unknown,
      args: { recordId: string },
      context: unknown
    ) => {
      markNoStore(context);
      return unwrap(await getCaRecord(deps, args.recordId));
    },
  },
});
