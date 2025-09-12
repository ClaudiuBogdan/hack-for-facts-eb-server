import { NormalizationMode, PeriodDate, ReportPeriodInput } from "../../types";

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
    const sameYear = dates.length === 1

    if (period.type === 'YEAR' && sameYear) {
      conditions.push(`${alias}.year = $${paramIndex++}`);
      values.push(dates[0]);
    } else if (period.type === 'YEAR') {
      const years = dates.map(d => parseDate(d).year);
      conditions.push(`${alias}.year = ANY($${paramIndex++}::int[])`);
      values.push(years);
    } else if (period.type === 'MONTH') {
      for (const date of dates) {
        const parsed = parseDate(date);
        dateConditions.push(`(${alias}.year = $${paramIndex++} AND ${alias}.month = $${paramIndex++})`);
        values.push(parsed.year, parsed.month);
      }
      conditions.push(`(${dateConditions.join(' OR ')})`);
    } else if (period.type === 'QUARTER') {
      const quarterMap: { [key: string]: number } = { 'Q1': 1, 'Q2': 2, 'Q3': 3, 'Q4': 4 };
      for (const date of dates) {
        const parsed = parseDate(date);
        // TODO: fix this. not quarter column yet
        dateConditions.push(`(${alias}.year = $${paramIndex++} AND ${alias}.quarter = $${paramIndex++})`);
        values.push(parsed.year, quarterMap[parsed.quarter!]);
      }
      conditions.push(`(${dateConditions.join(' OR ')})`);
    }
  }

  return {
    clause: `(${conditions.join(' AND ')})`,
    values,
    nextParamIndex: paramIndex
  };
}