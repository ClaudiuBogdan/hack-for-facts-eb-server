import type { ServerResponse } from 'node:http';

export type CampaignAdminExportLocale = 'en' | 'ro';

export const CSV_UTF8_BOM = '\uFEFF';

function normalizeCsvText(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function escapeCsvCell(value: string): string {
  const needsQuoting =
    value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r');

  if (!needsQuoting) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsvCell(value: string | number | boolean | null | undefined): string {
  const normalized = value === null || value === undefined ? '' : normalizeCsvText(String(value));

  return escapeCsvCell(neutralizeSpreadsheetFormula(normalized));
}

export function toCsvRow(
  values: readonly (string | number | boolean | null | undefined)[]
): string {
  return values.map((value) => toCsvCell(value)).join(',');
}

export function detectCampaignAdminExportLocale(
  acceptLanguageHeader: string | undefined
): CampaignAdminExportLocale {
  if (acceptLanguageHeader?.toLowerCase().includes('ro') === true) {
    return 'ro';
  }

  return 'en';
}

export function toAbsoluteUrl(
  platformBaseUrl: string,
  pathOrUrl: string | null | undefined
): string {
  if (pathOrUrl === null || pathOrUrl === undefined || pathOrUrl.trim() === '') {
    return '';
  }

  if (platformBaseUrl.trim() === '') {
    return pathOrUrl;
  }

  try {
    return new URL(pathOrUrl, platformBaseUrl).toString();
  } catch {
    return pathOrUrl;
  }
}

export function buildCsvAttachmentFilename(prefix: string, now: Date = new Date()): string {
  const datePart = now.toISOString().slice(0, 10);
  return `${prefix}-${datePart}.csv`;
}

export function setCsvDownloadHeaders(input: {
  response: ServerResponse;
  filename: string;
  origin?: string | undefined;
}): void {
  input.response.statusCode = 200;
  input.response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  input.response.setHeader('Content-Disposition', `attachment; filename="${input.filename}"`);
  input.response.setHeader(
    'Cache-Control',
    'private, no-store, no-cache, must-revalidate, max-age=0'
  );
  input.response.setHeader('Pragma', 'no-cache');
  input.response.setHeader('Expires', '0');
  input.response.setHeader('Surrogate-Control', 'no-store');
  input.response.setHeader('CDN-Cache-Control', 'private, no-store, max-age=0');
  input.response.setHeader('Vary', 'Origin, Authorization, Cookie, Accept-Language');

  if (input.origin !== undefined && input.origin.trim() !== '') {
    input.response.setHeader('Access-Control-Allow-Origin', input.origin);
    input.response.setHeader('Access-Control-Allow-Credentials', 'true');
    input.response.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, Content-Type, Cache-Control, Pragma, Expires, Surrogate-Control, CDN-Cache-Control, Content-Length'
    );
  }
}

export async function writeToResponseStream(
  response: ServerResponse,
  chunk: string
): Promise<void> {
  if (response.write(chunk)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('error', onError);
      response.off('close', onClose);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Response stream closed before drain.'));
    };

    response.once('drain', onDrain);
    response.once('error', onError);
    response.once('close', onClose);
  });
}
