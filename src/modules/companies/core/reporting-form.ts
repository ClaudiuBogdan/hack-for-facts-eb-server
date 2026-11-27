/**
 * Reporting-form marks on typed statements (PRIV-ZVPV). Pure.
 */

import type { CompanyFinancialYear, CompanyReportingFormMark } from './types.js';

/**
 * Each typed year with the form it is marked with, or unmarked. A mark belongs
 * to the statement of the same year, publisher and layout; a statement or a
 * mark without a layout hash never matches. Whatever the years carried before
 * is replaced, so an empty mark list leaves every year unmarked. Nothing else
 * of a statement changes.
 */
export const markReportingForms = (
  years: readonly CompanyFinancialYear[],
  marks: readonly CompanyReportingFormMark[]
): readonly CompanyFinancialYear[] =>
  years.map((year) => {
    const hash = year.source.statementProfileHash;
    const mark =
      hash === null
        ? undefined
        : marks.find(
            (m) =>
              m.year === year.year &&
              m.sourceSystem === year.sourceSystem &&
              m.statementProfileHash === hash
          );
    return {
      ...year,
      reportingForm: mark?.reportingForm ?? null,
      formEvidence: mark?.formEvidence ?? null,
    };
  });
