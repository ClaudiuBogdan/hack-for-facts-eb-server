/**
 * Budget module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items,
 * summary?, ... }` object. Every aggregate carries the catalog Core Rule fields
 * (value/evidence/filters/coverage/caveats). The grain caveat (§14.6) rides in the
 * snapshot summary. PII-free (budget is public). Filters arrive as a plain JSON
 * object validated downstream by the kernel filter pipeline (the repo rejects bad
 * ops/values), with the §0.3 pruning triple enforced for fact tools.
 */

import { z } from 'zod';

import {
  ACCOUNT_CATEGORIES,
  BUDGET_GRAIN_NOTE,
  EXECUTION_REPORT_TYPES,
  type AccountCategory,
  type BudgetFrequency,
  type ExecutionReportType,
} from '../../core/constants.js';
import {
  BUDGET_RESOLVE_DIMS,
  type BudgetRankingMetric,
  type BudgetResolveDim,
} from '../../core/types.js';
import {
  aggregateByClassification,
  budgetTimeseries,
  getEntityBudget,
  getEntityCommitments,
  rankEntities,
  resolveBudgetFilter,
} from '../../core/usecases.js';

import type { BudgetDiscoveryRepo, BudgetRepo } from '../../core/ports.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface BudgetMcpDeps {
  readonly repo: BudgetRepo;
  readonly discovery: BudgetDiscoveryRepo;
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};

const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});

const n = (x: number): string => String(x);

/** Read a string arg, falling back to a default when absent/empty (lint-safe). */
const strOr = (args: Record<string, unknown>, key: string, dflt: string): string => {
  const v = strArg(args, key);
  return v === '' ? dflt : v;
};

/** Build a fact FilterInput from the pruning-triple + optional entity scope. */
const factFilter = (
  year: number,
  reportType: ExecutionReportType,
  accountCategory: AccountCategory,
  entityCui?: string
): FilterInput => ({
  reportingYear: { eq: year },
  reportType: { eq: reportType },
  accountCategory: { eq: accountCategory },
  frequency: { eq: 'YEAR' },
  ...(entityCui !== undefined && entityCui !== '' && { entityCuis: { in: [entityCui] } }),
});

export const makeBudgetMcpTools = (deps: BudgetMcpDeps): readonly KernelMcpTool[] => {
  const { repo, discovery, clientBaseUrl } = deps;
  const entityLink = (cui: string): string => `${clientBaseUrl}/buget/${cui}`;

  const resolveFilter: KernelMcpTool = {
    name: 'resolve_budget_filter',
    description:
      'Resolve a free-text budget query to a filter value: entity name → CUI, locality/county → SIRUTA, functional/economic label or code → classification code. MANDATORY first step before any name-based budget question (Entity Resolution Gate).',
    inputShape: {
      dim: z
        .enum(['entity', 'territory', 'functional', 'economic'])
        .describe('Which dimension to resolve.'),
      q: z.string().describe('The free-text query (name or code prefix).'),
      limit: z.number().int().min(1).max(25).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as BudgetResolveDim;
      if (!BUDGET_RESOLVE_DIMS.includes(dim)) return errorOut('resolution', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await resolveBudgetFilter(discovery, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolution', res.error.message);
      const caveats =
        (dim === 'functional' || dim === 'economic') && res.value.length === 0
          ? [
              'classification catalog is not loaded; resolve by code prefix or read names from aggregate results',
            ]
          : [];
      return {
        ok: true,
        kind: 'resolution',
        query: { dim, q },
        items: res.value,
        summary: `Found ${n(res.value.length)} match(es) for «${q}» as ${dim}.${caveats.length > 0 ? ` (${caveats[0] ?? ''})` : ''}`,
      };
    },
  };

  const entitySnapshot: KernelMcpTool = {
    name: 'get_budget_entity_snapshot',
    description:
      'Budget snapshot for an entity by CUI: execution income/expense/balance (MV) + commitment totals, for one year (defaults to latest complete year). Execution and commitment grains are reported SEPARATELY and never summed.',
    inputShape: {
      cui: z.string().describe('The entity CUI/CIF (digits only).'),
      year: z.number().int().optional().describe('Reporting year (default: latest complete year).'),
      reportType: z
        .enum(EXECUTION_REPORT_TYPES)
        .optional()
        .describe('Execution report type (default EXECUTION_DETAILED).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const yearArg = args['year'];
      const year = typeof yearArg === 'number' ? Math.floor(yearArg) : undefined;
      const reportType = strOr(args, 'reportType', 'EXECUTION_DETAILED') as ExecutionReportType;
      const summaryQ = {
        frequency: 'YEAR' as BudgetFrequency,
        reportType,
        ...(year !== undefined && { year }),
      };
      const [execRes, commitRes] = await Promise.all([
        getEntityBudget(repo, cui, summaryQ),
        getEntityCommitments(repo, cui, { frequency: 'YEAR', ...(year !== undefined && { year }) }),
      ]);
      if (execRes.isErr()) return errorOut('entity_snapshot', execRes.error.message);
      if (commitRes.isErr()) return errorOut('entity_snapshot', commitRes.error.message);
      const exec = execRes.value[0];
      const commit = commitRes.value[0];
      if (exec === undefined && commit === undefined) {
        return {
          ok: true,
          kind: 'entity_snapshot',
          query: { cui, year },
          summary: `No budget data for CUI ${cui}.`,
        };
      }
      const y = exec?.period.year ?? commit?.period.year ?? year ?? null;
      const summary =
        (exec !== undefined
          ? `${cui} (${exec.reportType}, ${n(exec.period.year)}): expense ${exec.totalExpense} RON, income ${exec.totalIncome} RON, balance ${exec.budgetBalance} RON.`
          : `${cui}: no execution summary.`) +
        (commit !== undefined
          ? ` Commitments: plati_trezor ${commit.platiTrezor ?? '0'} RON.`
          : '') +
        ` ${BUDGET_GRAIN_NOTE}`;
      return {
        ok: true,
        kind: 'entity_snapshot',
        query: { cui, year: y, reportType },
        link: entityLink(cui),
        item: { execution: exec ?? null, commitments: commit ?? null },
        summary,
      };
    },
  };

  const rankBudget: KernelMcpTool = {
    name: 'rank_budget_entities',
    description:
      'Rank entities by execution income/expense/balance for a year (MV path, normalization factors applied). Optionally restrict by county/region/UAT. Bounded top-N.',
    inputShape: {
      year: z.number().int().describe('Reporting year.'),
      reportType: z.enum(EXECUTION_REPORT_TYPES).optional().describe('Default EXECUTION_DETAILED.'),
      metric: z
        .enum(['INCOME', 'EXPENSE', 'BALANCE'])
        .optional()
        .describe('Ranking metric (default EXPENSE).'),
      normalization: z
        .enum(['TOTAL', 'TOTAL_EURO', 'PER_CAPITA', 'PER_CAPITA_EURO', 'PERCENT_GDP'])
        .optional(),
      countyCodes: z.array(z.string()).optional().describe('Restrict to these county codes.'),
      isUat: z.boolean().optional().describe('Restrict to UAT entities only.'),
      limit: z.number().int().min(1).max(100).optional().describe('Top-N (default 20).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const year = intArg(args, 'year', 0);
      if (year <= 0) return errorOut('ranking', 'year is required');
      const metric = strOr(args, 'metric', 'EXPENSE') as BudgetRankingMetric;
      const reportType = strOr(args, 'reportType', 'EXECUTION_DETAILED') as ExecutionReportType;
      const normalization = strOr(args, 'normalization', 'TOTAL') as
        | 'TOTAL'
        | 'TOTAL_EURO'
        | 'PER_CAPITA'
        | 'PER_CAPITA_EURO'
        | 'PERCENT_GDP';
      const countyCodes = Array.isArray(args['countyCodes'])
        ? (args['countyCodes'] as unknown[]).map(String)
        : undefined;
      const isUat = typeof args['isUat'] === 'boolean' ? args['isUat'] : undefined;
      const res = await rankEntities(repo, {
        year,
        reportType,
        metric,
        normalization,
        limit: intArg(args, 'limit', 20),
        ...(countyCodes !== undefined && { countyCodes }),
        ...(isUat !== undefined && { isUat }),
      });
      if (res.isErr()) return errorOut('ranking', res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: 'ranking',
        query: { year, reportType, metric, normalization },
        link: `${clientBaseUrl}/buget/clasament`,
        items: res.value,
        summary:
          `Top ${n(res.value.length)} entities by ${metric} (${normalization}), ${n(year)}, ${reportType}` +
          (top !== undefined
            ? `; #1 ${top.entityName ?? top.entityCui} = ${top.amount} RON.`
            : '.'),
      };
    },
  };

  const aggregate: KernelMcpTool = {
    name: 'aggregate_budget_by_classification',
    description:
      'Spend/income broken down by functional×economic classification for a year (fact path; pruned to one partition leaf). Requires year + reportType + accountCategory; optionally one entity.',
    inputShape: {
      year: z.number().int().describe('Reporting year.'),
      reportType: z.enum(EXECUTION_REPORT_TYPES).optional().describe('Default EXECUTION_DETAILED.'),
      accountCategory: z
        .enum(ACCOUNT_CATEGORIES)
        .optional()
        .describe('INCOME or EXPENSE (default EXPENSE).'),
      entityCui: z.string().optional().describe('Restrict to one entity CUI.'),
      minAmount: z
        .string()
        .optional()
        .describe('Only buckets whose summed amount ≥ this (decimal string).'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const year = intArg(args, 'year', 0);
      if (year <= 0) return errorOut('aggregate', 'year is required');
      const reportType = strOr(args, 'reportType', 'EXECUTION_DETAILED') as ExecutionReportType;
      const accountCategory = strOr(args, 'accountCategory', 'EXPENSE') as AccountCategory;
      const entityCui = strArg(args, 'entityCui');
      const minAmount = strArg(args, 'minAmount');
      const res = await aggregateByClassification(repo, {
        filter: factFilter(year, reportType, accountCategory, entityCui),
        normalization: 'TOTAL',
        limit: intArg(args, 'limit', 50),
        ...(minAmount !== '' && { minAmount }),
      });
      if (res.isErr()) return errorOut('aggregate', res.error.message);
      const top = res.value[0];
      const total = res.value.reduce((acc, r) => acc + Number(r.amount), 0);
      return {
        ok: true,
        kind: 'aggregate',
        query: {
          year,
          reportType,
          accountCategory,
          entityCui: entityCui !== '' ? entityCui : null,
        },
        link: `${clientBaseUrl}/buget/clasificatie`,
        items: res.value,
        summary:
          `${n(res.value.length)} classification bucket(s) for ${n(year)} ${accountCategory}` +
          (entityCui !== '' ? ` (entity ${entityCui})` : '') +
          (top !== undefined
            ? `; top ${top.functionalName ?? top.functionalCode} = ${top.amount} RON.`
            : '.'),
        // catalog Core Rule fields:
        ...{
          value: String(total),
          evidence: {
            entityCui: entityCui !== '' ? entityCui : null,
            year,
            reportType,
            accountCategory,
          },
          coverage: { buckets: res.value.length },
          caveats: [
            'fact path: one pruned partition leaf; amounts are nominal RON unless normalized',
          ],
        },
      };
    },
  };

  const timeseries: KernelMcpTool = {
    name: 'get_budget_timeseries',
    description:
      'Execution time series for one entity (MV path): income/expense/balance over years/months/quarters, with optional normalization (real EUR, per-capita, % GDP).',
    inputShape: {
      cui: z.string().describe('Entity CUI.'),
      reportType: z.enum(EXECUTION_REPORT_TYPES).optional(),
      metric: z.enum(['INCOME', 'EXPENSE', 'BALANCE']).optional().describe('Default EXPENSE.'),
      frequency: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional().describe('Default YEAR.'),
      normalization: z
        .enum(['TOTAL', 'TOTAL_EURO', 'PER_CAPITA', 'PER_CAPITA_EURO', 'PERCENT_GDP'])
        .optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const reportType = strOr(args, 'reportType', 'EXECUTION_DETAILED') as ExecutionReportType;
      const metric = strOr(args, 'metric', 'EXPENSE') as BudgetRankingMetric;
      const frequency = strOr(args, 'frequency', 'YEAR') as BudgetFrequency;
      const normalization = strOr(args, 'normalization', 'TOTAL') as
        | 'TOTAL'
        | 'TOTAL_EURO'
        | 'PER_CAPITA'
        | 'PER_CAPITA_EURO'
        | 'PERCENT_GDP';
      const res = await budgetTimeseries(repo, {
        entityCui: cui,
        reportType,
        metric,
        frequency,
        normalization,
      });
      if (res.isErr()) return errorOut('timeseries', res.error.message);
      const first = res.value[0];
      const last = res.value[res.value.length - 1];
      return {
        ok: true,
        kind: 'timeseries',
        query: { cui, reportType, metric, frequency, normalization },
        link: entityLink(cui),
        items: res.value,
        summary:
          `${n(res.value.length)} point(s) of ${metric} (${normalization}) for ${cui}` +
          (first !== undefined && last !== undefined
            ? `; ${first.periodLabel}=${first.amount} … ${last.periodLabel}=${last.amount}.`
            : '.'),
      };
    },
  };

  return [resolveFilter, entitySnapshot, rankBudget, aggregate, timeseries];
};
