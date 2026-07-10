/**
 * Kernel scalar handling, error→HTTP mapping, CUI normalization, diacritic
 * folding, and the safe-column-ref injection guard.
 */

import { describe, expect, it } from 'vitest';

import {
  GRAPHQL_ERROR_CODE,
  HTTP_STATUS,
  httpStatusFor,
  invalidInput,
  notFound,
} from '@/modules/shared/core/errors.js';
import { safeColumnRef } from '@/modules/shared/core/filters/composer.js';
import { normalizeCui } from '@/modules/shared/core/types.js';
import { BigIntScalar, MoneyScalar, CUIScalar } from '@/modules/shared/shell/graphql/scalars.js';
import { foldDiacritics } from '@/modules/shared/shell/repo/fold.js';

import { compileCondition } from './helpers.js';

describe('error → HTTP / GraphQL code', () => {
  it('maps every error type to a status', () => {
    expect(HTTP_STATUS).toEqual({
      NotFound: 404,
      InvalidInput: 400,
      Database: 500,
      Upstream: 502,
      ServiceUnavailable: 503,
      Timeout: 504,
    });
  });

  it('maps a NotFound error to 404', () => {
    expect(httpStatusFor(notFound('x'))).toBe(404);
    expect(GRAPHQL_ERROR_CODE[invalidInput('x').type]).toBe('INVALID_INPUT');
  });
});

describe('normalizeCui', () => {
  it('strips RO + non-digits', () => {
    expect(normalizeCui('RO 16054368')).toBe('16054368');
    expect(normalizeCui('ro16054368')).toBe('16054368');
  });
  it('returns null for empty', () => {
    expect(normalizeCui('RO')).toBeNull();
    expect(normalizeCui('---')).toBeNull();
  });
});

describe('scalars serialize precision-safe strings', () => {
  it('BigInt serializes a bigint to a string and rejects JS numbers', () => {
    expect(BigIntScalar.serialize('9007199254740993')).toBe('9007199254740993');
    expect(BigIntScalar.serialize(10n)).toBe('10');
    // A JS number could already have lost precision → reject (precision-strict).
    expect(() => BigIntScalar.serialize(42)).toThrow();
  });
  it('Money passes through a string, accepts null, rejects floats', () => {
    expect(MoneyScalar.serialize('33126174845.17')).toBe('33126174845.17');
    expect(MoneyScalar.serialize(null)).toBeNull();
    expect(() => MoneyScalar.serialize(1.23)).toThrow();
  });
  it('CUI serializes a string', () => {
    expect(CUIScalar.serialize('16054368')).toBe('16054368');
  });
});

describe('foldDiacritics (§15.7)', () => {
  it('folds RO diacritics (both cedilla and comma-below)', () => {
    expect(foldDiacritics('CONSTANȚA')).toBe('constanta');
    expect(foldDiacritics('CONSTANŢA')).toBe('constanta');
    expect(foldDiacritics('Iași')).toBe('iasi');
    expect(foldDiacritics('Brașov Întreprindere')).toBe('brasov intreprindere');
  });
});

describe('safeColumnRef injection guard', () => {
  it('emits a quoted alias.column ref', () => {
    const compiled = compileCondition(safeColumnRef({ alias: 'c', column: 'flow_year' }));
    expect(compiled.sql).toBe('"c"."flow_year"');
  });
  it('allows a whitelisted cast', () => {
    const compiled = compileCondition(
      safeColumnRef({ alias: 'o', column: 'siruta_code', cast: '::text' })
    );
    expect(compiled.sql).toContain('::text');
  });
  it('throws on a malformed identifier', () => {
    expect(() => safeColumnRef({ alias: 'c"; drop table x;--', column: 'y' })).toThrow();
    expect(() => safeColumnRef({ alias: 'c', column: 'y); delete from z' })).toThrow();
  });
  it('throws on a malformed cast', () => {
    expect(() =>
      safeColumnRef({ alias: 'c', column: 'y', cast: '::text; drop table x' })
    ).toThrow();
  });
});
