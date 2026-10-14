/**
 * Shared Kernel — the spellings one county filter must match in the `entities`
 * index (NGO audit F-e).
 *
 * The index holds a county under several spellings: the platform's canonical
 * county-level names (`core.territories`: `MUNICIPIUL BUCUREȘTI`,
 * `CARAȘ-SEVERIN`), NGO rows from the core spine (`Caraș Severin`) and, until
 * the registry NGO documents are rebuilt, the registry's raw export
 * (`BUCURESTI`, `CARAS SEVERIN`, `DÂMBOVITA`). Clients send yet others
 * (`București`, `Caraș-Severin`). Meili string equality ignores case but not
 * diacritics or punctuation, so a single value matches only its own spelling:
 * `București` matched no Bucharest document at all.
 *
 * A requested county that names one of the 42 counties is widened to every
 * spelling of it — comma-below, cedilla and plain letters, dash or space, with
 * or without `MUNICIPIUL` — so the same documents match before and after the
 * rebuild. Anything else stays exactly as requested. Pure: no IO, no throw;
 * every value comes from the fixed list below or is the caller's own,
 * shape-validated county, and the filter builder quotes each one.
 */

/** The 42 public county-level names of `core.territories`, as the index's canonical documents carry them. */
export const CANONICAL_COUNTY_NAMES = [
  'ALBA',
  'ARAD',
  'ARGEȘ',
  'BACĂU',
  'BIHOR',
  'BISTRIȚA-NĂSĂUD',
  'BOTOȘANI',
  'BRAȘOV',
  'BRĂILA',
  'BUZĂU',
  'CARAȘ-SEVERIN',
  'CĂLĂRAȘI',
  'CLUJ',
  'CONSTANȚA',
  'COVASNA',
  'DÂMBOVIȚA',
  'DOLJ',
  'GALAȚI',
  'GIURGIU',
  'GORJ',
  'HARGHITA',
  'HUNEDOARA',
  'IALOMIȚA',
  'IAȘI',
  'ILFOV',
  'MARAMUREȘ',
  'MEHEDINȚI',
  'MUNICIPIUL BUCUREȘTI',
  'MUREȘ',
  'NEAMȚ',
  'OLT',
  'PRAHOVA',
  'SATU MARE',
  'SĂLAJ',
  'SIBIU',
  'SUCEAVA',
  'TELEORMAN',
  'TIMIȘ',
  'TULCEA',
  'VASLUI',
  'VÂLCEA',
  'VRANCEA',
] as const;

/** Each Romanian letter and the spellings it appears in: comma-below, cedilla, plain. */
const LETTER_FORMS: Readonly<Record<string, readonly string[]>> = {
  Ă: ['Ă', 'A'],
  Â: ['Â', 'A'],
  Î: ['Î', 'I'],
  Ș: ['Ș', 'Ş', 'S'],
  Ş: ['Ș', 'Ş', 'S'],
  Ț: ['Ț', 'Ţ', 'T'],
  Ţ: ['Ț', 'Ţ', 'T'],
};

const PREFIX = /^(MUNICIPIUL|JUDETUL) /u;

/**
 * The comparison key of a county spelling: composed, upper case, Romanian
 * letters to plain, dashes and runs of spaces to one space, a leading
 * `MUNICIPIUL` / `JUDEȚUL` dropped (`Municipiul București` → `BUCURESTI`,
 * `caraş-severin` → `CARAS SEVERIN`).
 */
export const countyKey = (county: string): string =>
  county
    .normalize('NFC')
    .toLocaleUpperCase('ro-RO')
    .replace(/[ĂÂÎȘŞȚŢ]/gu, (letter) => LETTER_FORMS[letter]?.at(-1) ?? letter)
    .replace(/[-\s]+/gu, ' ')
    .trim()
    .replace(PREFIX, '');

/**
 * Server compatibility recognition, separate from the projection's fold: a
 * request written with a whole-county prefix the index also holds (`JUD. CLUJ`,
 * `JUDEȚ CARAȘ-SEVERIN`) names that county. The key itself stays the scrapper's
 * (`countyKey`); only the request side drops these prefixes.
 */
const REQUEST_PREFIX = /^(JUD\.?|JUDET) +/u;
export const requestCountyKey = (county: string): string =>
  countyKey(county).replace(REQUEST_PREFIX, '');

/**
 * Separators between a county's words as the index writes them: dash, space,
 * and (observed in the 14 October census) `Caraș- Severin`, `Satu - Mare`.
 */
const WORD_SEPARATORS = ['-', ' ', '- ', ' - '] as const;
/**
 * Whole-county prefixes the index holds before a county (census: `JUD. ALBA`,
 * `JUD. SATU-MARE`, `JUDEȚ CARAȘ-SEVERIN`), written with a dash or a space between
 * the county's words.
 */
const COUNTY_PREFIXES = ['JUD. ', 'JUDEȚ '] as const;

/** Each letter's forms (comma-below, cedilla, plain) of one spelling. */
const letterForms = (spelling: string): readonly string[] => {
  let forms = [''];
  for (const letter of spelling) {
    const options = LETTER_FORMS[letter] ?? [letter];
    forms = forms.flatMap((start) => options.map((option) => start + option));
  }
  return forms;
};

/**
 * Every spelling of one canonical name the index can hold: each letter's forms;
 * the county's words joined by any observed separator; with and without its
 * `MUNICIPIUL ` prefix (which keeps its space); and after a whole-county prefix
 * (`JUD. `, `JUDEȚ `) with a dash or a space between the words.
 */
const spellingsOf = (canonical: string): readonly string[] => {
  const prefix = canonical.startsWith('MUNICIPIUL ') ? 'MUNICIPIUL ' : '';
  const name = canonical.slice(prefix.length);
  const join = (separator: string): string => name.replace(/[-\s]+/gu, separator);
  const out = new Set<string>();
  for (const separator of WORD_SEPARATORS) {
    for (const form of letterForms(join(separator))) {
      out.add(form);
      if (prefix !== '') out.add(prefix + form);
      if (separator === '-' || separator === ' ') {
        for (const countyPrefix of COUNTY_PREFIXES) out.add(countyPrefix + form);
      }
    }
  }
  // The canonical name first, the rest in a stable order.
  return [canonical, ...[...out].filter((form) => form !== canonical).sort()];
};

const SPELLINGS_BY_KEY: ReadonlyMap<string, readonly string[]> = new Map(
  CANONICAL_COUNTY_NAMES.map((name) => [countyKey(name), spellingsOf(name)])
);

const sameCase = (value: string): string => value.normalize('NFC').toLocaleUpperCase('ro-RO');

/**
 * The values a county filter matches. A request naming one of the 42 counties
 * matches every spelling of it, AND the request itself as written: a formerly
 * working exact request keeps every document it matched. A request naming none
 * (a compound value such as `… PUNCT DE LUCRU: …`, `NEDETERMINAT`, an unknown
 * name) matches exactly itself, as before. Deduplicated without case: Meili
 * compares case-insensitively.
 */
export const countyFilterValues = (county: string): readonly string[] => {
  const spellings = SPELLINGS_BY_KEY.get(requestCountyKey(county));
  if (spellings === undefined) return [county];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of [spellings[0] ?? county, county, ...spellings.slice(1)]) {
    const key = sameCase(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
};
