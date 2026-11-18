/**
 * Direct acquisitions, release 1 — MCP tools. Registered only when the release
 * is enabled; same usecases (and so the same D6 rule) as GraphQL and REST.
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  daPurchaseTotals,
  getDaPurchase,
  listDaPurchases,
  type DaReleaseDeps,
} from '../../core/da-release-usecases.js';
import { DA_LIST_SORTS, DA_OUTCOMES, DA_TOTALS_GROUPS } from '../../core/da-release.js';

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});

const VALUE_NOTE =
  'Money is decimal text. countedValue (and a correction) is in lei excluding VAT; reportedValue and line values are as the portal published them, with a currency and VAT basis confirmed only for counted purchases, and are never summed. Only countedValue is summable (null when not counted, with notCountedReason). When valueCorrected, countedValue is an approved correction and reviewRule gives the rule and its public sentence. Suppliers that are not companies with a valid fiscal code are served as natural_person with no name or code; never try to recover one. Title, description and line names are null with a "privacy" marker until reviewed; use categoryLabel as the name.';

const filterShape = {
  buyerFiscalCode: z
    .string()
    .regex(/^[0-9]{1,10}$/u)
    .optional(),
  supplierFiscalCode: z
    .string()
    .regex(/^[0-9]{1,10}$/u)
    .optional(),
  cpvDivision: z
    .string()
    .regex(/^[0-9]{2}$/u)
    .optional(),
  finalizationFrom: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
    .optional(),
  finalizationTo: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
    .optional(),
  outcomes: z.array(z.enum(DA_OUTCOMES)).min(1).max(DA_OUTCOMES.length).optional(),
  counted: z.boolean().optional(),
  code: z.string().min(1).max(40).optional(),
  nativeId: z.string().min(1).max(40).optional(),
};
const FILTER_KEYS = Object.keys(filterShape);

const pageShape = {
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
};

/** The filter echoed back in `query`: a supplier fiscal code is never repeated in a response. */
const echoOf = (filter: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(filter).filter(([key]) => key !== 'supplierFiscalCode'));

const filterOf = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    FILTER_KEYS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]])
  );

const pageOf = (args: Record<string, unknown>) => ({
  page: typeof args['page'] === 'number' ? args['page'] : 1,
  pageSize: typeof args['pageSize'] === 'number' ? args['pageSize'] : 20,
});

export const makeDaReleaseMcpTools = (deps: DaReleaseDeps): readonly KernelMcpTool[] => [
  {
    name: 'list_procurement_da_purchases',
    description: `Romanian direct acquisitions (achiziții directe, release 1), newest finalization first, filtered by buyer or supplier fiscal code, CPV division (2 digits), finalization-day range, outcome, counted, or the portal code (e.g. DA37709621). ${VALUE_NOTE} Pages reach row 10000 at most; pageSize up to 100.`,
    strictInput: true,
    inputShape: { ...filterShape, sort: z.enum(DA_LIST_SORTS).optional(), ...pageShape },
    async handler(args) {
      const kind = 'procurement_da_purchases';
      const filter = filterOf(args);
      const query = { filter: echoOf(filter), ...pageOf(args) };
      const sort = typeof args['sort'] === 'string' ? args['sort'] : null;
      const result = await listDaPurchases(deps, { filter, sort, ...pageOf(args) });
      if (result.isErr()) return failure(kind, result.error);
      const { items, total, totalCapped, hasMore, dataAsOf, countedValueBasis } = result.value;
      return {
        ok: true,
        kind,
        query,
        items,
        meta: { ...pageOf(args), total, totalCapped, hasMore, dataAsOf, countedValueBasis },
        summary: `${totalCapped ? 'More than ' : ''}${String(total)} direct acquisition(s); page ${String(query.page)} shows ${String(items.length)}. Data as of ${dataAsOf}.`,
      };
    },
  },
  {
    name: 'get_procurement_da_purchase',
    description: `One direct acquisition (release 1) by purchaseId (64 hex), with its item lines (values as reported, never summed). ${VALUE_NOTE}`,
    strictInput: true,
    inputShape: { purchaseId: z.string().regex(/^[0-9a-f]{64}$/u) },
    async handler(args) {
      const kind = 'procurement_da_purchase';
      const purchaseId = typeof args['purchaseId'] === 'string' ? args['purchaseId'] : '';
      const result = await getDaPurchase(deps, purchaseId);
      if (result.isErr()) return failure(kind, result.error);
      return {
        ok: true,
        kind,
        query: { purchaseId },
        item: result.value,
        summary: `Direct acquisition ${result.value.purchase.code ?? purchaseId}: reported ${result.value.purchase.reportedValue ?? 'no value'}, ${result.value.purchase.counted ? `counted ${result.value.purchase.countedValue ?? ''}` : 'not counted'}. Data as of ${result.value.dataAsOf}.`,
      };
    },
  },
  {
    name: 'aggregate_procurement_da_totals',
    description: `Totals of direct acquisitions (release 1) for a filtered scope: the sum of counted values (lei excluding VAT), the counted and symbolic-price counts, and all purchases in scope; optionally grouped by buyer, supplier, cpvDivision, month or year (of finalization). Totals cover direct acquisitions only and are never added to other procurement families. Every withheld (natural_person) supplier is one group with no name. ${VALUE_NOTE}`,
    strictInput: true,
    inputShape: { ...filterShape, groupBy: z.enum(DA_TOTALS_GROUPS).optional(), ...pageShape },
    async handler(args) {
      const kind = 'procurement_da_totals';
      const groupBy = typeof args['groupBy'] === 'string' ? args['groupBy'] : null;
      const filter = filterOf(args);
      const query = { filter: echoOf(filter), groupBy, ...pageOf(args) };
      const result = await daPurchaseTotals(deps, { filter, groupBy, ...pageOf(args) });
      if (result.isErr()) return failure(kind, result.error);
      const answer = result.value;
      return {
        ok: true,
        kind,
        query,
        item: answer,
        summary: `Counted ${answer.overall.countedValue ?? '0'} ${answer.countedValueBasis} over ${answer.overall.countedCount} of ${answer.overall.purchaseCount} purchase(s)${groupBy === null ? '' : `; ${String(answer.groupCount)} ${groupBy} group(s)`}. Data as of ${answer.dataAsOf}.`,
      };
    },
  },
];
