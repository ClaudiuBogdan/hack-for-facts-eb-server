/**
 * The shipped free-text detector (`core/free-text-rule.ts`) as a ClickHouse
 * (RE2) expression: procurement-prod's ClickHouse form, check for check. The
 * legacy facts carry raw titles, so a title this expression hits is never
 * selected and never matches q (interim, until the CA lane feeds ClickHouse).
 *
 * Single-quoted SQL literals: every regex backslash is doubled once for the
 * literal (String.raw keeps the source readable).
 */

/** True (UInt8) when the rule withholds `column`'s text; false for NULL. */
export const clickhouseFreeTextHit = (column: string): string => {
  const t = `ifNull(${column}, '')`;
  const decomposed = `normalizeUTF8NFKD(${t})`;
  const f = String.raw`trimBoth(replaceRegexpAll(replaceRegexpAll(${decomposed}, '\\p{Mn}', ''), '[^\\p{L}\\p{N}]+', ' '))`;
  const checks = [
    // A1–A4 on the raw text.
    String.raw`match(${t}, '[0-9]{13}')`,
    String.raw`match(${t}, '(?i)[^\\s@]+@[^\\s@]+\\.[a-z]{2,}')`,
    String.raw`match(${t}, '(\\+40|\\b0)[ .-]?[237]([ .-]?[0-9]){8}')`,
    String.raw`match(${t}, '(?i)(^|[^\\p{L}\\p{N}_])(pfa|p\\.f\\.a\\.|i\\.i\\.|intreprindere individuala|întreprindere individuală)')`,
    // B1–B5 (B2 on the raw text).
    `position(${decomposed}, '@') > 0`,
    String.raw`match(replaceRegexpAll(${t}, '[0-9]', ''), '\\p{Nd}')`,
    String.raw`match(${f}, '[0-9]( ?[0-9]){12}')`,
    String.raw`arrayExists(x -> match(replaceAll(x, ' ', ''), '(0|40)[237][0-9]{8}'), extractAll(${f}, '[0-9]+(?: [0-9]+)*'))`,
    String.raw`match(${f}, '(?i)(^|[^\\p{L}])p ?f ?a([^\\p{L}]|$)|persoana ?fizica([^\\p{L}]|$)|ntreprinderea? ?(individ|famil)')`,
  ];
  return `(${checks.map((check) => `(${check})`).join(' OR ')})`;
};
