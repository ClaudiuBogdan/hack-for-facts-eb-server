import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  toGraphQLInput,
  type ApiError,
  type FilterInput,
} from '@/modules/shared/index.js';

import { ngoRegistryFilterSpec, normalizeNgoFilters } from '../../core/filters.js';
import {
  getNgoRegistryCoverage,
  getNgoRegistryRecord,
  listNgoRegistry,
} from '../../core/usecases.js';
import { registryFilterHash } from '../repo/registry-repo.js';

import type { NgoRegistryRepository } from '../../core/ports.js';
import type { Result } from 'neverthrow';

export const ngoRegistryTypeDefs =
  toGraphQLInput(ngoRegistryFilterSpec) +
  `
  type NgoRegistrySnapshot {
    id: ID!
    sourceDeclaredDate: Date
    importedAt: DateTime!
    capturedAt: DateTime!
    refreshOverdue: Boolean!
    acceptedAt: DateTime
    recordCount: Int!
    isCurrent: Boolean!
    sourceUrl: String!
    coverageBasis: String!
    nationalCompleteness: String!
  }
  type NgoRegistryRecord {
    id: ID!
    sourceRowNumber: Int!
    registryNumber: String!
    specialRegistryNumber: String
    sourceRegistrationDate: Date
    category: String!
    legalForm: String!
    name: String!
    nameWithheld: Boolean!
    court: String!
    sourceRegistryStatus: String!
    county: String
    locality: String
    sourceCui: String
    linkedOrganizationCui: CUI
    isBranch: Boolean
    sourceReportsPublicUtility: Boolean
    snapshot: NgoRegistrySnapshot!
  }
  type NgoRegistryEdge { cursor: String! node: NgoRegistryRecord! }
  type NgoRegistryConnection { edges: [NgoRegistryEdge!]! pageInfo: PageInfo! snapshot: NgoRegistrySnapshot! }
  extend type Query {
    ngoRegistryCoverage: NgoRegistrySnapshot!
    ngoRegistryRecords(filter: NgoRegistryFilter, first: Int = 20, after: String): NgoRegistryConnection!
    ngoRegistryRecord(id: ID!): NgoRegistryRecord
  }
`;
const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};
export const makeNgoRegistryResolvers = (repo: NgoRegistryRepository) => ({
  Query: {
    ngoRegistryCoverage: async () => unwrap(await getNgoRegistryCoverage(repo)),
    ngoRegistryRecord: async (_root: unknown, args: { id: string }) =>
      unwrap(await getNgoRegistryRecord(repo, args.id)),
    ngoRegistryRecords: async (
      _root: unknown,
      args: { filter?: FilterInput | null; first?: number | null; after?: string | null }
    ) => {
      const filter = normalizeNgoFilters(args.filter ?? {});
      const page = unwrap(
        await listNgoRegistry(repo, {
          filter,
          first: args.first ?? 20,
          ...(args.after == null ? {} : { after: args.after }),
        })
      );
      const fhash = registryFilterHash(page.snapshot.id, filter);
      const edges = page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: 'sourceRowNumber',
          dir: 'asc',
          fhash,
          lastKeys: [node.sourceRowNumber],
        }),
      }));
      return {
        edges,
        snapshot: page.snapshot,
        pageInfo: { hasNextPage: page.next !== null, endCursor: edges.at(-1)?.cursor ?? null },
      };
    },
  },
});
