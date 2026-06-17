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
  CompanyFinancialYear,
  CompanyFiscal,
  CompanyRepresentative,
  CompanyStatus,
  CompanyStatusFlag,
  CompanyTerritory,
} from '../../core/types.js';

/** Headline status from registrations code/label (mojibake-repaired nomenclature fallback). */
export const mapHeadlineStatus = (
  code: string | null,
  label: string | null
): CompanyStatus | null => {
  if (code === null) return null;
  return { code, label: label ?? COMPANY_STATUS_NOMENCLATURE[code] ?? code };
};

export const mapTerritory = (row: {
  uat_siruta_code: number | null;
  uat_name: string | null;
  county_name: string | null;
  match_confidence: string | null;
}): CompanyTerritory | null => {
  // No territory at all → null (the ~36.3% unmatched, rural).
  if (row.uat_siruta_code === null && row.uat_name === null && row.county_name === null) return null;
  return {
    sirutaCode: row.uat_siruta_code === null ? null : String(row.uat_siruta_code),
    uatName: row.uat_name,
    countyName: row.county_name,
    matchConfidence: row.match_confidence === 'safe' ? 'safe' : 'unmatched',
  };
};

export const mapAddress = (row: {
  raw_address: string | null;
  raw_county: string | null;
  raw_locality: string | null;
}): CompanyAddress => ({
  display: row.raw_address ?? '',
  county: row.raw_county,
  locality: row.raw_locality,
});

export const mapFiscal = (
  row: {
    is_vat_payer: boolean | null;
    is_inactive: boolean | null;
    main_caen_code: string | null;
    registered_name: string | null;
    snapshot_at: string | null;
  } | undefined
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

export const mapStatusFlag = (row: { status_code: string; status_label: string | null }): CompanyStatusFlag => ({
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

export const mapFinancialYear = (r: FinancialRow): CompanyFinancialYear => ({
  year: r.year,
  turnover: r.turnover,
  netProfit: r.net_profit,
  netLoss: r.net_loss,
  employees: r.employees,
  summary: toSummary(r),
  lines: r.lines,
});
