import { describe, expect, it } from 'vitest';

import { resolveCaenDescriptions } from '@/modules/companies/core/caen-descriptions.js';

describe('revision-qualified CAEN descriptions', () => {
  it('keeps the exact known revision even when another revision has a different meaning', () => {
    expect(
      resolveCaenDescriptions('rev3', [
        { revision: 'rev1', label: 'Captarea, tratarea și distribuția apei' },
        {
          revision: 'rev3',
          label: 'Lucrări de construcții ale clădirilor rezidențiale și nerezidențiale',
        },
      ])
    ).toMatchObject({
      descriptionStatus: 'EXACT',
      label: 'Lucrări de construcții ale clădirilor rezidențiale și nerezidențiale',
      descriptions: [{ revision: 'rev3' }],
    });
  });

  it('describes transport without inventing a revision when catalog descriptions agree', () => {
    expect(
      resolveCaenDescriptions(null, [
        { revision: 'rev2', label: 'Transporturi rutiere de mărfuri' },
        { revision: 'rev3', label: 'Transporturi rutiere de mărfuri' },
      ])
    ).toMatchObject({
      descriptionStatus: 'CONSENSUS',
      label: 'Transporturi rutiere de mărfuri',
      descriptions: [{ revision: 'rev2' }, { revision: 'rev3' }],
    });
  });

  it('does not turn a code occurring in one catalog revision into a declared source revision', () => {
    expect(
      resolveCaenDescriptions(null, [
        { revision: 'rev3', label: 'Activități de realizare a soft-ului la comandă' },
      ])
    ).toMatchObject({
      descriptionStatus: 'CONSENSUS',
      label: 'Activități de realizare a soft-ului la comandă',
    });
  });

  it('retains conflicting meanings rather than choosing the newest revision', () => {
    const descriptions = [
      { revision: 'rev1', label: 'Transporturi aeriene după un grafic de transport' },
      { revision: 'rev3', label: 'Activități de realizare a soft-ului la comandă' },
    ];
    expect(resolveCaenDescriptions(null, descriptions)).toEqual({
      label: null,
      descriptionStatus: 'CONFLICT',
      descriptions,
    });
  });

  it('does not borrow a label for a known revision missing its catalog row', () => {
    expect(
      resolveCaenDescriptions('rev2', [{ revision: 'rev3', label: 'Altă activitate' }])
    ).toEqual({ label: null, descriptionStatus: 'MISSING', descriptions: [] });
  });

  it('keeps absent, blank and partially unnamed candidates unresolved', () => {
    expect(resolveCaenDescriptions(null, []).descriptionStatus).toBe('MISSING');
    expect(
      resolveCaenDescriptions('rev0', [{ revision: 'rev0', label: ' ' }]).descriptionStatus
    ).toBe('MISSING');
    expect(
      resolveCaenDescriptions(null, [
        { revision: 'rev0', label: null },
        { revision: 'rev2', label: 'Activitate' },
      ])
    ).toMatchObject({ label: null, descriptionStatus: 'CONFLICT' });
  });
});
