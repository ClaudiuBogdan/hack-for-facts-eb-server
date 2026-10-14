/**
 * The ONE source qualified for a reported county view: the `aep-local-2020`
 * edition's county rows of the publisher's mayor-results file
 * (`pv_final_cntry_p.csv`). A scoped read of the production rows matched every
 * one of its 20,244 cells (raw value, numeric value, source label, source row)
 * against the hash-pinned original file on 2026-10-14, with all of them public.
 * Every other edition, office, scope, file or publication stays unavailable.
 *
 * What it is: values as the file reports them, per county electoral
 * circumscription. What it is not: a verified, final, current or canonical
 * result. Stored classifier fields (grain, metric roles, canonical office,
 * result status) are not read, and the `voturi`/`mandate` columns are not
 * relabelled as list votes, seats, mayoralties, winners or elected people.
 *
 * The file is complete, so a report is served whole or not at all: each county
 * row has exactly the 12 admitted statement cells and 234 competitor labels,
 * each label with one `voturi` and one `mandate` cell, every one a canonical
 * non-negative integer. When any of them cannot be served (withheld, not
 * reviewed, not public, not loaded), the report is unavailable; that says
 * nothing about the publisher's file. A duplicated or corrupt cell is a fault.
 */

/** Read predicates of the qualified carrier. The pointers are never served. */
export const COUNTY_SOURCE = {
  electionKey: 'aep-local-2020',
  office: 'mayor',
  scopeType: 'county',
  sourceResourceId: 'local:a1c73906c6c3425fa483cb7c',
  sourceFileId: '88',
  sourceFileSha256: 'aa7fa46554bee238ad70ce3f401d959c7b243f4c9a37564a2161cd201658ffea',
  /** The loader's package for these rows: their `attrs.packageName` and their map family. */
  packageName: 'aep-local-2020',
  acceptedMapStatus: 'human_accepted',
  /** The file's `county_nce` of the Municipiul București circumscription. */
  bucharestScopeKey: '42',
  /**
   * Unique competitor labels per county row of the file, each with one `voturi`
   * and one `mandate` cell: measured from the qualified file (42 rows × 234
   * labels = 9,828 cells per column), not a threshold.
   */
  competitorLabels: 234,
} as const;

/**
 * A served cell: canonical non-negative decimal integer text (no sign, no
 * leading zero, no scale or padding). The same pattern binds the SQL integrity
 * aggregate and the usecase.
 */
export const COUNT_CELL_PATTERN = '^(0|[1-9][0-9]*)$';

/**
 * The file's statement columns admitted for this view, in the publisher
 * legend's order, labelled with the legend's own text. `e` (ballots received)
 * and `f` (unused and cancelled ballots) are excluded: their map review is open.
 */
export const COUNTY_SOURCE_STATEMENT = [
  {
    code: 'a',
    label:
      'numarul total al alegatorilor prevazut in listele electorale existente in sectia de votare',
  },
  { code: 'a1', label: 'numarul total al alegatorilor potrivit listei electorale permanente' },
  {
    code: 'a2',
    label: 'numarul total al alegatorilor potrivit copiei de pe lista electorala complementara',
  },
  { code: 'a3', label: 'numarul total al alegatorilor potrivit listelor electorale suplimentare' },
  { code: 'a4', label: 'numarul total al alegatorilor in cazul carora s-a folosit urna speciala' },
  {
    code: 'b',
    label:
      'numarul total al alegatorilor care s-au prezentat la urne, inscrisi in listele electorale existente in sectia de votare',
  },
  {
    code: 'b1',
    label:
      'numarul total al alegatorilor care s-au prezentat la urne, inscrisi in lista electorala permanenta',
  },
  {
    code: 'b2',
    label:
      'numarul total al alegatorilor care s-au prezentat la urne, inscrisi in copia de pe lista electorala complementara',
  },
  {
    code: 'b3',
    label:
      'numarul total al alegatorilor care s-au prezentat la urne, inscrisi in listele electorale suplimentare',
  },
  {
    code: 'b4',
    label:
      'numarul total al alegatorilor care s-au prezentat la urne, in cazul carora s-a folosit urna speciala',
  },
  { code: 'c', label: 'numarul total al voturilor valabil exprimate' },
  { code: 'd', label: 'numarul voturilor nule' },
] as const;

export const COUNTY_SOURCE_STATEMENT_CODES: readonly string[] = COUNTY_SOURCE_STATEMENT.map(
  (cell) => cell.code
);

/** The file's per-competitor columns (`<label>-voturi`, `<label>-mandate`). */
export const COUNTY_SOURCE_COMPETITOR_METRICS = ['voturi', 'mandate'] as const;

/**
 * Public provenance of the same bytes (the publisher's data.gov.ro resource).
 * Citing it is not an offer to open the stored copy, which stays restricted.
 */
export const COUNTY_SOURCE_CITATION = {
  title: 'Rezultatele pentru funcția de primar, data 27 septembrie 2020',
  url: 'https://data.gov.ro/dataset/a9ac2859-b244-479b-a3ab-dd077999babb/resource/dd5512c1-7f6f-4f90-9008-6b68553973b6/download/pv_final_cntry_p.csv',
  /** The election date the title reports; not a publication or snapshot date. */
  reportedElectionDate: '2020-09-27',
  /** When the original file was downloaded and its hash verified. */
  sourceFileVerifiedOn: '2026-10-07',
  /** When every stored value was compared with that file and found exact. */
  valuesComparedOn: '2026-10-14',
} as const;

export const COUNTY_SOURCE_NOTICE =
  'Values as reported in the publisher’s mayor-results file for one county electoral circumscription, compared cell for cell with the original file and served only complete: a report missing any of its cells is withheld whole, which says nothing about the file. voturi and mandate are the file’s own columns: not certified results, seats, winners or elected people. Not verified as final or current; per-row publisher versions are not carried. Not combined with other editions or later publications.';

export const BUCHAREST_SCOPE_NOTE =
  'The file’s Municipiul București circumscription row, as reported. General-mayor results are published separately and are not part of it.';
