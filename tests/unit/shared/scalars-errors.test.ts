/**
 * Kernel scalar handling, error→HTTP mapping, CUI normalization, diacritic
 * folding, and the safe-column-ref injection guard.
 */

import {
  GraphQLError,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  graphql,
  parseValue as parseValueNode,
  type GraphQLScalarType,
} from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  GRAPHQL_ERROR_CODE,
  HTTP_STATUS,
  httpStatusFor,
  invalidInput,
  notFound,
} from '@/modules/shared/core/errors.js';
import { normalizeCui } from '@/modules/shared/core/types.js';
import { safeColumnRef } from '@/modules/shared/shell/filters/composer.js';
import {
  BigIntScalar,
  CUIScalar,
  DateScalar,
  DateTimeScalar,
  JSONScalar,
  MoneyScalar,
  SIRUTAScalar,
} from '@/modules/shared/shell/graphql/scalars.js';
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

// ── string-scalar literals (A3 r1): STRING/INT/NULL kept, other kinds typed ──────

/** [field name, scalar, helper family]: the six string-scalar instances. */
const STRING_SCALARS = [
  ['bigint', BigIntScalar, 'strict'],
  ['money', MoneyScalar, 'strict'],
  ['cui', CUIScalar, 'lenient'],
  ['siruta', SIRUTAScalar, 'lenient'],
  ['date', DateScalar, 'lenient'],
  ['dateTime', DateTimeScalar, 'lenient'],
] as const;

const literal = (scalar: GraphQLScalarType, source: string): unknown =>
  scalar.parseLiteral(parseValueNode(source), undefined);

/** Unsupported literal kinds; the tokens must never appear in the error. */
const UNSUPPORTED = [
  'true',
  'false',
  '1.5',
  '1.0',
  '1e3',
  'SECRET_ENUM_TOKEN',
  '{ a: "SECRET_OBJECT_TOKEN" }',
  '["SECRET_LIST_TOKEN"]',
] as const;

describe('string scalars — inline literals: STRING/INT/NULL kept, other kinds INVALID_INPUT', () => {
  it.each(STRING_SCALARS)(
    '%s keeps STRING literal text exactly (no new lexical rule)',
    (_f, scalar) => {
      for (const text of [
        '9007199254740993',
        '007',
        '33126174845.17',
        '294276-12-31T23:59:59.999999+00 AD',
        'any text at all',
        '',
      ]) {
        expect(literal(scalar, JSON.stringify(text))).toBe(text);
      }
    }
  );

  it.each(STRING_SCALARS)(
    '%s keeps INT literal text exactly (no Number, no int8 fence)',
    (_f, scalar) => {
      for (const text of ['9007199254740993', '0', '-1', '99999999999999999999']) {
        expect(literal(scalar, text)).toBe(text);
      }
    }
  );

  it.each(STRING_SCALARS)('%s returns null for an explicit NULL literal', (_f, scalar) => {
    expect(literal(scalar, 'null')).toBeNull();
  });

  it.each(STRING_SCALARS)(
    '%s rejects Boolean/Float/Enum/Object/List literals, typed and unechoed',
    (_f, scalar) => {
      for (const source of UNSUPPORTED) {
        let thrown: unknown;
        try {
          literal(scalar, source);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, source).toBeInstanceOf(GraphQLError);
        const error = thrown as GraphQLError;
        expect(error.extensions['code'], source).toBe('INVALID_INPUT');
        expect(error.message).toBe(`${scalar.name} literal must be a string or an integer`);
        expect(error.message).not.toContain('SECRET');
      }
    }
  );
});

/** A minimal schema over the ACTUAL scalar instances, counting resolver calls. */
const scalarProbe = () => {
  const calls: { field: string; args: Record<string, unknown> }[] = [];
  const fields: Record<string, unknown> = {
    sibling: {
      type: GraphQLString,
      resolve: () => {
        calls.push({ field: 'sibling', args: {} });
        return 'ok';
      },
    },
  };
  for (const [name, scalar] of STRING_SCALARS) {
    fields[name] = {
      type: GraphQLString,
      args: { v: { type: scalar } },
      resolve: (_root: unknown, args: Record<string, unknown>) => {
        calls.push({ field: name, args });
        return 'ok';
      },
    };
  }
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: fields as never }),
  });
  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({
      schema,
      source,
      ...(variableValues !== undefined && { variableValues }),
    });
    return {
      data: result.data,
      errors: result.errors?.map((e) => ({ message: e.message, code: e.extensions['code'] })),
    };
  };
  return { calls, run };
};

describe('string scalars — real graphql() execution', () => {
  it.each(STRING_SCALARS)(
    '%s: an unsupported literal is INVALID_INPUT at validation; no resolver (not even a valid sibling) runs',
    async (field, scalar) => {
      for (const source of UNSUPPORTED) {
        const probe = scalarProbe();
        const res = await probe.run(`{ sibling ${field}(v: ${source}) }`);
        expect(res.errors, source).toEqual([
          {
            message: `${scalar.name} literal must be a string or an integer`,
            code: 'INVALID_INPUT',
          },
        ]);
        expect(res.data).toBeUndefined();
        expect(probe.calls).toEqual([]);
        expect(JSON.stringify(res)).not.toContain('SECRET');
      }
    }
  );

  it.each(STRING_SCALARS)(
    '%s: an unsupported literal as a variable DEFAULT is INVALID_INPUT',
    async (field, scalar) => {
      const probe = scalarProbe();
      const res = await probe.run(`query ($v: ${scalar.name} = true) { ${field}(v: $v) }`);
      expect(res.errors?.map((e) => e.code)).toEqual(['INVALID_INPUT']);
      expect(probe.calls).toEqual([]);
    }
  );

  it.each(STRING_SCALARS)(
    '%s: STRING/INT literals keep exact text, NULL is null, omission is absent',
    async (field) => {
      const probe = scalarProbe();
      await probe.run(
        `{ a: ${field}(v: "9007199254740993") b: ${field}(v: 9007199254740993) c: ${field}(v: -1) d: ${field}(v: null) e: ${field} }`
      );
      expect(probe.calls.map((c) => c.args)).toEqual([
        { v: '9007199254740993' },
        { v: '9007199254740993' },
        { v: '-1' },
        { v: null },
        {},
      ]);
    }
  );

  it.each(STRING_SCALARS)(
    '%s: runtime variables keep their existing rules',
    async (field, scalar, family) => {
      const query = `query ($v: ${scalar.name}) { ${field}(v: $v) }`;
      const probe = scalarProbe();
      await probe.run(query, { v: '007' });
      await probe.run(query, { v: null });
      await probe.run(query, {});
      expect(probe.calls.map((c) => c.args)).toEqual([{ v: '007' }, { v: null }, {}]);
      const numeric = scalarProbe();
      const res = await numeric.run(query, { v: 5 });
      if (family === 'lenient') {
        // Unchanged: lenient helpers stringify a numeric runtime variable.
        expect(res.errors).toBeUndefined();
        expect(numeric.calls.map((c) => c.args)).toEqual([{ v: '5' }]);
      } else {
        // Unchanged: strict BigInt/Money reject a numeric runtime variable.
        expect(res.errors).toHaveLength(1);
        expect(numeric.calls).toEqual([]);
      }
    }
  );
});

describe('scalar serialization and JSON stay unchanged', () => {
  it('lenient helpers serialize strings and numbers as text; strict ones keep rejecting numbers', () => {
    for (const scalar of [CUIScalar, SIRUTAScalar, DateScalar, DateTimeScalar]) {
      expect(scalar.serialize('294276-12-31T23:59:59.999999+00 AD')).toBe(
        '294276-12-31T23:59:59.999999+00 AD'
      );
      expect(scalar.serialize(5)).toBe('5');
      expect(scalar.serialize(null)).toBeNull();
    }
    for (const scalar of [BigIntScalar, MoneyScalar]) {
      expect(scalar.serialize('9007199254740993')).toBe('9007199254740993');
      expect(scalar.serialize(9007199254740993n)).toBe('9007199254740993');
      expect(() => scalar.serialize(5)).toThrow();
    }
  });

  it('JSON keeps its literal and value behavior', () => {
    expect(literal(JSONScalar, 'true')).toBe(true);
    expect(literal(JSONScalar, '1.5')).toBe(1.5);
    expect(literal(JSONScalar, '"x"')).toBe('x');
    expect(literal(JSONScalar, '3')).toBe(3);
    expect(literal(JSONScalar, 'null')).toBeNull();
    expect(literal(JSONScalar, '{ a: 1 }')).toBeUndefined();
    expect(literal(JSONScalar, '[1]')).toBeUndefined();
    const value = { a: [1, 'b'] };
    expect(JSONScalar.parseValue(value)).toBe(value);
    expect(JSONScalar.serialize(value)).toBe(value);
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
