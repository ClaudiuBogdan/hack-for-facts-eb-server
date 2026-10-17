/**
 * Where a judicial MCP result opens in the client. The client's routes are
 * `/justice/...` and `/companies/$cui`, never `/judicial/...` (those 404).
 *
 * A link is given only when the client page shows exactly what the result
 * describes; otherwise there is no link (`link` is optional), never a page
 * that silently widens or changes the selection.
 *
 * - A case is addressed by its court and its number; the number keeps its
 *   slashes (`/justice/cases/TribunalulBUCURESTI/33517/3/2021/a85`), every
 *   other character escaped. This is the client's `casePath`, and a court or
 *   number the client's route would reject gets no link.
 * - A caseload of ONE year opens that year of the one court's page
 *   (`/justice/courts/<court>?an=<year>`) or, with no court bound, of the
 *   analysis page. The client pages describe one year and fall back to their
 *   default for a year they do not hold, so the year must be a year with
 *   cases (the result's own count; the client offers every year the capture
 *   holds a case in). A caseload over several or all years, or with a level
 *   or category bound, or several courts, is not a page of the client, so it
 *   gets no link.
 * - A company's litigation is the litigation band of its profile, by the
 *   normalized CUI the result carries; a filtered summary (level, category or
 *   year) is not what the band shows, so it gets no link.
 */

const seg = (value: string): string => encodeURIComponent(value);

/** The client's court code (`justice-paths.ts` COURT_CODE): letters, then letters and digits. */
const COURT_CODE = /^[A-Za-z][A-Za-z0-9]{3,63}$/u;
/** The client's case number in a path (`justice-paths.ts` CASE_NUMBER_IN_PATH, no `//`, no dot segment). */
const CASE_NUMBER_IN_PATH = /^\d{1,7}(?:[.,]\d{0,3}\.?)?\/\d[0-9A-Za-z/*.,-]{0,90}$/u;
/** The client's company profile CUI (`normalizeCompanyCui`): digits only, not all zeros. */
const CUI = /^\d+$/u;
const ALL_ZEROS = /^0+$/u;

const isCaseNumber = (number: string): boolean =>
  CASE_NUMBER_IN_PATH.test(number) &&
  !number.includes('//') &&
  !number.split('/').some((segment) => segment === '.' || segment === '..');

export const judicialCaseLink = (
  base: string,
  institutionCode: string,
  caseNumber: string
): string | null =>
  COURT_CODE.test(institutionCode) && isCaseNumber(caseNumber)
    ? `${base}/justice/cases/${seg(institutionCode)}/${caseNumber.split('/').map(seg).join('/')}`
    : null;

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

export const judicialCaseloadLink = (
  base: string,
  bounds: {
    readonly institutionCode?: unknown;
    readonly courtLevel?: unknown;
    readonly category?: unknown;
    readonly yearFrom?: unknown;
    readonly yearTo?: unknown;
  },
  caseCount: number
): string | null => {
  // A level or category bound has no page of its own in the client.
  if (present(bounds.courtLevel) || present(bounds.category)) return null;
  let court: string | null = null;
  if (present(bounds.institutionCode)) {
    const courts = bounds.institutionCode;
    if (!Array.isArray(courts) || courts.length !== 1) return null;
    const [only] = courts as unknown[];
    if (typeof only !== 'string' || !COURT_CODE.test(only)) return null;
    court = only;
  }
  // The client pages describe exactly one year, and only a year with cases.
  const from = bounds.yearFrom ?? null;
  if (typeof from !== 'number' || !Number.isInteger(from) || from !== bounds.yearTo) return null;
  if (!(caseCount > 0)) return null;
  const path = court === null ? '/justice/analytics' : `/justice/courts/${seg(court)}`;
  return `${base}${path}?an=${String(from)}`;
};

export const companyLitigationLink = (base: string, cui: string): string | null =>
  CUI.test(cui) && !ALL_ZEROS.test(cui) ? `${base}/companies/${cui}#litigii` : null;
