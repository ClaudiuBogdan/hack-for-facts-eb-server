/**
 * Companies module — row → view-model mappers (plan §2.2). Pure, no DB. Money &
 * `employees` stay strings (precision-safe); `is_active` is NEVER read (§13-R1).
 */

import { COMPANY_STATUS_NOMENCLATURE } from '../../core/filters.js';

import type {
  CompanyAddress,
  CompanyCaenActivity,
  CompanyEuBranch,
  CompanyFinancialSummary,
  CompanyFinancialQualityFlag,
  CompanyFinancialYear,
  CompanyFiscal,
  CompanyRepresentative,
  CompanyStatus,
  CompanyStatusFlag,
  CompanyTerritory,
} from '../../core/types.js';

export const mapCountyDisplayName = (raw: string | null): string | null => {
  if (raw === null) return null;
  const withoutPrefix = raw
    .trim()
    .replace(/^jude[țţ]ul\s+/iu, '')
    .replace(/^municipiul\s+/iu, '');
  if (withoutPrefix === '') return null;
  return withoutPrefix
    .toLocaleLowerCase('ro-RO')
    .replace(
      /(^|[\s-])(\p{L})/gu,
      (_m, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ro-RO')}`
    );
};

const mapLocalityDisplayName = (raw: string | null): string | null =>
  raw === null
    ? null
    : raw
        .trim()
        .toLocaleLowerCase('ro-RO')
        .replace(
          /(^|[\s-])(\p{L})/gu,
          (_m, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ro-RO')}`
        );

/** Headline status from registrations code/label (mojibake-repaired nomenclature fallback). */
export const mapHeadlineStatus = (
  code: string | null,
  label: string | null
): CompanyStatus | null => {
  if (code === null) return null;
  return { code, label: label ?? COMPANY_STATUS_NOMENCLATURE[code] ?? code };
};

export const mapTerritory = (row: {
  uat_siruta_code: number | string | null;
  uat_name: string | null;
  county_name: string | null;
  match_confidence: string | null;
}): CompanyTerritory | null => {
  const hasSiruta =
    row.uat_siruta_code !== null || row.uat_name !== null || row.county_name !== null;
  // Distinguish "unmatched" (a registration exists, but the urban-only SIRUTA
  // matcher found no UAT — ~36.3% of companies) from "no data at all" (no
  // registration row → match_confidence null → territory null). The former now
  // surfaces an explicit `matchConfidence: 'unmatched'` object so callers can
  // tell the two apart (audit M4 — UNMATCHED was previously never emitted).
  if (!hasSiruta) {
    if (row.match_confidence === null) return null;
    return { sirutaCode: null, uatName: null, countyName: null, matchConfidence: 'unmatched' };
  }
  return {
    sirutaCode: row.uat_siruta_code === null ? null : String(row.uat_siruta_code),
    uatName: mapLocalityDisplayName(row.uat_name),
    countyName: mapCountyDisplayName(row.county_name),
    matchConfidence: row.match_confidence === 'safe' ? 'safe' : 'unmatched',
  };
};

export const mapAddress = (row: {
  raw_address: string | null;
  raw_county: string | null;
  raw_locality: string | null;
}): CompanyAddress => ({
  display: row.raw_address ?? '',
  county: mapCountyDisplayName(row.raw_county),
  locality: mapLocalityDisplayName(row.raw_locality),
});

export const mapFiscal = (
  row:
    | {
        is_vat_payer: boolean | null;
        is_inactive: boolean | null;
        main_caen_code: string | null;
        registered_name: string | null;
        snapshot_at: string | null;
      }
    | undefined
): CompanyFiscal | null => {
  if (row === undefined) return null;
  return {
    vatPayer: row.is_vat_payer,
    declaredFiscallyInactive: row.is_inactive,
    mainCaenCode: row.main_caen_code,
    registeredName: row.registered_name,
    asOf: row.snapshot_at,
  };
};

export const mapStatusFlag = (row: {
  status_code: string;
  status_label: string | null;
}): CompanyStatusFlag => ({
  code: row.status_code,
  label: row.status_label,
});

export const mapRepresentative = (row: { name: string; role: string }): CompanyRepresentative => ({
  name: row.name,
  role: row.role,
});

export const mapCaen = (row: {
  caen_code: string;
  caen_rev: string;
  source: string;
  label: string | null;
}): CompanyCaenActivity => ({
  code: row.caen_code,
  rev: row.caen_rev,
  source: row.source,
  label: row.label,
});

export const mapEuBranch = (row: {
  branch_name: string | null;
  country: string | null;
  euid: string | null;
  fiscal_code: string | null;
}): CompanyEuBranch => ({
  branchName: row.branch_name,
  country: row.country,
  euid: row.euid,
  fiscalCode: row.fiscal_code,
});

/** A financials row (money/employees as strings). `summary` carries the 20 typed metrics. */
export interface FinancialRow {
  year: number;
  source_system: string;
  turnover: string | null;
  net_profit: string | null;
  net_loss: string | null;
  employees: string | null;
  total_revenue: string | null;
  total_expenses: string | null;
  gross_profit: string | null;
  gross_loss: string | null;
  receivables: string | null;
  current_assets: string | null;
  fixed_assets: string | null;
  cash_and_bank: string | null;
  prepaid_expenses: string | null;
  deferred_income: string | null;
  subscribed_capital: string | null;
  inventories: string | null;
  debts: string | null;
  provisions: string | null;
  total_equity: string | null;
  patrimony_regie: string | null;
  lines: Record<string, unknown> | null;
}

const toSummary = (r: FinancialRow): CompanyFinancialSummary => ({
  turnover: r.turnover,
  netProfit: r.net_profit,
  netLoss: r.net_loss,
  totalRevenue: r.total_revenue,
  totalExpenses: r.total_expenses,
  grossProfit: r.gross_profit,
  grossLoss: r.gross_loss,
  receivables: r.receivables,
  currentAssets: r.current_assets,
  fixedAssets: r.fixed_assets,
  cashAndBank: r.cash_and_bank,
  prepaidExpenses: r.prepaid_expenses,
  deferredIncome: r.deferred_income,
  subscribedCapital: r.subscribed_capital,
  inventories: r.inventories,
  debts: r.debts,
  provisions: r.provisions,
  totalEquity: r.total_equity,
  patrimonyRegie: r.patrimony_regie,
});

/**
 * `lines` is the full ANAF statement (jsonb). pg parses jsonb numbers into JS
 * numbers, which violates the Money-as-string contract every other money field
 * honors (audit M6 — `lines["Creante"]` was a bare int while `summary.receivables`
 * was a string). Stringify numeric values so the contract is consistent and a
 * future non-zero-cents value cannot silently lose its decimals. (Realistic ANAF
 * RON values are < 2^53, so the jsonb→JS parse is lossless here; true bigint
 * precision would require the upstream loader to emit the value as text.)
 */
const stringifyLines = (lines: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (lines === null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(lines)) out[k] = typeof v === 'number' ? String(v) : v;
  return out;
};

/** A financial_quality_flags row (numerics pre-cast to text; unit is the metric's own). */
export interface QualityFlagRow {
  year: number;
  flag_code: string;
  metric_name: string;
  severity: string;
  numeric_value: string | null;
  threshold_value: string | null;
}

export const mapQualityFlag = (r: QualityFlagRow): CompanyFinancialQualityFlag => ({
  year: r.year,
  flagCode: r.flag_code,
  metricName: r.metric_name,
  severity: r.severity,
  numericValue: r.numeric_value,
  thresholdValue: r.threshold_value,
});

export const mapFinancialYear = (r: FinancialRow): CompanyFinancialYear => ({
  year: r.year,
  sourceSystem: r.source_system,
  turnover: r.turnover,
  netProfit: r.net_profit,
  netLoss: r.net_loss,
  employees: r.employees,
  summary: toSummary(r),
  lines: stringifyLines(r.lines),
});
