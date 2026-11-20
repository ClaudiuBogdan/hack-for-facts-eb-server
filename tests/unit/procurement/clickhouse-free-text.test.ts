/**
 * The ClickHouse form of the shipped free-text rule, pinned check by check to
 * procurement-prod's ClickHouse text (20 Nov), written out here independently
 * of the builder: dropping or altering one check fails this test. (Its
 * behaviour was verified on the live ClickHouse against the 27 test strings
 * and 314,993 distinct titles; this test pins the text that was verified.)
 */
import { describe, expect, it } from 'vitest';

import { clickhouseFreeTextHit } from '@/modules/procurement/shell/repo/clickhouse-free-text.js';

const t = "ifNull(title, '')";
const f = String.raw`trimBoth(replaceRegexpAll(replaceRegexpAll(normalizeUTF8NFKD(ifNull(title, '')), '\\p{Mn}', ''), '[^\\p{L}\\p{N}]+', ' '))`;

/** Each check as the SQL literal ClickHouse receives (backslashes doubled once). */
const CHECKS: readonly (readonly [string, string])[] = [
  [
    'G',
    String.raw`match(${t}, '[^\\x{0}-\\x{7FF}\\x{1E00}-\\x{1EFF}\\x{2000}-\\x{2BFF}\\x{E000}-\\x{F8FF}\\x{FB00}-\\x{FFFF}\\x{1F000}-\\x{1FAFF}]')`,
  ],
  ['A1', String.raw`match(${t}, '[0-9]{13}')`],
  ['A2', String.raw`match(${t}, '(?i)[^\\s@]+@[^\\s@]+\\.[a-z]{2,}')`],
  ['A3', String.raw`match(${t}, '(\\+40|\\b0)[ .-]?[237]([ .-]?[0-9]){8}')`],
  [
    'A4',
    String.raw`match(${t}, '(?i)(^|[^\\p{L}\\p{N}_])(pfa|p\\.f\\.a\\.|i\\.i\\.|intreprindere individuala|întreprindere individuală)')`,
  ],
  ['B1', `position(normalizeUTF8NFKD(${t}), '@') > 0`],
  ['B2', String.raw`match(replaceRegexpAll(${t}, '[0-9]', ''), '\\p{Nd}')`],
  ['B3', String.raw`match(${f}, '[0-9]( ?[0-9]){12}')`],
  [
    'B4',
    String.raw`arrayExists(x -> match(replaceAll(x, ' ', ''), '(0|40)[237][0-9]{8}'), extractAll(${f}, '[0-9]+(?: [0-9]+)*'))`,
  ],
  [
    'B5',
    String.raw`match(${f}, '(?i)(^|[^\\p{L}])p ?f ?a([^\\p{L}]|$)|persoana ?fizica([^\\p{L}]|$)|ntreprinderea? ?(individ|famil)')`,
  ],
];

describe('ClickHouse free-text rule', () => {
  it('is exactly the guard and the nine checks, OR-ed', () => {
    expect(clickhouseFreeTextHit('title')).toBe(
      `(${CHECKS.map(([, check]) => `(${check})`).join(' OR ')})`
    );
  });
});
