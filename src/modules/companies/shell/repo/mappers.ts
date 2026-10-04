/**
 * Companies module — row → view-model mappers (plan §2.2). Pure, no DB. Money &
 * `employees` stay strings (precision-safe); `is_active` is NEVER read (§13-R1).
 */

import { CAEN_CATALOG_SOURCE, onrcActivityKeys } from '../../core/registry.js';
import {
  COMPANY_FINANCIAL_METRICS,
  COMPANY_METRIC_STATUSES,
  COMPANY_QUALIFICATION_EVALUATOR,
  type CompanyCaenActivity,
  type CompanyFinancialSummary,
  type CompanyFinancialQualityFlag,
  type CompanyFinancialYear,
  type CompanyFiscal,
  type CompanyMetricStatus,
  type CompanyRegistryCaenObservation,
  type CompanyRegistryCuiProfile,
  type CompanyRegistryStatusObservation,
  type CompanyStatementQualification,
  type CompanyStatementSource,
  type CompanyStatusFlag,
  type CompanyTerritory,
} from '../../core/types.js';

/** Canonical display casing of a county name ("JUDEŢUL BACĂU" → "Bacău"). */
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

/**
 * Territory from the pinned edition's derived-geography consensus: present
 * only when a county or UAT consensus value exists. `safe` = a UAT consensus
 * value; `unmatched` = a county consensus without one. Conflicting, partial,
 * missing or unresolved geography is not coerced into a territory (the bases
 * stay on `registry.profile`).
 */
export const territoryOf = (profile: CompanyRegistryCuiProfile | null): CompanyTerritory | null => {
  if (profile === null) return null;
  const county = profile.countyCode.value;
  const uat = profile.uatSirutaCode.value;
  if (county === null && uat === null) return null;
  return {
    sirutaCode: uat,
    uatName: uat === null ? null : mapLocalityDisplayName(profile.uatName),
    countyName: county === null ? null : mapCountyDisplayName(profile.countyName),
    matchConfidence: uat !== null ? 'safe' : 'unmatched',
  };
};

/** The ANAF declared main activity as the fiscal read carries it (its own revision, label by it). */
export interface FiscalMainActivity {
  readonly main_caen_code: string | null;
  readonly main_caen_rev: string | null;
  readonly main_caen_label: string | null;
}

/**
 * The profile's activity list: one entry per (revision, code) the pinned
 * edition publicly observes (parsed codes only), then ANAF's declared main
 * activity. Labels are the current database catalog's for the entry's OWN
 * known revision; an unknown revision has none. The presence badge counts
 * this exact list.
 */
export const caenActivitiesOf = (
  observations: readonly CompanyRegistryCaenObservation[],
  fiscal: FiscalMainActivity | undefined
): CompanyCaenActivity[] => {
  const onrc = onrcActivityKeys(observations).map((a): CompanyCaenActivity => ({
    code: a.code,
    rev: a.revision,
    source: 'onrc',
    label: a.label,
    labelSource: a.label === null ? null : CAEN_CATALOG_SOURCE,
  }));
  const mainCode = fiscal?.main_caen_code ?? null;
  if (mainCode === null || mainCode.trim() === '') return onrc;
  const rev = fiscal?.main_caen_rev === '' ? null : (fiscal?.main_caen_rev ?? null);
  const label = rev === null ? null : (fiscal?.main_caen_label ?? null);
  return [
    ...onrc,
    {
      code: mainCode,
      rev,
      source: 'anaf',
      label,
      labelSource: label === null ? null : CAEN_CATALOG_SOURCE,
    },
  ];
};

/** One flag per distinct parsed public status code, with the edition's observed label (NULL until bound). */
export const statusFlagsOf = (
  observations: readonly CompanyRegistryStatusObservation[]
): CompanyStatusFlag[] => {
  const byCode = new Map<string, string | null>();
  for (const o of observations) {
    if (o.code === null) continue;
    if (!byCode.has(o.code) || byCode.get(o.code) === null) byCode.set(o.code, o.label);
  }
  return [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, label]) => ({ code, label }));
};

export const mapFiscal = (
  row:
    | {
        is_vat_payer: boolean | null;
        is_inactive: boolean | null;
        main_caen_code: string | null;
        main_caen_rev: string | null;
        registered_name: string | null;
        /** ANAF's state date ('YYYY-MM-DD'); NULL stays unknown, never a retrieval time. */
        status_date: string | null;
      }
    | undefined
): CompanyFiscal | null => {
  if (row === undefined) return null;
  return {
    vatPayer: row.is_vat_payer,
    declaredFiscallyInactive: row.is_inactive,
    mainCaenCode: row.main_caen_code,
    mainCaenRev: row.main_caen_rev === '' ? null : row.main_caen_rev,
    registeredName: row.registered_name,
    asOf: row.status_date,
  };
};

/**
 * The qualification columns of the same statement, read in the SAME statement
 * (one snapshot) from `financial_qualification_active` (alias `q`). Absent
 * when the runtime cannot read the view; all NULL when the LEFT JOIN found no
 * row (nothing published).
 */
export interface QualificationColumns {
  q_release_id?: string | null;
  q_policy_sha256?: string | null;
  q_policy_version?: string | null;
  q_policy_approved_on?: string | null;
  q_evaluator_version?: string | null;
  q_assessment?: string | null;
  q_assessment_reason?: string | null;
  /** The 21 statuses in `COMPANY_FINANCIAL_METRICS` order. */
  q_statuses?: readonly (string | null)[] | null;
  q_net_result_value?: string | null;
  q_hold_reason?: string | null;
  q_hold_drift?: readonly string[] | null;
}

/** A financials row (money/employees as strings). `summary` carries the 20 typed metrics. */
export interface FinancialRow extends QualificationColumns {
  year: number;
  source_system: string;
  statement_profile_hash: string | null;
  metric_rule_version: string;
  /** The ANAF bilanț web-service URL stored with the statement; NULL for MFP (CHECK). */
  source_url: string | null;
  /** `financial_source_resources.captured_source_url` (MFP only); absent when not readable. */
  resource_url?: string | null;
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

/**
 * The canonical statement URL resolve (PRIVATE_COMPANIES_NOTES, 2026-08-18):
 * `coalesce(f.source_url, r.captured_source_url)`, the arm that fires naming
 * the kind. Each arm is accepted only for its own publisher, so an ANAF
 * endpoint is never labelled as an MFP file or the reverse.
 */
export const mapStatementSource = (r: FinancialRow): CompanyStatementSource => {
  const anaf = r.source_system === 'anaf' && r.source_url !== null;
  const mfp = !anaf && r.source_system === 'mfp' && (r.resource_url ?? null) !== null;
  return {
    sourceSystem: r.source_system,
    url: anaf ? r.source_url : mfp ? (r.resource_url ?? null) : null,
    urlKind: anaf ? 'anaf_statement' : mfp ? 'mfp_resource' : null,
    statementProfileHash: r.statement_profile_hash,
    metricRuleVersion: r.metric_rule_version,
  };
};

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/u;

const isMetricStatus = (value: unknown): value is CompanyMetricStatus =>
  typeof value === 'string' && (COMPANY_METRIC_STATUSES as readonly string[]).includes(value);

const notAssessed = (
  reason: string,
  identity: Partial<CompanyStatementQualification> = {}
): CompanyStatementQualification => ({
  assessment: 'not_assessed',
  reason,
  releaseId: identity.releaseId ?? null,
  policyVersion: identity.policyVersion ?? null,
  policySha256: identity.policySha256 ?? null,
  policyApprovedOn: identity.policyApprovedOn ?? null,
  evaluatorVersion: identity.evaluatorVersion ?? null,
  metrics: [],
  netResultStatus: null,
  netResult: null,
  holdReason: identity.holdReason ?? null,
  holdDrift: identity.holdDrift ?? [],
});

/**
 * The statement's qualification as the evaluator row states it, or
 * `not_assessed` with a reason. Fail closed: anything this API cannot read
 * exactly (no capability, no row, an unknown evaluator, an incomplete or
 * unknown status list, a net value that does not match its status) is never
 * served as `reported`.
 */
export const mapQualification = (
  r: QualificationColumns,
  readable: boolean
): CompanyStatementQualification => {
  if (!readable) return notAssessed('qualification_unavailable');
  if ((r.q_assessment ?? null) === null) return notAssessed('no_active_policy');
  const identity: Partial<CompanyStatementQualification> = {
    releaseId: r.q_release_id ?? null,
    policyVersion: r.q_policy_version ?? null,
    policySha256: r.q_policy_sha256 ?? null,
    policyApprovedOn: r.q_policy_approved_on ?? null,
    evaluatorVersion: r.q_evaluator_version ?? null,
    holdReason: r.q_hold_reason ?? null,
    holdDrift: [...(r.q_hold_drift ?? [])],
  };
  if (r.q_evaluator_version !== COMPANY_QUALIFICATION_EVALUATOR) {
    return notAssessed('qualification_malformed', identity);
  }
  if (r.q_assessment === 'not_assessed') {
    return notAssessed(r.q_assessment_reason ?? 'qualification_malformed', identity);
  }
  const statuses = r.q_statuses ?? null;
  if (
    r.q_assessment !== 'assessed' ||
    statuses?.length !== COMPANY_FINANCIAL_METRICS.length ||
    !statuses.every(isMetricStatus)
  ) {
    return notAssessed('qualification_malformed', identity);
  }
  const netResultStatus = statuses[statuses.length - 1] ?? null;
  const netValue = r.q_net_result_value ?? null;
  const netReported = netResultStatus === 'reported';
  if (netReported !== (netValue !== null) || (netValue !== null && !PLAIN_DECIMAL.test(netValue))) {
    return notAssessed('qualification_malformed', identity);
  }
  return {
    assessment: 'assessed',
    reason: null,
    releaseId: identity.releaseId ?? null,
    policyVersion: identity.policyVersion ?? null,
    policySha256: identity.policySha256 ?? null,
    policyApprovedOn: identity.policyApprovedOn ?? null,
    evaluatorVersion: identity.evaluatorVersion ?? null,
    // The length check above makes this exactly 21 pairs.
    metrics: COMPANY_FINANCIAL_METRICS.flatMap((metric, index) => {
      const status = statuses[index];
      return status === undefined ? [] : [{ metric, status }];
    }),
    netResultStatus,
    netResult: netReported ? netValue : null,
    holdReason: identity.holdReason ?? null,
    holdDrift: identity.holdDrift ?? [],
  };
};

/**
 * One statement: the ORIGINAL source strings unchanged, plus its source and
 * qualification. `qualificationReadable` says whether the read could join the
 * evaluator at all (the repo's capability probe).
 */
export const mapFinancialYear = (
  r: FinancialRow,
  qualificationReadable: boolean
): CompanyFinancialYear => ({
  year: r.year,
  sourceSystem: r.source_system,
  turnover: r.turnover,
  netProfit: r.net_profit,
  netLoss: r.net_loss,
  employees: r.employees,
  summary: toSummary(r),
  lines: stringifyLines(r.lines),
  source: mapStatementSource(r),
  qualification: mapQualification(r, qualificationReadable),
});
