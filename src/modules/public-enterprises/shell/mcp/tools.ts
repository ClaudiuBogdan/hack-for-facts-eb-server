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

import {
  publicEnterpriseIndicatorFilterSpec,
  publicEnterpriseListFilterSpec,
} from '../../core/filters.js';
import {
  getPublicEnterpriseProfile,
  listPublicEnterpriseIndicators,
  searchPublicEnterprises,
  type PublicEnterpriseDeps,
} from '../../core/usecases.js';

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});
const listFilterSchema = toTypeBox(publicEnterpriseListFilterSpec);
const indicatorFilterSchema = toTypeBox(publicEnterpriseIndicatorFilterSpec);

/**
 * No `link` yet: the client has no public-enterprise route. Source names and
 * statuses are as reported; organization is null when the identity is withheld.
 */
export const makePublicEnterpriseMcpTools = (
  deps: PublicEnterpriseDeps
): readonly KernelMcpTool[] => [
  {
    name: 'search_public_enterprises',
    description:
      'Find Romanian public enterprises (AMEPIP / S1001 registries). q is a CUI or a name resolved through the shared identity index and intersected with the public anchors. Filters: cuis.in, families.in, currentOnly.eq (default true; false adds historical anchors), authorityCuis.in, authorityLevels.in. CUI order, pageSize up to 100.',
    inputShape: {
      q: z.string().min(1).max(100).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    },
    async handler(args) {
      const kind = 'public_enterprises';
      const filter = args['filter'] ?? {};
      if (!Value.Check(listFilterSchema, filter))
        return failure(kind, {
          type: 'InvalidInput',
          message: 'Invalid public-enterprise filter.',
        });
      const q = typeof args['q'] === 'string' ? args['q'] : undefined;
      const page = typeof args['page'] === 'number' ? args['page'] : 1;
      const pageSize = typeof args['pageSize'] === 'number' ? args['pageSize'] : 20;
      const result = await searchPublicEnterprises(deps, {
        filter: filter as FilterInput,
        page,
        pageSize,
        ...(q === undefined ? {} : { q }),
      });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total } = result.value;
      return {
        ok: true,
        kind,
        query: { q: q ?? null, filter, page, pageSize },
        items,
        meta: { page, pageSize, total },
        summary: `${String(total)} public enterprise(s) match; page ${String(page)} shows ${String(items.length)}.`,
      };
    },
  },
  {
    name: 'get_public_enterprise_profile',
    description:
      'One public enterprise by CUI: current membership, current registry observations and control edges as reported by AMEPIP / S1001 / JSON-APT, and source-lane availability. Null when the CUI is not a public anchor. Indicators: list_public_enterprise_indicators. Financials: the companies tools.',
    inputShape: { cui: z.string().min(1).max(20) },
    async handler(args) {
      const kind = 'public_enterprise_profile';
      const cui = typeof args['cui'] === 'string' ? args['cui'] : '';
      const result = await getPublicEnterpriseProfile(deps, cui);
      if (result.isErr()) return failure(kind, result.error);
      const profile = result.value;
      return {
        ok: true,
        kind,
        query: { cui },
        item: profile,
        summary:
          profile === null
            ? `${cui} is not a public enterprise anchor.`
            : `${cui} is ${profile.isCurrentMember ? 'a current' : 'a historical'} public enterprise (${String(profile.registryObservations.length)} current observation(s), ${String(profile.authorityEdges.length)} control edge(s)).`,
      };
    },
  },
  {
    name: 'list_public_enterprise_indicators',
    description:
      'AMEPIP indicator cells of one public enterprise from the current AMEPIP snapshot, ordered by year, sheet, version, indicator. Filters: years.in, kpiCodes.in, sourceSheets.in. numericValue is exact decimal text; rawValue is the original cell. Cursor pages (first up to 100); a cursor fails after the filter or the AMEPIP snapshot changes.',
    inputShape: {
      cui: z.string().min(1).max(20),
      filter: z.record(z.string(), z.unknown()).optional(),
      first: z.number().int().min(1).max(100).optional(),
      after: z.string().optional(),
    },
    async handler(args) {
      const kind = 'public_enterprise_indicators';
      const filter = args['filter'] ?? {};
      if (!Value.Check(indicatorFilterSchema, filter))
        return failure(kind, { type: 'InvalidInput', message: 'Invalid indicator filter.' });
      const cui = typeof args['cui'] === 'string' ? args['cui'] : '';
      const first = typeof args['first'] === 'number' ? args['first'] : 100;
      const after = args['after'];
      const result = await listPublicEnterpriseIndicators(deps, {
        cui,
        filter: filter as FilterInput,
        first,
        ...(typeof after === 'string' ? { after } : {}),
      });
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: { cui, filter, first },
        items: result.value.items,
        meta: { next: result.value.next, snapshotId: result.value.snapshotId },
        summary: `${String(result.value.items.length)} indicator cell(s)${result.value.next === null ? '' : '; more pages follow'}.`,
      };
    },
  },
];
