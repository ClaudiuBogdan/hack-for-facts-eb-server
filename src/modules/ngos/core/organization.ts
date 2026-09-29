import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import type { NgoFinancialStatement, NgoOrganizationProfile } from './organization-types.js';

export interface NgoOrganizationRepository {
  /** Null unless the CUI is the eligible identity of a current public registry organization. */
  profile(cui: string): Promise<Result<NgoOrganizationProfile | null, ApiError>>;
  /** Admitted MFP statements for the eligible CUI; `null` years means every admitted year. */
  financialStatements(
    cui: string,
    fiscalYears: readonly number[] | null
  ): Promise<Result<readonly NgoFinancialStatement[], ApiError>>;
}

export const MAX_FINANCIAL_YEARS_PER_REQUEST = 20;
export const MIN_FISCAL_YEAR = 1990;
export const MAX_FISCAL_YEAR = 2100;
const CANONICAL_CUI = /^[1-9][0-9]{1,9}$/;

const invalidCui = () =>
  Promise.resolve(err(invalidInput('Expected a canonical organization CUI', 'cui')));

/**
 * Request validation for a year list, independent of whether financials are loaded, so an
 * invalid request never looks like missing coverage. `null` means every admitted year.
 */
export const validateFiscalYears = (
  fiscalYears: readonly number[] | null,
  maxYears = MAX_FINANCIAL_YEARS_PER_REQUEST,
  field = 'fiscalYears'
): Result<readonly number[] | null, ApiError> => {
  if (
    fiscalYears !== null &&
    (fiscalYears.length === 0 ||
      fiscalYears.length > maxYears ||
      new Set(fiscalYears).size !== fiscalYears.length ||
      fiscalYears.some(
        (year) => !Number.isInteger(year) || year < MIN_FISCAL_YEAR || year > MAX_FISCAL_YEAR
      ))
  )
    return err(
      invalidInput(
        `${field} must list 1-${String(maxYears)} distinct years between ${String(MIN_FISCAL_YEAR)} and ${String(MAX_FISCAL_YEAR)}`,
        field
      )
    );
  return ok(fiscalYears);
};

export const getNgoOrganizationProfile = (repo: NgoOrganizationRepository, cui: string) => {
  if (!CANONICAL_CUI.test(cui)) return invalidCui();
  return repo.profile(cui);
};

export const getNgoFinancialStatements = (
  repo: NgoOrganizationRepository,
  cui: string,
  fiscalYears: readonly number[] | null
) => {
  if (!CANONICAL_CUI.test(cui)) return invalidCui();
  const years = validateFiscalYears(fiscalYears);
  if (years.isErr()) return Promise.resolve(err(years.error));
  return repo.financialStatements(cui, years.value);
};
