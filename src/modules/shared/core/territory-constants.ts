/**
 * The one territory the kernel has to name (review N/K1): Bucharest is a county
 * (`county_code 'B'`) whose only pre-L2 geographic row was the municipality
 * (SIRUTA 179132), and whose six sectors are `locality`/`sector` children of
 * that municipality with their own SIRUTA codes. The kernel, the budget module
 * and the INS module read these values from here (raw SQL through `sql.lit`, so
 * the compiled text is unchanged and the SQL pin tests hold; the budget and
 * INS modules re-export rather than redeclare). The legacy budget-viz modules
 * (`normalization`, `advanced-map-analytics`, served by `api.js` only) keep
 * their own copies until slice 2 deletes them. Pinned by
 * `tests/unit/shared/territory-constants.test.ts`.
 */
export const BUCHAREST_COUNTY_CODE = 'B';
export const BUCHAREST_MUNICIPALITY_SIRUTA = '179132';
/** The kernel `core.territories` shape of a sector row. */
export const BUCHAREST_SECTOR_LEVEL = 'locality';
export const BUCHAREST_SECTOR_KIND = 'sector';
/** Sectors 1–6, in sector order. */
export const BUCHAREST_SECTOR_SIRUTAS = [
  '179141',
  '179150',
  '179169',
  '179178',
  '179187',
  '179196',
] as const;
