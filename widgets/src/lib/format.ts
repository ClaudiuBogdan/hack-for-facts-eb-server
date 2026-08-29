/**
 * Romanian display formatting for MCP App widgets.
 *
 * Mirrors the client's `src/lib/utils.ts` conventions (ro-RO Intl formatters,
 * compact "K" → "mii" fixup, 'N/A' for missing values). Display-only — amounts
 * arrive as decimal strings from the server and are never recomputed here.
 */

const formatterCache = new Map<string, Intl.NumberFormat>();

const numberFormatter = (options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const key = JSON.stringify(options);
  let formatter = formatterCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat('ro-RO', options);
    formatterCache.set(key, formatter);
  }
  return formatter;
};

/** Compact notation's "K" is not Romanian — the site renders "mii". */
const fixCompactRomanian = (formatted: string): string => formatted.replace(/\sK$/, ' mii');

export const formatCurrency = (
  amount: string | number | null | undefined,
  options: { compact?: boolean; currency?: string } = {}
): string => {
  if (amount === null || amount === undefined || amount === '') return 'N/A';
  const numeric = typeof amount === 'number' ? amount : Number(amount);
  if (Number.isNaN(numeric)) return 'N/A';
  const formatted = numberFormatter({
    style: 'currency',
    currency: options.currency ?? 'RON',
    minimumFractionDigits: 0,
    maximumFractionDigits: options.compact === true ? 1 : 2,
    ...(options.compact === true && { notation: 'compact' as const }),
  }).format(numeric);
  return fixCompactRomanian(formatted);
};

export const formatNumber = (
  value: string | number | null | undefined,
  options: { compact?: boolean } = {}
): string => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return 'N/A';
  const formatted = numberFormatter({
    maximumFractionDigits: options.compact === true ? 1 : 2,
    ...(options.compact === true && { notation: 'compact' as const }),
  }).format(numeric);
  return fixCompactRomanian(formatted);
};

export const formatDate = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ro-RO', { year: 'numeric', month: 'short', day: 'numeric' });
};

/** Escape untrusted text for interpolation into innerHTML templates. */
export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
