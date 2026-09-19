import { Value } from '@sinclair/typebox/value';
import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  toTypeBox,
  type ApiError,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { ngoRegistryFilterSpec } from '../../core/filters.js';
import {
  getNgoRegistryCoverage,
  getNgoRegistryRecord,
  listNgoRegistry,
} from '../../core/usecases.js';

import type { NgoRegistryRepository } from '../../core/ports.js';

const failure = (error: ApiError): McpToolOutput => ({
  ok: false,
  kind: 'ngo_registry',
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});
const filterSchema = toTypeBox(ngoRegistryFilterSpec);
export const makeNgoRegistryMcpTools = (
  repo: NgoRegistryRepository,
  clientBaseUrl: string
): readonly KernelMcpTool[] => [
  {
    name: 'get_ngo_registry_coverage',
    description:
      'RNONG supplied-artifact scope, observation count and import date. National completeness is unverified; count is registry records, not deduplicated organizations.',
    inputShape: {},
    async handler() {
      const result = await getNgoRegistryCoverage(repo);
      return result.isErr()
        ? failure(result.error)
        : {
            ok: true,
            kind: 'ngo_registry_coverage',
            item: result.value,
            link: `${clientBaseUrl}/ong-uri/registru`,
          };
    },
  },
  {
    name: 'list_ngo_registry_records',
    description:
      'Browse RNONG registry observations, including rows without CUI. Snapshot-bound pagination. Filters: name.contains, registryNumber.eq, county.eq, category.eq, status.eq, publicUtility.eq. Source assertions are not independently verified current legal status.',
    inputShape: {
      filter: z.record(z.string(), z.unknown()).optional(),
      first: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    },
    async handler(args) {
      const filter = args['filter'] ?? {};
      if (!Value.Check(filterSchema, filter))
        return failure({ type: 'InvalidInput', message: 'Invalid NGO registry filter.' });
      const first = typeof args['first'] === 'number' ? args['first'] : 20;
      const after = args['after'];
      const result = await listNgoRegistry(repo, {
        filter: filter as FilterInput,
        first,
        ...(typeof after === 'string' ? { after } : {}),
      });
      return result.isErr()
        ? failure(result.error)
        : {
            ok: true,
            kind: 'ngo_registry_records',
            items: result.value.items,
            meta: { snapshot: result.value.snapshot, next: result.value.next },
            link: `${clientBaseUrl}/ong-uri/registru`,
          };
    },
  },
  {
    name: 'get_ngo_registry_record',
    description:
      'Read a snapshot observation by its id. Historical observations remain labeled with isCurrent=false; ids are not durable NGO identities. No purpose text or private payload is exposed.',
    inputShape: { id: z.string().min(1).max(200) },
    async handler(args) {
      const id = typeof args['id'] === 'string' ? args['id'] : '';
      const result = await getNgoRegistryRecord(repo, id);
      return result.isErr()
        ? failure(result.error)
        : {
            ok: true,
            kind: 'ngo_registry_record',
            item: result.value,
            link: `${clientBaseUrl}/ong-uri/registru/${encodeURIComponent(id)}`,
          };
    },
  },
];
