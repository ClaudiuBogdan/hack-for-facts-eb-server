/**
 * Contract awards (PROC-KB0Z step 1): MCP tools. Registered only when
 * PROCUREMENT_CA_RECORDS_ENABLED is on; the same usecases (and so the same
 * window, buyer and winner rules) as GraphQL and REST.
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type ApiError,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import {
  caBuyerSummary,
  caWinnerSummary,
  getCaRecord,
  listCaBuyerRecords,
  listCaWinnerRecords,
  type CaRecordPage,
  type CaRecordsDeps,
} from '../../core/ca-records-usecases.js';
import { CA_LIST_SORTS, CA_MAX_PAGE_SIZE } from '../../core/ca-records.js';

const failure = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind,
  error: error.message,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
});

const RULES_NOTE =
  'Contract awards (contracte atribuite) from e-licitatie, award days from the published floor (window.floor in each summary and list; earlier records are not published); a record with no award day is counted apart (undatedCount) and in no dated list. Counts only: there is no lei total here (use aggregate_procurement_totals). Money is decimal text in lei; changeLei is the latest observed price change and is never added to amountLei; a record under identity review is shown but not additive. A buyer that is a person is shown with a masked name only (person_masked); never look its name up by code elsewhere. A winner shows a code only when the supplier names view shows it (company with its registry name, person_masked with a masked name, or code_only); withheld and unidentified winners carry no code or name, and must never be recovered. recordId is build-scoped. Never keep winner codes or names beyond the answer that carried them.';

const CODE = z.string().regex(/^[1-9][0-9]{1,9}$/u);
const DAY = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u);

const windowShape = { from: DAY.optional(), to: DAY.optional() };
const pageShape = {
  sort: z.enum(CA_LIST_SORTS).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(CA_MAX_PAGE_SIZE).optional(),
};

const text = (args: Record<string, unknown>, key: string): string | null => {
  const value = args[key];
  return typeof value === 'string' ? value : null;
};

const pageOf = (args: Record<string, unknown>) => ({
  sort: text(args, 'sort'),
  page: typeof args['page'] === 'number' ? args['page'] : 1,
  pageSize: typeof args['pageSize'] === 'number' ? args['pageSize'] : 20,
});

const pageOutput = (
  kind: string,
  query: Record<string, unknown>,
  page: CaRecordPage,
  subject: string
): McpToolOutput => ({
  ok: true,
  kind,
  query,
  items: page.items,
  meta: {
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    hasMore: page.hasMore,
    depthLimited: page.depthLimited,
    window: page.window,
    dataAsOf: page.dataAsOf,
    disclosureKey: page.disclosureKey,
  },
  summary: `${String(page.total)} contract award(s) ${subject} from ${page.window.from}${page.window.to === null ? '' : ` to ${page.window.to}`}; page ${String(page.page)} shows ${String(page.items.length)}.${page.depthLimited ? ' More than a list reaches: narrow the window.' : ''} Data as of ${page.dataAsOf}.`,
});

export const makeCaRecordsMcpTools = (deps: CaRecordsDeps): readonly KernelMcpTool[] => [
  {
    name: 'get_procurement_contract_award_summary',
    description: `A buyer's contract awards in the published window, by the buyer's fiscal code: record, valued, identity-review and undated counts, and the buyer as shown. ${RULES_NOTE}`,
    strictInput: true,
    inputShape: { buyerFiscalCode: CODE, ...windowShape },
    async handler(args) {
      const kind = 'procurement_contract_award_summary';
      const query = {
        buyerFiscalCode: text(args, 'buyerFiscalCode'),
        from: text(args, 'from'),
        to: text(args, 'to'),
      };
      const result = await caBuyerSummary(deps, query);
      if (result.isErr()) return failure(kind, result.error);
      const summary = result.value;
      return {
        ok: true,
        kind,
        query,
        item: summary,
        meta: { dataAsOf: summary.dataAsOf, disclosureKey: summary.disclosureKey },
        summary: `${String(summary.recordCount)} contract award(s) from ${summary.window.from} (${String(summary.undatedCount)} undated apart). Data as of ${summary.dataAsOf}.`,
      };
    },
  },
  {
    name: 'list_procurement_contract_awards',
    description: `A buyer's contract awards in the published window, newest award first (or oldest first, or by amount), with winners. Pages reach row 10000 at most; pageSize up to ${String(CA_MAX_PAGE_SIZE)}. ${RULES_NOTE}`,
    strictInput: true,
    inputShape: { buyerFiscalCode: CODE, ...windowShape, ...pageShape },
    async handler(args) {
      const kind = 'procurement_contract_awards';
      const request = {
        buyerFiscalCode: text(args, 'buyerFiscalCode'),
        from: text(args, 'from'),
        to: text(args, 'to'),
        ...pageOf(args),
      };
      const result = await listCaBuyerRecords(deps, request);
      if (result.isErr()) return failure(kind, result.error);
      return pageOutput(kind, request, result.value, 'of this buyer');
    },
  },
  {
    name: 'get_procurement_contract_award_winner_summary',
    description: `The contract awards a winner (supplier) won in the published window, by its fiscal code: counts and the winner as shown. Only a supplier whose code is shown and that is in the direct-acquisition gate or a registry-named company has one; any other code answers NOT_FOUND, the same whether or not it won anything. ${RULES_NOTE}`,
    strictInput: true,
    inputShape: { winnerFiscalCode: CODE, ...windowShape },
    async handler(args) {
      const kind = 'procurement_contract_award_winner_summary';
      const request = {
        winnerFiscalCode: text(args, 'winnerFiscalCode'),
        from: text(args, 'from'),
        to: text(args, 'to'),
      };
      const result = await caWinnerSummary(deps, request);
      if (result.isErr()) return failure(kind, result.error);
      const summary = result.value;
      return {
        ok: true,
        kind,
        // The code is echoed only by the answer's winner (shown, as every record shows it).
        query: { from: request.from, to: request.to },
        item: summary,
        meta: { dataAsOf: summary.dataAsOf, disclosureKey: summary.disclosureKey },
        summary: `${String(summary.recordCount)} contract award(s) won from ${summary.window.from} (${String(summary.undatedCount)} undated apart). Data as of ${summary.dataAsOf}.`,
      };
    },
  },
  {
    name: 'list_procurement_contract_awards_by_winner',
    description: `The contract awards a winner (supplier) won in the published window, joint wins included, newest award first (or oldest first, or by amount). Only a supplier whose code is shown and that is in the direct-acquisition gate or a registry-named company has a list; any other code answers NOT_FOUND. Pages reach row 10000 at most; pageSize up to ${String(CA_MAX_PAGE_SIZE)}. ${RULES_NOTE}`,
    strictInput: true,
    inputShape: { winnerFiscalCode: CODE, ...windowShape, ...pageShape },
    async handler(args) {
      const kind = 'procurement_contract_awards_by_winner';
      const request = {
        winnerFiscalCode: text(args, 'winnerFiscalCode'),
        from: text(args, 'from'),
        to: text(args, 'to'),
        ...pageOf(args),
      };
      const result = await listCaWinnerRecords(deps, request);
      if (result.isErr()) return failure(kind, result.error);
      // The code is echoed only by the records' winners (shown, as every record shows it).
      const query = { from: request.from, to: request.to, ...pageOf(args) };
      return pageOutput(kind, query, result.value, 'won');
    },
  },
  {
    name: 'get_procurement_contract_award',
    description: `One contract award by recordId (<source>:ca:<publication id>:<contract id>), with winners and lots (a lot's estimate is never a total). An id from an earlier build resolves to today's record (reanchored). A record before the floor answers NOT_FOUND as outside the published window. ${RULES_NOTE}`,
    strictInput: true,
    inputShape: { recordId: z.string().min(1).max(200) },
    async handler(args) {
      const kind = 'procurement_contract_award';
      const recordId = text(args, 'recordId') ?? '';
      const result = await getCaRecord(deps, recordId);
      if (result.isErr()) return failure(kind, result.error);
      const detail = result.value;
      return {
        ok: true,
        kind,
        query: { recordId },
        item: detail,
        meta: {
          dataAsOf: detail.dataAsOf,
          disclosureKey: detail.disclosureKey,
          reanchored: detail.reanchored,
        },
        summary: `Contract award ${detail.record.recordId}${detail.reanchored ? ' (re-anchored from an earlier id)' : ''}: ${detail.record.amountLei ?? 'no amount'} lei, award day ${detail.record.awardDay ?? 'unknown'}, ${String(detail.record.winnerCount)} winner(s), ${String(detail.lots.length)} lot(s). Data as of ${detail.dataAsOf}.`,
      };
    },
  },
];
