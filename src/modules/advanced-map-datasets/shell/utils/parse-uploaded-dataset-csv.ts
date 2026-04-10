import { parse } from 'csv-parse/sync';
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import type { AdvancedMapDatasetRow } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

interface SirutaRow {
  siruta_code: string;
}

export interface CsvValidationRowError {
  rowNumber: number;
  message: string;
}

export interface CsvValidationError {
  type: 'CsvValidationError';
  message: string;
  rows: CsvValidationRowError[];
}

export interface ParsedUploadedDatasetCsv {
  rows: AdvancedMapDatasetRow[];
}

function csvValidationError(message: string, rows: CsvValidationRowError[]): CsvValidationError {
  return {
    type: 'CsvValidationError',
    message,
    rows,
  };
}

async function loadNonCountySirutaCodes(db: BudgetDbClient): Promise<Set<string>> {
  const nonCountyCondition = sql<boolean>`NOT (
    u.siruta_code = u.county_code
    OR (u.county_code = 'B' AND u.siruta_code = '179132')
  )`;

  const rows: SirutaRow[] = await db
    .selectFrom('uats as u')
    .select(['u.siruta_code'])
    .where(nonCountyCondition)
    .orderBy('u.siruta_code', 'asc')
    .execute();

  return new Set(rows.map((row) => row.siruta_code.trim()).filter((value) => value !== ''));
}

function toTrimmedCell(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export async function parseUploadedDatasetCsv(
  budgetDb: BudgetDbClient,
  csvText: string
): Promise<Result<ParsedUploadedDatasetCsv, CsvValidationError>> {
  let records: unknown[];

  try {
    records = parse(csvText, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: false,
      trim: false,
    }) as unknown[];
  } catch (error) {
    return err(
      csvValidationError(error instanceof Error ? error.message : 'Failed to parse CSV', [
        { rowNumber: 1, message: 'Malformed CSV input' },
      ])
    );
  }

  if (records.length < 2) {
    return err(
      csvValidationError('CSV must include a header row and at least one data row', [
        {
          rowNumber: 1,
          message: 'CSV must include at least one data row',
        },
      ])
    );
  }

  const [rawHeader, ...rawRows] = records;
  const expectedHeader = ['siruta_code', 'value'];

  if (!Array.isArray(rawHeader) || rawHeader.length !== expectedHeader.length) {
    return err(
      csvValidationError(`CSV header must be exactly ${expectedHeader.join(',')}`, [
        {
          rowNumber: 1,
          message: `Header must contain exactly ${String(expectedHeader.length)} columns`,
        },
      ])
    );
  }

  const header = rawHeader.map((value) => toTrimmedCell(value));
  if (header.join(',') !== expectedHeader.join(',')) {
    return err(
      csvValidationError(`CSV header must be exactly ${expectedHeader.join(',')}`, [
        { rowNumber: 1, message: `Header must be ${expectedHeader.join(',')}` },
      ])
    );
  }

  const validSirutas = await loadNonCountySirutaCodes(budgetDb);
  const seenSirutas = new Set<string>();
  const validationErrors: CsvValidationRowError[] = [];
  const rows: AdvancedMapDatasetRow[] = [];

  rawRows.forEach((rawRow, index) => {
    const rowNumber = index + 2;

    if (!Array.isArray(rawRow) || rawRow.length !== expectedHeader.length) {
      validationErrors.push({
        rowNumber,
        message: `Row must contain exactly ${String(expectedHeader.length)} columns`,
      });
      return;
    }

    const sirutaCode = toTrimmedCell(rawRow[0]);
    const rawValue = toTrimmedCell(rawRow[1]);

    if (sirutaCode === '') {
      validationErrors.push({
        rowNumber,
        message: 'siruta_code cannot be empty',
      });
      return;
    }

    if (rawValue === '') {
      validationErrors.push({
        rowNumber,
        message: 'value cannot be empty',
      });
      return;
    }

    if (!validSirutas.has(sirutaCode)) {
      validationErrors.push({
        rowNumber,
        message: `Unknown or unsupported UAT siruta_code: ${sirutaCode}`,
      });
      return;
    }

    if (seenSirutas.has(sirutaCode)) {
      validationErrors.push({
        rowNumber,
        message: `Duplicate siruta_code: ${sirutaCode}`,
      });
      return;
    }

    try {
      const decimalValue = new Decimal(rawValue);
      if (!decimalValue.isFinite()) {
        throw new Error('Non-finite numeric value');
      }

      seenSirutas.add(sirutaCode);
      rows.push({
        sirutaCode,
        valueNumber: decimalValue.toString(),
        valueJson: null,
      });
    } catch {
      validationErrors.push({
        rowNumber,
        message: `Invalid numeric value: ${rawValue}`,
      });
    }
  });

  if (validationErrors.length > 0) {
    return err(csvValidationError('CSV validation failed', validationErrors));
  }

  return ok({ rows });
}
