/**
 * Legal — the §5.2-C version-provenance note. Pure rendering, no ports.
 *
 * These assertions pin the exact user-facing Romanian strings, because the whole
 * point of the patch is that a text answer never reads as current law by omission.
 * The consolidation case asserts the FORWARD-COMPAT behaviour: the clause appears
 * from data alone, with no code change, once `version_kind='consolidare'` rows land.
 */

import { describe, expect, it } from 'vitest';

import {
  LEGAL_ORIGINAL_TEXT_CAVEAT,
  amendmentCountPhrase,
  versionProvenanceNote,
} from '@/modules/legal/core/provenance.js';
import { mapProvenance, type ProvenanceRow } from '@/modules/legal/shell/repo/mappers.js';

import type { LegalVersionProvenance } from '@/modules/legal/core/types.js';

/** The real canonical source_url for Legea nr. 227/2015 (document 171282). */
const SOURCE_URL = 'https://legislatie.just.ro/Public/DetaliiDocument/171282';

const prov = (over: Partial<LegalVersionProvenance> = {}): LegalVersionProvenance => ({
  versionKind: 'original',
  versionDate: '2015-09-10',
  sourceUrl: SOURCE_URL,
  amendedAfterPublication: 0,
  latestConsolidationDate: null,
  latestConsolidationLoaded: false,
  ...over,
});

describe('versionProvenanceNote', () => {
  it('an amended act names the date, the count, and where to verify', () => {
    expect(versionProvenanceNote(prov({ amendedAfterPublication: 295 }))).toBe(
      'text original din 2015-09-10; modificat de 295 de ori de atunci — verifică forma consolidată pe portal: https://legislatie.just.ro/Public/DetaliiDocument/171282'
    );
  });

  it('an unamended act takes the lighter form and no verify link', () => {
    expect(versionProvenanceNote(prov())).toBe(
      'text original din 2015-09-10; nicio modificare înregistrată'
    );
  });

  it('a pending consolidation adds its clause with no code change', () => {
    expect(
      versionProvenanceNote(
        prov({ amendedAfterPublication: 295, latestConsolidationDate: '2026-01-15' })
      )
    ).toBe(
      'text original din 2015-09-10; modificat de 295 de ori de atunci; ultima consolidare 2026-01-15 (neîncărcată încă) — verifică forma consolidată pe portal: https://legislatie.just.ro/Public/DetaliiDocument/171282'
    );
  });

  it('a LOADED consolidation drops the "neîncărcată încă" qualifier', () => {
    expect(
      versionProvenanceNote(
        prov({
          amendedAfterPublication: 295,
          latestConsolidationDate: '2026-01-15',
          latestConsolidationLoaded: true,
        })
      )
    ).toBe(
      'text original din 2015-09-10; modificat de 295 de ori de atunci; ultima consolidare 2026-01-15 — verifică forma consolidată pe portal: https://legislatie.just.ro/Public/DetaliiDocument/171282'
    );
  });

  it('never links back to our own act page — that serves the very text it warns about', () => {
    const note = versionProvenanceNote(prov({ amendedAfterPublication: 295 }));
    expect(note).toContain('legislatie.just.ro');
    expect(note).not.toContain('transparenta.eu');
  });

  it('a republication is never called "original" — that would misdate it by years', () => {
    expect(
      versionProvenanceNote(
        prov({
          versionKind: 'republicare',
          versionDate: '2011-06-15',
          amendedAfterPublication: 12,
        })
      )
    ).toContain('text republicat din 2011-06-15');
  });

  it('corp and stub-header are published forms, so they read as original', () => {
    expect(versionProvenanceNote(prov({ versionKind: 'corp' }))).toContain('text original');
    expect(versionProvenanceNote(prov({ versionKind: 'stub-header' }))).toContain('text original');
  });

  it('an act with no canonical document says so instead of inventing a version', () => {
    expect(versionProvenanceNote(prov({ versionKind: '', versionDate: null }))).toBe(
      'versiune necunoscută (dată necunoscută); nicio modificare înregistrată'
    );
  });

  it('omits the verify clause when there is no source_url to offer', () => {
    expect(versionProvenanceNote(prov({ amendedAfterPublication: 3, sourceUrl: null }))).toBe(
      'text original din 2015-09-10; modificat de 3 ori de atunci'
    );
  });

  it('the result-set caveat names the portal it sends readers to', () => {
    expect(LEGAL_ORIGINAL_TEXT_CAVEAT).toContain('nu garantează forma consolidată curentă');
    expect(LEGAL_ORIGINAL_TEXT_CAVEAT).toContain('legislatie.just.ro');
  });
});

/**
 * Romanian binds numerals to nouns with `de` from 20 up, but for compound
 * numerals the LAST TWO DIGITS decide — so 104 and 204 take no `de` even though
 * both exceed 20. All five corpus counts in that tail are pinned here.
 */
describe('versionProvenanceNote — Romanian numeral agreement', () => {
  const timesPhrase = (n: number): string => {
    const note = versionProvenanceNote(prov({ amendedAfterPublication: n }));
    return note.slice(note.indexOf('modificat de '), note.indexOf(' de atunci'));
  };

  it('exactly one amendment reads "o dată" — the corpus\'s most common case (4,771 acts)', () => {
    expect(versionProvenanceNote(prov({ amendedAfterPublication: 1 }))).toContain(
      'modificat o dată de atunci'
    );
  });

  it('2–19 bind the noun directly', () => {
    expect(timesPhrase(2)).toBe('modificat de 2 ori');
    expect(timesPhrase(12)).toBe('modificat de 12 ori');
    expect(timesPhrase(19)).toBe('modificat de 19 ori');
  });

  it('20 and up take "de"', () => {
    expect(timesPhrase(20)).toBe('modificat de 20 de ori');
    expect(timesPhrase(95)).toBe('modificat de 95 de ori');
    expect(timesPhrase(100)).toBe('modificat de 100 de ori');
    expect(timesPhrase(295)).toBe('modificat de 295 de ori');
    expect(timesPhrase(3183)).toBe('modificat de 3183 de ori');
  });

  it('the five real corpus counts whose last two digits fall in 1–19 drop "de"', () => {
    for (const n of [104, 107, 108, 109, 204]) {
      expect(timesPhrase(n)).toBe(`modificat de ${String(n)} ori`);
    }
  });

  it('the status badge phrase agrees too — it renders beside the note', () => {
    expect(amendmentCountPhrase(0)).toBe('nicio modificare înregistrată');
    expect(amendmentCountPhrase(1)).toBe('modificat de un act');
    expect(amendmentCountPhrase(12)).toBe('modificat de 12 acte');
    expect(amendmentCountPhrase(104)).toBe('modificat de 104 acte');
    expect(amendmentCountPhrase(295)).toBe('modificat de 295 de acte');
  });
});

/**
 * A later expression cannot claim the amendments came after it. The count is
 * every incoming modifica/completeaza edge on the ACT, unscoped by date, so
 * against a republication (763 canonical docs) or a directly-addressed
 * non-canonical document some edges may predate the text on screen.
 */
describe('versionProvenanceNote — only a published form may say "de atunci"', () => {
  for (const kind of ['original', 'corp', 'stub-header']) {
    it(`${kind} is the act as first published, so "de atunci" is fair`, () => {
      expect(
        versionProvenanceNote(prov({ versionKind: kind, amendedAfterPublication: 295 }))
      ).toContain('modificat de 295 de ori de atunci');
    });
  }

  for (const kind of ['republicare', 'consolidare', '']) {
    it(`${kind === '' ? 'unknown kind' : kind} reports operations on the act instead`, () => {
      const note = versionProvenanceNote(prov({ versionKind: kind, amendedAfterPublication: 295 }));
      expect(note).toContain('295 de operațiuni de modificare/completare înregistrate pentru act');
      expect(note).not.toContain('de atunci');
    });
  }

  it('the full republication note, pinned — real doc 105215 / act 4131 values', () => {
    expect(
      versionProvenanceNote(
        prov({
          versionKind: 'republicare',
          versionDate: '2009-04-29',
          sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocument/105215',
          amendedAfterPublication: 27,
        })
      )
    ).toBe(
      'text republicat din 2009-04-29; 27 de operațiuni de modificare/completare înregistrate pentru act — verifică forma consolidată pe portal: https://legislatie.just.ro/Public/DetaliiDocument/105215'
    );
  });

  it('the neutral wording keeps its singular', () => {
    expect(
      versionProvenanceNote(prov({ versionKind: 'republicare', amendedAfterPublication: 1 }))
    ).toContain('o operațiune de modificare/completare înregistrată pentru act');
  });

  it('zero reads the same either way', () => {
    expect(versionProvenanceNote(prov({ versionKind: 'republicare' }))).toContain(
      'nicio modificare înregistrată'
    );
  });

  it('the set caveat does not over-claim either', () => {
    expect(LEGAL_ORIGINAL_TEXT_CAVEAT).toContain('nu garantează forma consolidată curentă');
    expect(LEGAL_ORIGINAL_TEXT_CAVEAT).toContain('legislatie.just.ro');
  });
});

/**
 * The row → domain contract the two SQL statements feed. `not_fetched` is what
 * the consolidation-timeline lane writes for an anchor it has not downloaded.
 */
describe('mapProvenance — the shape both provenance statements return', () => {
  const row = (over: Partial<ProvenanceRow> = {}): ProvenanceRow => ({
    act_id: '66150',
    version_kind: 'corp',
    version_date: '2015-09-10',
    source_url: SOURCE_URL,
    amended: '295', // count(*) arrives as int8 → string
    consolidation_date: null,
    consolidation_status: null,
    ...over,
  });

  it('int8 counts arrive as strings and become numbers', () => {
    expect(mapProvenance(row()).amendedAfterPublication).toBe(295);
    expect(mapProvenance(row({ amended: 0 })).amendedAfterPublication).toBe(0);
  });

  it('no consolidation row today → absent, not "unloaded"', () => {
    const p = mapProvenance(row());
    expect(p.latestConsolidationDate).toBeNull();
    expect(p.latestConsolidationLoaded).toBe(false);
  });

  it("a 'not_fetched' anchor is present but NOT loaded", () => {
    const p = mapProvenance(
      row({ consolidation_date: '2026-01-15', consolidation_status: 'not_fetched' })
    );
    expect(p.latestConsolidationDate).toBe('2026-01-15');
    expect(p.latestConsolidationLoaded).toBe(false);
  });

  it('a fetched consolidation counts as loaded', () => {
    expect(
      mapProvenance(row({ consolidation_date: '2026-01-15', consolidation_status: 'accepted' }))
        .latestConsolidationLoaded
    ).toBe(true);
  });

  it('a null status is not something we can vouch for', () => {
    expect(
      mapProvenance(row({ consolidation_date: '2026-01-15', consolidation_status: null }))
        .latestConsolidationLoaded
    ).toBe(false);
  });

  it("a non-canonical document carries ITS own version, not the act's canonical one", () => {
    const p = mapProvenance(
      row({
        version_kind: 'republicare',
        version_date: '2009-04-29',
        source_url: 'https://legislatie.just.ro/Public/DetaliiDocument/105215',
        amended: '27',
      })
    );
    expect(p.versionKind).toBe('republicare');
    expect(p.versionDate).toBe('2009-04-29');
    expect(p.sourceUrl).toContain('105215');
    expect(versionProvenanceNote(p)).not.toContain('de atunci');
  });

  it('an act with no canonical document maps to the empty kind, never null', () => {
    expect(mapProvenance(row({ version_kind: null, version_date: null })).versionKind).toBe('');
  });
});
