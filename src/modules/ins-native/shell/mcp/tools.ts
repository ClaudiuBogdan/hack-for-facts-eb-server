/**
 * INS native module — MCP tools. Each tool calls the SAME usecase the GraphQL
 * resolver calls and returns the kernel `{ ok, kind, query?, link?, item|items,
 * meta?, summary? }` object. Naming `<verb>_ins_<noun>`.
 */

import { z } from 'zod';

import { INS_TERRITORY_LEVELS, type InsTerritoryLevel } from '../../core/types.js';
import {
  listDatasets,
  listLatestValues,
  listObservations,
  listTerritories,
} from '../../core/usecases.js';

import type { InsRepo } from '../../core/ports.js';
import type { ApiError, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface InsMcpDeps {
  readonly repo: InsRepo;
  readonly clientBaseUrl: string;
}

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
});

const levelSchema = z.enum(INS_TERRITORY_LEVELS as [InsTerritoryLevel, ...InsTerritoryLevel[]]);

export const makeInsMcpTools = (deps: InsMcpDeps): readonly KernelMcpTool[] => {
  const { repo, clientBaseUrl } = deps;
  const datasetLink = (code: string): string => `${clientBaseUrl}/statistici/seturi/${code}`;
  const territoryLink = (siruta: string): string =>
    `${clientBaseUrl}/statistici/teritorii/${siruta}`;

  const searchDatasets: KernelMcpTool = {
    name: 'search_ins_datasets',
    description:
      'Search the INS TEMPO statistical datasets served by the platform (1,916 matrices) by free text; returns codes, names, periodicities, observed year range and the territory grains available (LAU/county/region/national).',
    inputShape: {
      q: z
        .string()
        .optional()
        .describe('Free text (diacritic-insensitive) over the dataset name and code.'),
      hasUatData: z.boolean().optional().describe('Only datasets with locality (UAT) rows.'),
      hasCountyData: z.boolean().optional().describe('Only datasets with county rows.'),
      includeCatalogOnly: z
        .boolean()
        .optional()
        .describe('Include datasets with no served observations.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max datasets (default 20).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const q = typeof args['q'] === 'string' ? args['q'] : undefined;
      const res = await listDatasets(
        repo,
        {
          ...(q !== undefined && { search: q }),
          ...(args['hasUatData'] === true && { hasUatData: true }),
          ...(args['hasCountyData'] === true && { hasCountyData: true }),
          ...(args['includeCatalogOnly'] === true && { dataStatus: [] }),
        },
        typeof args['limit'] === 'number' ? args['limit'] : 20,
        0
      );
      if (res.isErr()) return failure('ins_datasets', res.error);
      return {
        ok: true,
        kind: 'ins_datasets',
        query: { q, limit: args['limit'] },
        items: res.value.nodes.map((d) => ({
          code: d.code,
          nameRo: d.nameRo,
          nameEn: d.nameEn,
          periodicities: d.periodicities,
          yearRange: d.yearRange,
          hasLau: d.hasLau,
          hasCounty: d.hasCounty,
          hasRegion: d.hasRegion,
          dataStatus: d.dataStatus,
          contextPath: d.contextPath,
          link: datasetLink(d.code),
        })),
        meta: { totalCount: res.value.totalCount, returned: res.value.nodes.length },
        summary: `${String(res.value.totalCount ?? res.value.nodes.length)} INS datasets match.`,
      };
    },
  };

  const resolveTerritory: KernelMcpTool = {
    name: 'resolve_ins_territory',
    description:
      'Resolve a locality / county / region name to INS territory codes (LAU code = SIRUTA, county letter, NUTS code, RO) usable in get_ins_series and get_ins_territory_snapshot.',
    inputShape: {
      q: z.string().describe('Territory name (diacritic-insensitive substring).'),
      levels: z
        .array(levelSchema)
        .optional()
        .describe('Restrict to levels (NATIONAL, NUTS1, NUTS2, NUTS3, LAU).'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const q = typeof args['q'] === 'string' ? args['q'] : '';
      const levels = Array.isArray(args['levels'])
        ? (args['levels'] as InsTerritoryLevel[])
        : undefined;
      const res = await listTerritories(
        repo,
        { search: q, ...(levels !== undefined && { levels }) },
        typeof args['limit'] === 'number' ? args['limit'] : 10,
        0
      );
      if (res.isErr()) return failure('ins_territories', res.error);
      return {
        ok: true,
        kind: 'ins_territories',
        query: { q, levels },
        items: res.value.nodes.map((n) => ({
          code: n.code,
          sirutaCode: n.sirutaCode,
          level: n.level,
          nameRo: n.nameRo,
          parentCode: n.parentCode,
          parentNameRo: n.parentNameRo,
          ...(n.sirutaCode !== null && { link: territoryLink(n.sirutaCode) }),
        })),
        meta: { totalCount: res.value.totalCount },
      };
    },
  };

  const getSeries: KernelMcpTool = {
    name: 'get_ins_series',
    description:
      'Observations of one INS dataset for one or more territories (codes from resolve_ins_territory), pinned to the TOTAL of every other classification unless member codes are given; newest first.',
    inputShape: {
      datasetCode: z.string().describe('INS matrix code, e.g. POP107D.'),
      territoryCodes: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          'Territory codes (SIRUTA, county letter, NUTS, RO). Omit only for non-geographic data or explicit pins on every geographic dimension.'
        ),
      classificationValueCodes: z
        .array(z.string())
        .optional()
        .describe('Member codes (nomItemId) or TOTAL; default TOTAL on every classification.'),
      classificationTypeCodes: z
        .array(z.string())
        .optional()
        .describe('Dimension codes D<n> the value codes apply to.'),
      periodStart: z.string().optional().describe('YYYY, YYYY-QN or YYYY-MM (inclusive).'),
      periodEnd: z.string().optional().describe('YYYY, YYYY-QN or YYYY-MM (inclusive).'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max rows (default 200).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const datasetCode = typeof args['datasetCode'] === 'string' ? args['datasetCode'] : '';
      const territoryCodes = Array.isArray(args['territoryCodes'])
        ? (args['territoryCodes'] as string[])
        : [];
      const valueCodes = Array.isArray(args['classificationValueCodes'])
        ? (args['classificationValueCodes'] as string[])
        : ['TOTAL'];
      const typeCodes = Array.isArray(args['classificationTypeCodes'])
        ? (args['classificationTypeCodes'] as string[])
        : undefined;
      const start = typeof args['periodStart'] === 'string' ? args['periodStart'] : undefined;
      const end = typeof args['periodEnd'] === 'string' ? args['periodEnd'] : undefined;
      const res = await listObservations(
        repo,
        datasetCode,
        {
          territoryCodes,
          classificationValueCodes: valueCodes,
          ...(typeCodes !== undefined && { classificationTypeCodes: typeCodes }),
          ...((start !== undefined || end !== undefined) && {
            period: { ...(start !== undefined && { start }), ...(end !== undefined && { end }) },
          }),
        },
        typeof args['limit'] === 'number' ? args['limit'] : 200,
        0
      );
      if (res.isErr()) return failure('ins_series', res.error);
      return {
        ok: true,
        kind: 'ins_series',
        query: {
          datasetCode,
          territoryCodes,
          classificationValueCodes: valueCodes,
          periodStart: start,
          periodEnd: end,
        },
        link: datasetLink(datasetCode.toUpperCase()),
        items: res.value.nodes.map((o) => ({
          period: o.period.labelRo,
          periodStart: o.period.periodStart,
          periodEnd: o.period.periodEnd,
          periodicity: o.period.periodicity,
          territory:
            o.territory === null
              ? null
              : { code: o.territory.code, level: o.territory.level, nameRo: o.territory.nameRo },
          value: o.value,
          valueStatus: o.valueStatus,
          unit: {
            code: String(o.unit.nomItemId),
            label: o.unit.labelRo,
            baseUnit: o.unit.baseUnit,
            scaleFactor: o.unit.scaleFactor,
          },
          currency: o.currencyCode,
          geography: o.geography,
          members: o.members.map((m) => ({
            dimension: `D${String(m.dimIndex)}`,
            code: String(m.nomItemId),
            label: m.labelRo,
          })),
        })),
        meta: { returned: res.value.nodes.length, hasMore: res.value.hasNextPage },
      };
    },
  };

  const snapshot: KernelMcpTool = {
    name: 'get_ins_territory_snapshot',
    description:
      'Latest default-series value of several INS datasets for one territory (SIRUTA for a locality, county letter with level NUTS3, RO for national). Datasets without a complete default pin answer NO_DATA rather than an arbitrary row.',
    inputShape: {
      datasetCodes: z.array(z.string()).min(1).max(100),
      sirutaCode: z.string().optional(),
      territoryCode: z.string().optional(),
      territoryLevel: levelSchema.optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const codes = Array.isArray(args['datasetCodes']) ? (args['datasetCodes'] as string[]) : [];
      const siruta = typeof args['sirutaCode'] === 'string' ? args['sirutaCode'] : undefined;
      const tcode = typeof args['territoryCode'] === 'string' ? args['territoryCode'] : undefined;
      const level =
        typeof args['territoryLevel'] === 'string'
          ? (args['territoryLevel'] as InsTerritoryLevel)
          : undefined;
      const res = await listLatestValues(
        repo,
        {
          ...(siruta !== undefined && { sirutaCode: siruta }),
          ...(tcode !== undefined && { territoryCode: tcode }),
          ...(level !== undefined && { territoryLevel: level }),
        },
        codes,
        ['TOTAL']
      );
      if (res.isErr()) return failure('ins_snapshot', res.error);
      return {
        ok: true,
        kind: 'ins_snapshot',
        query: {
          datasetCodes: codes,
          sirutaCode: siruta,
          territoryCode: tcode,
          territoryLevel: level,
        },
        ...(siruta !== undefined && { link: territoryLink(siruta) }),
        items: res.value.map((v) => ({
          datasetCode: v.dataset.code,
          nameRo: v.dataset.nameRo,
          matchStrategy: v.matchStrategy,
          geography: v.observation?.geography ?? null,
          period: v.observation?.period.labelRo ?? null,
          value: v.observation?.value ?? null,
          valueStatus: v.observation?.valueStatus ?? null,
          unit: v.observation?.unit.labelRo ?? null,
          link: datasetLink(v.dataset.code),
        })),
        meta: {
          requested: codes.length,
          withData: res.value.filter((v) => v.observation !== null).length,
        },
      };
    },
  };

  return [searchDatasets, resolveTerritory, getSeries, snapshot];
};
