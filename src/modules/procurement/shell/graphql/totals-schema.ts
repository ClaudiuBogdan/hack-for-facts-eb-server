/**
 * Totals v2 (docs/server-redesign/10-public-contracts-totals-v2.md): one batch
 * query, filters only. Off unless PROCUREMENT_TOTALS_V2=true: the SDL is
 * served, and every read answers ServiceUnavailable without a query.
 */

import { serviceUnavailable } from '@/modules/shared/index.js';

import { toGraphqlError } from './resolvers.js';
import {
  moneyTotals,
  type MoneyTotalsPort,
  type TotalsRequestInput,
} from '../../core/money-totals.js';

export const totalsTypeDefs = /* GraphQL */ `
  """
  Totals v2 filters. procurementKinds is required: kinds are never mixed unless
  asked. Defaults: statuses [awarded]; no date range (undated rows count);
  every VAT basis. Codes are fiscal codes (digits).
  """
  input ProcurementTotalsFiltersInput {
    procurementKinds: [String!]!
    contractKinds: [String!]
    statuses: [String!]
    "YYYY-MM-DD, inclusive. With a range, undated rows are the 'undated' exclusion."
    from: String
    to: String
    buyerCode: String
    "A firm's own sum: joint wins are left out ('association_unattributed')."
    supplierCode: String
    cpvPrefix: String
    countyCode: String
    siruta: String
    vatBases: [String!]
    "Title words (3-100 characters), over the labelled title."
    q: String
  }

  input ProcurementTotalRequestInput {
    "A client key, echoed back."
    id: ID!
    filters: ProcurementTotalsFiltersInput!
    "Default [awarded]. One total per kind, never summed across kinds."
    valueKinds: [String!]
    "Adds a subtotal per original currency (amounts as published)."
    currencySubtotals: Boolean
  }

  type ProcurementTotalsLabel {
    key: String!
    labelRo: String!
    labelEn: String!
  }

  type ProcurementTotalsVatMix {
    excluded: String!
    included: String!
    unknown: String!
  }

  type ProcurementTotalsCurrency {
    currency: String!
    "Sum as published, in that currency (decimal string)."
    sum: String!
    count: String!
  }

  type ProcurementTotalFigure {
    valueKind: String!
    "Lei, decimal string, summed as published (no VAT conversion)."
    sumLei: String!
    recordCount: String!
    withValueCount: String!
    vatMix: ProcurementTotalsVatMix!
    currencies: [ProcurementTotalsCurrency!]
  }

  "A fact of a requested value kind left out of the total, with its reason."
  type ProcurementTotalsExclusion {
    key: String!
    labelRo: String!
    labelEn: String!
    valueKind: String!
    count: String!
    "Null when none of the excluded records has a lei amount."
    valueLei: String
  }

  "Included, but flagged (e.g. an unconfirmed contract head, a list-value ceiling)."
  type ProcurementTotalsFlag {
    key: String!
    labelRo: String!
    labelEn: String!
    valueKind: String!
    count: String!
  }

  "Included and disclosed (e.g. records whose supplier is withheld under D6)."
  type ProcurementTotalsDisclosure {
    key: String!
    labelRo: String!
    labelEn: String!
    valueKind: String!
    count: String!
    valueLei: String!
  }

  type ProcurementTotalsFiltersApplied {
    procurementKinds: [String!]!
    contractKinds: [String!]
    statuses: [String!]!
    from: String
    to: String
    buyerCode: String
    supplierCode: String
    cpvPrefix: String
    countyCode: String
    siruta: String
    vatBases: [String!]
    q: String
  }

  type ProcurementTotalsIncluded {
    procurementKinds: [ProcurementTotalsLabel!]!
    statuses: [ProcurementTotalsLabel!]!
    valueKinds: [ProcurementTotalsLabel!]!
  }

  type ProcurementTotalsExplanation {
    textRo: String!
    textEn: String!
  }

  type ProcurementTotalsPopulation {
    valueKind: String!
    count: String!
  }

  """
  One answered request. factBuild is the money build every request of the
  call was read from: key caches on it. Per value kind, recordCount plus every
  exclusion count equals the population count.
  """
  type ProcurementTotal {
    id: ID!
    factBuild: String!
    filtersApplied: ProcurementTotalsFiltersApplied!
    valueKinds: [String!]!
    included: ProcurementTotalsIncluded!
    totals: [ProcurementTotalFigure!]!
    exclusions: [ProcurementTotalsExclusion!]!
    flags: [ProcurementTotalsFlag!]!
    disclosures: [ProcurementTotalsDisclosure!]!
    "Notes on the request with no count (e.g. a supplier code that is not public)."
    notes: [ProcurementTotalsLabel!]!
    "Composed from the applied filters, labels and counts; print verbatim."
    explanation: ProcurementTotalsExplanation!
    population: [ProcurementTotalsPopulation!]!
  }

  extend type Query {
    "Totals v2: up to 8 requests, all read from one money build."
    procurementTotals(requests: [ProcurementTotalRequestInput!]!): [ProcurementTotal!]!
  }
`;

export const makeTotalsResolvers = (port: MoneyTotalsPort | undefined) => ({
  Query: {
    procurementTotals: async (
      _root: unknown,
      args: { readonly requests: readonly TotalsRequestInput[] }
    ) => {
      if (port === undefined) {
        throw toGraphqlError(
          serviceUnavailable('procurement totals v2 is not enabled on this server')
        );
      }
      const result = await moneyTotals(port, args.requests);
      if (result.isErr()) throw toGraphqlError(result.error);
      return result.value;
    },
  },
});
