import { describe, expect, it } from 'vitest';

import {
  isMeaningfulDerivedContractTitle,
  resolveContractDisplayTitle,
} from '@/modules/procurement/core/contract-display-title.js';

const procedure = {
  title: 'Furnizare gaze naturale pentru sediile administrative',
  sourceUrl: 'https://example.test/procedure',
};

describe('contract display title', () => {
  it('keeps the native title and its source as authoritative', () => {
    expect(
      resolveContractDisplayTitle('  Titlu din contract  ', 'https://example.test/contract', {
        matchedAwards: [{ title: 'Titlu din atribuire', sourceUrl: 'https://example.test/award' }],
        procedure,
      })
    ).toEqual({
      text: 'Titlu din contract',
      source: 'native',
      sourceUrl: 'https://example.test/contract',
    });
  });

  it('uses a meaningful matched award before the procedure', () => {
    expect(
      resolveContractDisplayTitle(null, null, {
        matchedAwards: [
          { title: 'Contract', sourceUrl: 'https://example.test/generic' },
          {
            title: 'Furnizare gaze naturale - lot 2',
            sourceUrl: 'https://example.test/award',
          },
        ],
        procedure,
      })
    ).toEqual({
      text: 'Furnizare gaze naturale - lot 2',
      source: 'matched_award',
      sourceUrl: 'https://example.test/award',
    });
  });

  it('falls back to a meaningful procedure title', () => {
    expect(
      resolveContractDisplayTitle('  ', null, {
        matchedAwards: [{ title: 'Acord-cadru', sourceUrl: null }],
        procedure,
      })
    ).toEqual({
      text: procedure.title,
      source: 'procedure',
      sourceUrl: procedure.sourceUrl,
    });
  });

  it('uses the procedure when meaningful award observations disagree', () => {
    expect(
      resolveContractDisplayTitle(null, null, {
        matchedAwards: [
          { title: 'Furnizare medicamente lot 1', sourceUrl: 'https://example.test/award/1' },
          { title: 'Furnizare medicamente lot 2', sourceUrl: 'https://example.test/award/2' },
        ],
        procedure,
      })
    ).toEqual({
      text: procedure.title,
      source: 'procedure',
      sourceUrl: procedure.sourceUrl,
    });
  });

  it('selects equivalent award observations deterministically', () => {
    expect(
      resolveContractDisplayTitle(null, null, {
        matchedAwards: [
          { title: 'FURNIZARE ȘI INSTALARE', sourceUrl: 'https://example.test/award/latest' },
          { title: 'furnizare si instalare', sourceUrl: 'https://example.test/award/older' },
        ],
        procedure,
      })
    ).toEqual({
      text: 'FURNIZARE ȘI INSTALARE',
      source: 'matched_award',
      sourceUrl: 'https://example.test/award/latest',
    });
  });

  it('does not invent a title when all derived candidates are generic', () => {
    expect(
      resolveContractDisplayTitle(null, null, {
        matchedAwards: [{ title: 'CONTRACT SUBSECVENT NR. 12', sourceUrl: null }],
        procedure: { title: 'Acord cadru', sourceUrl: null },
      })
    ).toBeNull();
  });

  it('normalizes generic headings but keeps descriptive continuations', () => {
    expect(isMeaningfulDerivedContractTitle('Contract subsecvent de furnizare medicamente')).toBe(
      true
    );
    for (const generic of [
      ' Contract ',
      'CONTRACT NR. 12/2025',
      'Contract subsecvent',
      'Contract subsecvent nr. 12',
      'Acord-cadru',
      'ACORD CADRU NUMĂRUL 3',
    ]) {
      expect(isMeaningfulDerivedContractTitle(generic)).toBe(false);
    }
  });
});
