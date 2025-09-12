import { z } from 'zod'
import { GqlReportType, PeriodDate, ReportPeriodInput, ReportPeriodType, TMonth, TQuarter, YearMonthPeriod, YearPeriod } from '../types'

export function toReportTypeValue(gqlReportType: GqlReportType) {
  if (gqlReportType === 'PRINCIPAL_AGGREGATED') return 'Executie bugetara agregata la nivel de ordonator principal'
  if (gqlReportType === 'SECONDARY_AGGREGATED') return 'Executie bugetara agregata la nivel de ordonator secundar'
  if (gqlReportType === 'DETAILED') return 'Executie bugetara detaliata'
  throw new Error('Invalid GqlReportType')
}

export function toReportGqlType(reportType: string) {
  if (reportType === 'Executie bugetara agregata la nivel de ordonator principal') return 'PRINCIPAL_AGGREGATED'
  if (reportType === 'Executie bugetara agregata la nivel de ordonator secundar') return 'SECONDARY_AGGREGATED'
  if (reportType === 'Executie bugetara detaliata') return 'DETAILED'
  throw new Error('Invalid ReportType')
}

export const YEAR_PERIOD = /^\d{4}$/
export const YEAR_MONTH_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
export const YEAR_QUARTER_PERIOD = /^\d{4}-Q[1-4]$/

export function assertYearMonthPeriod(m: string): asserts m is YearMonthPeriod {
  if (!YEAR_MONTH_PERIOD.test(m)) throw new Error('Invalid YearMonthPeriod (YYYY-MM)')
}

export function assertAnchored(type: ReportPeriodType, value: PeriodDate) {
  if (type === 'YEAR' && !YEAR_PERIOD.test(value)) throw new Error('Year must use 4 digits')
  if (type === 'QUARTER' && !YEAR_QUARTER_PERIOD.test(value)) throw new Error('Quarter must use Q1/Q2/Q3/Q4 anchors')
  if (type === 'MONTH' && !YEAR_MONTH_PERIOD.test(value)) throw new Error('Month must use YYYY-MM anchors')
}

export function getQuarterForMonth(month: number): TQuarter {
  if (month <= 3) return 'Q1'
  if (month <= 6) return 'Q2'
  if (month <= 9) return 'Q3'
  return 'Q4'
}

export function getQuarterEndMonth(q: TQuarter): TMonth {
  return q === 'Q1' ? '03' : q === 'Q2' ? '06' : q === 'Q3' ? '09' : '12'
}

export function clampMonth(mm: number): TMonth {
  const m = Math.max(1, Math.min(12, mm))
  return String(m).padStart(2, '0') as TMonth
}

export function makeSingleTimePeriod(type: ReportPeriodType, ym: PeriodDate): ReportPeriodInput {
  if (type !== 'MONTH') assertAnchored(type, ym)
  return { type, selection: { interval: { start: ym, end: ym } } }
}

export const GqlReportTypeEnum = z.enum(['PRINCIPAL_AGGREGATED', 'SECONDARY_AGGREGATED', 'DETAILED'])
export type GqlReportTypeEnumT = z.infer<typeof GqlReportTypeEnum>


