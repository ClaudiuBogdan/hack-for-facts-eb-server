/**
 * Wide CSV serializer for experimental map payloads.
 */

import type { GroupedSeriesMatrixRow } from '../../core/types.js';

function escapeCsvCell(value: string): string {
  const requiresQuoting =
    value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r');
  if (!requiresQuoting) {
    return value;
  }

  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function toCsvNumericCell(value: number | undefined): string {
  if (value === undefined) {
    return 'null';
  }

  return value.toString();
}

export function serializeWideMatrixCsv(
  seriesOrder: string[],
  rows: GroupedSeriesMatrixRow[]
): string {
  const header = ['siruta_code', ...seriesOrder].map((cell) => escapeCsvCell(cell)).join(',');

  if (rows.length === 0) {
    return header;
  }

  const csvRows = rows.map((row) => {
    const cells = [escapeCsvCell(row.sirutaCode)];

    for (const seriesId of seriesOrder) {
      const value = row.valuesBySeriesId.get(seriesId);
      cells.push(toCsvNumericCell(value));
    }

    return cells.join(',');
  });

  return [header, ...csvRows].join('\n');
}
