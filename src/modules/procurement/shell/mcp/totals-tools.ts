/**
 * Totals v2 — MCP tool (registered only when PROCUREMENT_TOTALS_V2 is on).
 * The same use case, and so the same D6 rule and explanation, as GraphQL.
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  type KernelMcpTool,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import {
  CONTRACT_KINDS,
  MAX_TOTALS_REQUESTS,
  moneyTotals,
  PROCUREMENT_KINDS,
  STATUSES,
  VALUE_KINDS,
  VAT_BASES,
  type MoneyTotalsPort,
  type TotalsRequestInput,
} from '../../core/money-totals.js';

const oneOf = (values: readonly string[]): string => values.join(', ');

// Structure only: values are validated by the use case, so a bad value comes
// back as the same structured InvalidInput (naming its field) as on GraphQL,
// and null means "not set", as on GraphQL.
const text = z.string().max(200).nullish();
const texts = z.array(z.string().max(64)).max(16).nullish();

const requestShape = z
  .object({
    id: z.string().min(1).max(64),
    filters: z
      .object({
        procurementKinds: z.array(z.string().max(64)).max(16),
        contractKinds: texts,
        statuses: texts,
        from: text,
        to: text,
        buyerCode: text,
        supplierCode: text,
        cpvPrefix: text,
        countyCode: text,
        siruta: text,
        vatBases: texts,
        q: text,
      })
      .strict(),
    valueKinds: texts,
    currencySubtotals: z.boolean().nullish(),
  })
  .strict();

export const makeTotalsMcpTools = (
  port: MoneyTotalsPort,
  disclosure?: SupplierDisclosurePort
): readonly KernelMcpTool[] => [
  {
    name: 'aggregate_procurement_totals',
    description: `Romanian public procurement money totals for up to ${String(MAX_TOTALS_REQUESTS)} filter sets, all read from one data build. Each request names its procurement kinds (never mixed unless listed) and filters (statuses default to awarded; date range on the day the money happened; buyer or supplier fiscal code; CPV prefix; county; VAT basis; title words). Each answer gives one total per value kind (lei, decimal text, summed as published with no VAT conversion; value kinds are never summed together), what was left out with counts (other statuses, not additive, no value, undated, joint contracts not attributed to one firm), flagged and disclosed records, and an explanation to quote verbatim. A supplier code that is not public matches nothing and is never echoed. Values: procurementKinds ${oneOf(PROCUREMENT_KINDS)}; contractKinds ${oneOf(CONTRACT_KINDS)}; statuses ${oneOf(STATUSES)}; valueKinds ${oneOf(VALUE_KINDS)}; vatBases ${oneOf(VAT_BASES)}; dates YYYY-MM-DD; codes are digits.`,
    strictInput: true,
    inputShape: { requests: z.array(requestShape).min(1).max(MAX_TOTALS_REQUESTS) },
    async handler(args) {
      const kind = 'procurement_totals';
      const requests = (args['requests'] ?? []) as readonly TotalsRequestInput[];
      const result = await moneyTotals(port, requests, disclosure);
      if (result.isErr()) {
        return {
          ok: false,
          kind,
          error: result.error.message,
          errorType: result.error.type,
          errorCode: GRAPHQL_ERROR_CODE[result.error.type],
          ...(result.error.type === 'ServiceUnavailable' &&
            result.error.retryAfterSeconds !== undefined && {
              retryAfterSeconds: result.error.retryAfterSeconds,
            }),
        };
      }
      const answers = result.value;
      return {
        ok: true,
        kind,
        items: answers,
        meta: {
          factBuild: answers[0]?.factBuild ?? null,
          disclosureKey: answers[0]?.disclosureKey ?? null,
        },
        summary: answers.map((answer) => `${answer.id}: ${answer.explanation.textEn}`).join('\n'),
      };
    },
  },
];
