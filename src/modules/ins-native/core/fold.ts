/**
 * Diacritic-insensitive search folding — the SAME fold the loader applies to
 * `name_search` columns (NFD, strip combining marks, lower-case, collapse
 * whitespace), so a needle folded here matches a haystack folded there.
 * Handles both the comma-below (ș ț) and cedilla (ş ţ) forms.
 */
export const foldSearch = (input: string): string =>
  input.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Escape LIKE metacharacters so a user needle is matched literally. */
export const escapeLike = (input: string): string => input.replace(/[\\%_]/gu, (c) => `\\${c}`);
