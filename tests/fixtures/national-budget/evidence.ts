/**
 * National budget — exact values from the reviewed domain reads (design turn
 * evidence; no live read in this turn). Strings exactly as
 * `trim_scale(value)::text` returned them.
 */

export const EXECUTION_EVIDENCE = {
  revenueQ2_2025Difference: '169195939317.60994',
  revenueYtdJune2025: '310520639938.72993',
  revenueFullYear2025: '662698173101.34997',
  revenueMonthDecember2025: '70789094792.50003',
  revenueQ4_2025: '195746159574.50995',
  revenueMonthJuly2026: '69789686883.46998',
  revenueYtdJuly2026: '412307346364.04004',
  /** Observed long tail (43 significant digits). */
  largeTail: '27546712048.55000178213231265544891357421875',
  fraction: '0.34714414515523835',
} as const;

export const EXECUTION_REASONS = {
  may2025: 'missing_endpoint_release',
  june2025Month: 'missing_predecessor_release',
  july2006Calendar: 'incompatible_endpoint_coverage',
} as const;

/** `period_start`/`period_end` of audited view rows (P0 `seriesEdges`). */
export const VIEW_INTERVALS = {
  june2025Month: ['2025-06-01', '2025-06-30'],
  june2025Ytd: ['2025-01-01', '2025-06-30'],
  q2_2025Difference: ['2025-04-01', '2025-06-30'],
  may2025Month: ['2025-05-01', '2025-05-31'],
  full2025: ['2025-01-01', '2025-12-31'],
  july2006Month: ['2006-07-01', '2006-07-31'],
  july2006Ytd: ['2006-01-01', '2006-07-31'],
} as const;

export const LAW_EVIDENCE = {
  /** 2025 state budget, capitol 5001 budget credits, thousand lei (token 499.582.980). */
  state5001Approved2025: '499582980',
  state5001Approved2025Ron: '499582980000',
  /** Forecasts for target year 2025 from the 2022, 2023 and 2024 laws. */
  state5001ForecastFor2025: { 2022: '346134145', 2023: '375444061', 2024: '415039725' },
  health5000Total2025: '77224741',
  health5005Total2025: '77220381',
} as const;
