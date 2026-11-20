/**
 * The shipped free-text detector (owner decision 2026-11-20), on
 * procurement-prod's synthetic test strings (each verified against the PG rule).
 */
import { describe, expect, it } from 'vitest';

import { isFreeTextWithheld, publicFreeText } from '@/modules/procurement/core/free-text-rule.js';

/** Synthetic strings and the check that withholds each. */
export const WITHHELD_SAMPLES: readonly (readonly [string, string])[] = [
  ['Achizitie 1234567890123 servicii', 'A1'],
  ['cod 1 2 3 4 5 6 7 8 9 0 1 2 3', 'B3'],
  ['cod 1.234.567.890.123', 'B3'],
  ['perioada 12.03.2024-15.04.2024', 'A1/B3'],
  ['contact office@example.ro', 'A2/B1'],
  ['scrieti la office＠example', 'B1 (fullwidth @)'],
  ['tel 0721 123 456', 'A3'],
  ['tel +40 721 123 456', 'A3'],
  ['tel 0040-721-123-456', 'B3'],
  ['tel 0721​123​456', 'B4 (zero-width spaces)'],
  ['Servicii PFA Exemplu', 'A4'],
  ['Servicii P.F.A. Exemplu', 'A4'],
  ['Persoană fizică autorizată Exemplu', 'B5'],
  ['Întreprindere individuală Exemplu', 'B5'],
  ['Intreprinderea familiala Exemplu', 'B5'],
  ['cod ١٢٣', 'B2 (Arabic-Indic)'],
  ['cod ১২৩', 'B2 (Bengali)'],
  ['cod ¹²³⁴⁵⁶⁷⁸⁹⁰¹²³', 'B3 (superscripts)'],
];

export const PUBLIC_SAMPLES: readonly string[] = [
  'Lucrari de reparatii acoperis Lot II',
  'Furnizare hartie A4 500 coli',
  'Servicii mentenanta 2024',
  'Contract nr. 123/2024 din 12.03.2024',
  'Suprafata 120 m² etapa II',
  'Achizitie laptop 15,6"',
  'Reparatii IF necesare',
  'Furnizare 0721 bucati',
  'Cod CPV 30192000-1',
];

describe('free-text rule', () => {
  it.each(WITHHELD_SAMPLES)('withholds %j (%s)', (text) => {
    expect(isFreeTextWithheld(text)).toBe(true);
    expect(publicFreeText(text)).toBeNull();
  });

  it.each(PUBLIC_SAMPLES)('serves %j', (text) => {
    expect(isFreeTextWithheld(text)).toBe(false);
    expect(publicFreeText(text)).toBe(text);
  });

  it('serves no text for an absent one', () => {
    expect(publicFreeText(null)).toBeNull();
  });
});
