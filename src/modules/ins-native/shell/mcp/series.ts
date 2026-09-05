/** Source inspection with exact pins and publication-pinned continuation. */
import { z } from 'zod';

import { isSourceMemberId, observationViewRef } from '../../core/identity.js';
import { readInsSourcePage } from '../../core/source-page.js';
import {
  INS_PERIODICITIES,
  INS_TERRITORY_LEVELS,
  MAX_OBSERVATION_LIMIT,
  MAX_SLOTS,
  type InsObservationFilter,
  type InsPeriodicity,
  type InsTerritoryLevel,
} from '../../core/types.js';

import type { InsRepo } from '../../core/ports.js';
import type { ApiError, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z
  .object({
    datasetCode: z.string().trim().min(1).describe('INS matrix code, e.g. POP107D.'),
    territoryCodes: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Canonical territory codes; intersect exact source geography.'),
    territoryLevels: z
      .array(z.enum(INS_TERRITORY_LEVELS as [InsTerritoryLevel, ...InsTerritoryLevel[]]))
      .min(1)
      .optional(),
    sourcePins: z
      .array(
        z
          .object({
            dimensionIndex: z
              .number()
              .int()
              .min(0)
              .max(MAX_SLOTS - 1),
            memberCode: z
              .string()
              .max(11)
              .regex(/^(0|-?[1-9][0-9]{0,9})$/u)
              .refine((value) => isSourceMemberId(Number(value))),
          })
          .strict()
      )
      .max(MAX_SLOTS)
      .optional()
      .describe(
        'Exact dataset-scoped dimension/member pairs. Exclusive with either legacy classification list. Pin every geographic axis when canonical geography is omitted.'
      ),
    classificationValueCodes: z
      .array(z.string())
      .optional()
      .describe('Legacy member list or TOTAL. Defaults to TOTAL only without sourcePins.'),
    classificationTypeCodes: z
      .array(z.string())
      .optional()
      .describe('Legacy dimension list; must not be combined with sourcePins.'),
    unitCodes: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Source unit member codes, including zero.'),
    periodicity: z.enum(INS_PERIODICITIES as [InsPeriodicity, ...InsPeriodicity[]]).optional(),
    periodStart: z
      .string()
      .optional()
      .describe('YYYY, YYYY-QN or YYYY-MM lower bound (inclusive).'),
    periodEnd: z.string().optional().describe('YYYY, YYYY-QN or YYYY-MM upper bound (inclusive).'),
    hasValue: z
      .boolean()
      .optional()
      .describe(
        'Omit to preserve all source cells; true selects numeric values, false selects null values only.'
      ),
    limit: z.number().int().min(1).max(MAX_OBSERVATION_LIMIT).default(200),
    // Wire integer bound, not a latency guarantee. PostgreSQL statement deadlines still apply.
    offset: z.number().int().min(0).max(2147483647).default(0),
    expectedPublication: z
      .object({
        revisionId: z.string().regex(/^[1-9][0-9]{0,18}$/u),
        custodySha256: hash,
        transformContractSha256: hash,
      })
      .strict()
      .optional()
      .describe(
        'Copy meta.publication from page one. Required for offset > 0; a changed publication requires restarting from zero.'
      ),
  })
  .strict();
const failure = (error: ApiError): McpToolOutput => ({
  ok: false,
  kind: 'ins_series',
  error: error.message,
  errorType: error.type,
});

export const makeInsSeriesTool = (deps: {
  readonly repo: InsRepo;
  readonly datasetLink: (code: string) => string;
}): KernelMcpTool => ({
  name: 'get_ins_series',
  description:
    'Inspect original INS observations, newest first. Exact sourcePins preserve dimension/member pairing; canonical territory filters intersect source geography. Legacy inputs default other classifications to TOTAL. Alternatives, nulls and geographic qualifications remain separate rows, not one derived series. Repeat the same filters and meta.publication with nextOffset to continue. Unknown datasets retain empty results with a null descriptor; not-loaded datasets retain metadata without publication tokens.',
  inputShape: inputSchema.shape,
  strictInput: true,
  async handler(args) {
    const parsed = inputSchema.safeParse(args);
    if (!parsed.success) return failure({ type: 'InvalidInput', message: parsed.error.message });
    const input = parsed.data;
    const valueCodes =
      input.classificationValueCodes ?? (input.sourcePins === undefined ? ['TOTAL'] : undefined);
    const filter: InsObservationFilter = {
      ...(input.territoryCodes !== undefined && { territoryCodes: input.territoryCodes }),
      ...(input.territoryLevels !== undefined && { territoryLevels: input.territoryLevels }),
      ...(input.sourcePins !== undefined && { sourcePins: input.sourcePins }),
      ...(valueCodes !== undefined && { classificationValueCodes: valueCodes }),
      ...(input.classificationTypeCodes !== undefined && {
        classificationTypeCodes: input.classificationTypeCodes,
      }),
      ...(input.unitCodes !== undefined && { unitCodes: input.unitCodes }),
      ...(input.hasValue !== undefined && { hasValue: input.hasValue }),
      period: {
        ...(input.periodicity !== undefined && { periodicity: input.periodicity }),
        ...(input.periodStart !== undefined && { start: input.periodStart }),
        ...(input.periodEnd !== undefined && { end: input.periodEnd }),
      },
    };
    const result = await readInsSourcePage(deps.repo, {
      datasetCode: input.datasetCode,
      filter,
      limit: input.limit,
      offset: input.offset,
      ...(input.expectedPublication !== undefined && {
        expectedPublication: input.expectedPublication,
      }),
    });
    if (result.isErr()) return failure(result.error);
    const value = result.value;
    if (value.kind === 'publicationChanged')
      return {
        ok: false,
        kind: 'ins_series',
        errorType: 'ServiceUnavailable',
        error: 'INS publication changed; restart the selection from offset zero',
        meta: { reason: 'PUBLICATION_CHANGED', currentPublication: value.currentPublication },
      };
    const { dataset, dimensions, publication, page } = value;
    return {
      ok: true,
      kind: 'ins_series',
      query: {
        ...input,
        territoryCodes: input.territoryCodes ?? [],
        classificationValueCodes: valueCodes,
      },
      link: deps.datasetLink(input.datasetCode.toUpperCase()),
      items: page.nodes.map((row) => ({
        id: observationViewRef(row),
        datasetCode: row.coordinate.datasetCode,
        period: row.period.labelRo,
        periodStart: row.period.periodStart,
        periodEnd: row.period.periodEnd,
        periodicity: row.period.periodicity,
        territory:
          row.territory === null
            ? null
            : {
                code: row.territory.code,
                level: row.territory.level,
                nameRo: row.territory.nameRo,
              },
        value: row.value,
        valueStatus: row.valueStatus,
        unit: {
          code: String(row.unit.nomItemId),
          label: row.unit.labelRo,
          baseUnit: row.unit.baseUnit,
          scaleFactor: row.unit.scaleFactor,
        },
        currency: row.currencyCode,
        geography: row.geography,
        members: row.members.map((member) => ({
          dimension: `D${String(member.dimIndex)}`,
          code: String(member.nomItemId),
          label: member.labelRo,
        })),
      })),
      meta: {
        descriptor: dataset === null ? null : { ...dataset, dimensions },
        publication,
        returned: page.nodes.length,
        hasMore: page.hasNextPage,
        offset: input.offset,
        limit: input.limit,
        totalCount: page.totalCount,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        nextOffset: page.hasNextPage ? input.offset + page.nodes.length : null,
      },
    };
  },
});
