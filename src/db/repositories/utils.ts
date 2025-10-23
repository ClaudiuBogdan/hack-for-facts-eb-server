import { NormalizationMode, PeriodDate, ReportPeriodInput } from "../../types";
import { datasetRepository } from "./datasetRepository";

export function getNormalizationUnit(normalization: NormalizationMode | undefined) {
  if (!normalization || normalization === 'total') {
    return 'RON';
  }
  if (normalization === 'total_euro') {
    return 'EUR';
  }
  if (normalization === 'per_capita') {
    return 'RON/capita';
  }
  if (normalization === 'per_capita_euro') {
    return 'EUR/capita';
  }
  throw new Error(`Unknown normalization mode: ${normalization}`);
}


type ParsedDate = { year: number; month?: number; quarter?: string };

function parseDate(date: PeriodDate): ParsedDate {
  const yearMatch = date.match(/^(\d{4})$/);
  if (yearMatch) return { year: parseInt(yearMatch[1], 10) };

  const monthMatch = date.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (monthMatch) return { year: parseInt(monthMatch[1], 10), month: parseInt(monthMatch[2], 10) };

  const quarterMatch = date.match(/^(\d{4})-(Q[1-4])$/);
  if (quarterMatch) return { year: parseInt(quarterMatch[1], 10), quarter: quarterMatch[2] };

  throw new Error(`Invalid date format: ${date}`);
}

export function buildPeriodFilterSql(
  period: ReportPeriodInput,
  paramIndex: number,
  alias: string = 'eli'
): { clause: string; values: any[]; nextParamIndex: number } {
  const conditions: string[] = [];
  const values: any[] = [];

  if (period.selection.interval) {
    const { start, end } = period.selection.interval;
    const startParsed = parseDate(start);
    const endParsed = parseDate(end);

    const sameYear = startParsed.year === endParsed.year;


    if (period.type === 'YEAR' && sameYear) {
      conditions.push(`${alias}.year = $${paramIndex++}`);
      values.push(startParsed.year);
    } else if (period.type === 'YEAR') {
      conditions.push(`${alias}.year BETWEEN $${paramIndex++} AND $${paramIndex++}`);
      values.push(startParsed.year, endParsed.year);
      // TODO: add more optimizations if same year and same month. Use equals instead of BETWEEN
    } else if (period.type === 'MONTH') {
      conditions.push(`(${alias}.year, ${alias}.month) BETWEEN ($${paramIndex++}, $${paramIndex++}) AND ($${paramIndex++}, $${paramIndex++})`);
      values.push(startParsed.year, startParsed.month, endParsed.year, endParsed.month);
    } else if (period.type === 'QUARTER') {
      const quarterMap: { [key: string]: number } = { 'Q1': 1, 'Q2': 2, 'Q3': 3, 'Q4': 4 };
      conditions.push(`(${alias}.year, ${alias}.quarter) BETWEEN ($${paramIndex++}, $${paramIndex++}) AND ($${paramIndex++}, $${paramIndex++})`);
      values.push(startParsed.year, quarterMap[startParsed.quarter!], endParsed.year, quarterMap[endParsed.quarter!]);
    }
  } else if (period.selection.dates) {
    const dates = period.selection.dates;
    const dateConditions: string[] = [];
    const sameYear = dates.length === 1;

    if (period.type === 'YEAR' && sameYear) {
      conditions.push(`${alias}.year = $${paramIndex++}`);
      values.push(parseDate(dates[0]).year);
    } else if (period.type === 'YEAR') {
      const years = dates.map(d => parseDate(d).year);
      if (years.length > 0) {
        conditions.push(`${alias}.year = ANY($${paramIndex++}::int[])`);
        values.push(years);
      }
    } else if (period.type === 'MONTH') {
      for (const date of dates) {
        const parsed = parseDate(date);
        dateConditions.push(`(${alias}.year = $${paramIndex++} AND ${alias}.month = $${paramIndex++})`);
        values.push(parsed.year, parsed.month);
      }
      if (dateConditions.length > 0) {
        conditions.push(`(${dateConditions.join(' OR ')})`);
      }
    } else if (period.type === 'QUARTER') {
      const quarterMap: { [key: string]: number } = { 'Q1': 1, 'Q2': 2, 'Q3': 3, 'Q4': 4 };
      for (const date of dates) {
        const parsed = parseDate(date);
        dateConditions.push(`(${alias}.year = $${paramIndex++} AND ${alias}.quarter = $${paramIndex++})`);
        values.push(parsed.year, quarterMap[parsed.quarter!]);
      }
      if (dateConditions.length > 0) {
        conditions.push(`(${dateConditions.join(' OR ')})`);
      }
    }
  }

  return {
    clause: conditions.length > 0 ? `(${conditions.join(' AND ')})` : '',
    values,
    nextParamIndex: paramIndex
  };
}

// Returns SQL fragments for selecting the correct amount column based on the requested period granularity.
// - itemColumn: raw column to use for per-item thresholds (non-aggregated)
// - sumExpression: aggregated SUM expression, COALESCE'd to 0 for safety
export function getAmountSqlFragments(
  period: ReportPeriodInput,
  alias: string = 'eli'
): { itemColumn: string; sumExpression: string } {
  if (period.type === 'MONTH') {
    return {
      itemColumn: `${alias}.monthly_amount`,
      sumExpression: `COALESCE(SUM(${alias}.monthly_amount), 0)`
    };
  }
  if (period.type === 'QUARTER') {
    return {
      itemColumn: `${alias}.quarterly_amount`,
      sumExpression: `COALESCE(SUM(${alias}.quarterly_amount), 0)`
    };
  }
  // YEAR
  return {
    itemColumn: `${alias}.ytd_amount`,
    sumExpression: `COALESCE(SUM(${alias}.ytd_amount), 0)`
  };
}

// Additional WHERE clause required by the schema for specific period granularities.
// - For YEAR queries, restrict to yearly rows (is_yearly = true)
// - For QUARTER queries, restrict to quarterly rows (is_quarterly = true)
// - For MONTH queries, no extra flag is needed
export function getPeriodFlagCondition(
  period: ReportPeriodInput,
  alias: string = 'eli'
): string {
  if (period.type === 'YEAR') return `${alias}.is_yearly = true`;
  if (period.type === 'QUARTER') return `${alias}.is_quarterly = true`;
  return '';
}

let eurRateByYear: Map<number, number> | null = null;
export function getEurRateMap(): Map<number, number> {
  if (!eurRateByYear) {
    const [exchange] = datasetRepository.getByIds(['exchange-rate-eur-ron']);
    eurRateByYear = new Map<number, number>();
    if (exchange) {
      const granularity =
        exchange.xAxis.granularity ??
        (exchange.xAxis.type === 'INTEGER' ? 'YEAR' : 'CATEGORY');
      if (granularity === 'YEAR') {
        for (const point of exchange.data) {
          const numericYear =
            typeof point.x === 'number' ? point.x : Number.parseInt(String(point.x), 10);
          if (Number.isFinite(numericYear)) {
            eurRateByYear.set(numericYear, point.y);
          }
        }
      }
    }
  }
  return eurRateByYear;
}
