/**
 * Shared Kernel — Romanian diacritic folding (foundation §15.7).
 *
 * `unaccent` is NOT installed in transparenta_prod and C-locale `lower()` does
 * not fold Ş/Ţ/Ă/Î/Â. Name search folds in TS rather than in SQL. Covers both
 * the cedilla (Ş Ţ) and comma-below (Ș Ț) Unicode forms. NFKD also strips
 * combining marks so accented Latin variants collapse too.
 */
const MAP: Record<string, string> = {
  ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't',
  Ă: 'a', Â: 'a', Î: 'i', Ș: 's', Ş: 's', Ț: 't', Ţ: 't',
};

export const foldDiacritics = (input: string): string => {
  let s = '';
  for (const ch of input) s += MAP[ch] ?? ch;
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .trim();
};
