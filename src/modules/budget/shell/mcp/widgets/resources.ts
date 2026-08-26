/**
 * Budget module MCP App widget resources (SEP-1865) — generated bundles from
 * `widgets/src/budget-*` (rebuild: `pnpm widgets:build`). Contributed to the
 * kernel MCP server via `makeBudgetModule().mcpResources`.
 */

import { budgetBreakdownWidgetHtml, budgetBreakdownWidgetUri } from './budget-breakdown.gen.js';
import { budgetRankingWidgetHtml, budgetRankingWidgetUri } from './budget-ranking.gen.js';
import { budgetTimeseriesWidgetHtml, budgetTimeseriesWidgetUri } from './budget-timeseries.gen.js';

import type { KernelMcpResource } from '@/modules/shared/index.js';

export const BUDGET_RANKING_WIDGET_URI = budgetRankingWidgetUri;
export const BUDGET_TIMESERIES_WIDGET_URI = budgetTimeseriesWidgetUri;
export const BUDGET_BREAKDOWN_WIDGET_URI = budgetBreakdownWidgetUri;

/** Widgets draw their own 2px card border — no host frame on top. */
const WIDGET_UI_META = { ui: { prefersBorder: false } } as const;

export const makeBudgetMcpResources = (): readonly KernelMcpResource[] => [
  {
    name: 'budget-ranking-widget',
    uri: BUDGET_RANKING_WIDGET_URI,
    title: 'Clasament bugetar — Transparenta.eu',
    description: 'Top-N table for the rank_budget_entities tool.',
    meta: WIDGET_UI_META,
    text: budgetRankingWidgetHtml,
  },
  {
    name: 'budget-timeseries-widget',
    uri: BUDGET_TIMESERIES_WIDGET_URI,
    title: 'Evoluție bugetară — Transparenta.eu',
    description: 'Line chart for the get_budget_timeseries tool.',
    meta: WIDGET_UI_META,
    text: budgetTimeseriesWidgetHtml,
  },
  {
    name: 'budget-breakdown-widget',
    uri: BUDGET_BREAKDOWN_WIDGET_URI,
    title: 'Structură pe clasificații — Transparenta.eu',
    description: 'Horizontal bars for the aggregate_budget_by_classification tool.',
    meta: WIDGET_UI_META,
    text: budgetBreakdownWidgetHtml,
  },
];
