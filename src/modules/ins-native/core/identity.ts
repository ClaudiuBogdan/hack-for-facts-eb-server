/**
 * INS native module — the public identity contract (plan §3.2, decision D1b).
 *
 * The legacy classification codes (`SEX`, `TOTAL`, `1634_ANI`) were label slugs
 * minted by a classifier that is demonstrably mis-typed (values `1634_ANI` and
 * `URBAN` sit under type `SEX`), so they are NOT reproduced. Public identity is:
 *
 *  - dimension ("classification type") code: `D<dimIndex>` — the source
 *    position of the dimension in the matrix (0-based, as TEMPO orders it);
 *  - member ("classification value") code: the TEMPO `nomItemId` as a decimal
 *    string — source-issued, never interpreted outside its (dataset, dimension);
 *  - the `TOTAL` alias: resolved through `member_role = 'TOTAL'` on the pinned
 *    dimension (one TOTAL per dimension is structural since migration
 *    20260903T100000); zero matches → NO_DATA, never a label match;
 *  - observation ref (design §5): `v1:<dataset>:<d1>:…:<dk>:<time>:<unit>`,
 *    computed at the boundary from the identity tuple, never stored.
 *
 * Everything here is pure and total: malformed input yields `null`, never a
 * throw, so a resolver can turn it into `InvalidInput` deliberately.
 */

import type { InsCoordinate, InsObservationView } from './types.js';

export const TOTAL_ALIAS = 'TOTAL';
const DIMENSION_CODE = /^D(\d{1,2})$/u;
const MEMBER_CODE = /^-?\d{1,10}$/u;
// Source nomenclature and observation coordinates use PostgreSQL integer, including zero.
const SOURCE_MEMBER_MIN = -2147483648;
const SOURCE_MEMBER_MAX = 2147483647;
const OBSERVATION_REF_VERSION = 'v1';

/** `D<dimIndex>` for a dimension of a dataset. */
export const dimensionCode = (dimIndex: number): string => `D${String(dimIndex)}`;

/** Parse `D<dimIndex>`; null when the token is not a dimension code. */
export const parseDimensionCode = (code: string): number | null => {
  const m = DIMENSION_CODE.exec(code.trim());
  return m === null ? null : Number(m[1]);
};

/** The public code of a member: its TEMPO nomItemId. */
export const memberCode = (nomItemId: number): string => String(nomItemId);

export const isSourceMemberId = (value: number): boolean =>
  Number.isInteger(value) && value >= SOURCE_MEMBER_MIN && value <= SOURCE_MEMBER_MAX;

/** Parse a member code into a nomItemId; null when it is not a source integer. */
export const parseMemberCode = (code: string): number | null => {
  const t = code.trim();
  if (!MEMBER_CODE.test(t)) return null;
  const value = Number(t);
  if (!isSourceMemberId(value)) return null;
  return value === 0 ? 0 : value;
};

export const isTotalAlias = (code: string): boolean => code.trim().toUpperCase() === TOTAL_ALIAS;

/**
 * Encode the identity tuple. `k` is the dataset's classification dimension
 * count: trailing NULL slots need no representation (design §5).
 */
export const observationRef = (coordinate: InsCoordinate, k: number): string => {
  const slots = coordinate.slots.slice(0, k).map((s) => (s === null ? '' : String(s)));
  return [
    OBSERVATION_REF_VERSION,
    coordinate.datasetCode,
    ...slots,
    String(coordinate.timeNomItemId),
    String(coordinate.unitNomItemId),
  ].join(':');
};

/** Shared wire identity; hydration validates contiguous expected classification slots. */
export const observationViewRef = (row: InsObservationView): string =>
  observationRef(
    row.coordinate,
    row.coordinate.slots.reduce<number>(
      (arity, value, index) => (value === null ? arity : index + 1),
      0
    )
  );

/**
 * Decode an observation ref. The dataset's `k` is not known to the parser, so
 * it takes whatever is between the code and the last two fields as slots; the
 * caller validates the count against the dataset.
 */
export const parseObservationRef = (ref: string): InsCoordinate | null => {
  const parts = ref.split(':');
  if (parts.length < 4 || parts[0] !== OBSERVATION_REF_VERSION) return null;
  const datasetCode = parts[1] ?? '';
  if (datasetCode === '') return null;
  const time = parseMemberCode(parts[parts.length - 2] ?? '');
  const unit = parseMemberCode(parts[parts.length - 1] ?? '');
  if (time === null || unit === null) return null;
  const slotParts = parts.slice(2, -2);
  const slots: (number | null)[] = [];
  for (const p of slotParts) {
    if (p === '') {
      slots.push(null);
      continue;
    }
    const n = parseMemberCode(p);
    if (n === null) return null;
    slots.push(n);
  }
  return { datasetCode, slots, timeNomItemId: time, unitNomItemId: unit };
};

/**
 * A period token as the client sends it (`2023`, `2023-Q1`, `2023-03`),
 * parsed to inclusive date bounds. Null when the token is not one of the three
 * forms — the caller turns that into `InvalidInput`.
 */
export const periodTokenBounds = (
  token: string
): { periodicity: 'ANNUAL' | 'QUARTERLY' | 'MONTHLY'; start: string; end: string } | null => {
  const t = token.trim();
  let m = /^(\d{4})$/u.exec(t);
  if (m !== null) {
    const y = m[1] ?? '';
    return { periodicity: 'ANNUAL', start: `${y}-01-01`, end: `${y}-12-31` };
  }
  m = /^(\d{4})-Q([1-4])$/u.exec(t);
  if (m !== null) {
    const y = m[1] ?? '';
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      periodicity: 'QUARTERLY',
      start: `${y}-${pad(startMonth)}-01`,
      end: `${y}-${pad(endMonth)}-${lastDay(Number(y), endMonth)}`,
    };
  }
  m = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(t);
  if (m !== null) {
    const y = m[1] ?? '';
    const month = Number(m[2]);
    return {
      periodicity: 'MONTHLY',
      start: `${y}-${pad(month)}-01`,
      end: `${y}-${pad(month)}-${lastDay(Number(y), month)}`,
    };
  }
  return null;
};

const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (year: number, month: number): string =>
  pad(new Date(Date.UTC(year, month, 0)).getUTCDate());

/**
 * The legacy `iso_period` token for a native period: `YYYY` for annual,
 * `YYYY-QN` for quarterly, `YYYY-MM` for monthly. Other periodicities fall back
 * to the start date so the token stays sortable and truthful.
 */
export const isoPeriodToken = (periodicity: string, periodStart: string): string => {
  const year = periodStart.slice(0, 4);
  const month = Number(periodStart.slice(5, 7));
  switch (periodicity) {
    case 'ANNUAL':
      return year;
    case 'QUARTERLY':
      return `${year}-Q${String(Math.floor((month - 1) / 3) + 1)}`;
    case 'MONTHLY':
      return `${year}-${pad(month)}`;
    default:
      return periodStart;
  }
};

/** Year / quarter / month of a native period, as the legacy `InsTimePeriod` exposes them. */
export const periodParts = (
  periodicity: string,
  periodStart: string
): { year: number; quarter: number | null; month: number | null } => {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  switch (periodicity) {
    case 'QUARTERLY':
      return { year, quarter: Math.floor((month - 1) / 3) + 1, month: null };
    case 'MONTHLY':
      return { year, quarter: Math.floor((month - 1) / 3) + 1, month };
    default:
      return { year, quarter: null, month: null };
  }
};
