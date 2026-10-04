/**
 * Shared Kernel — GraphQL scalars (foundation §6.2, §14.1, §14.8).
 *
 * Kernel-owned scalars, reused un-prefixed by every module (the §14.8 prefix
 * EXEMPTION). All serialize precision-safe strings (BigInt/Money never floats).
 * `Date`/`DateTime` pass through ISO strings; values arriving from pg are
 * already strings (int8 parser + numeric default + date/timestamptz text).
 */

import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';

import { GRAPHQL_ERROR_CODE } from '../../core/errors.js';

/** Lenient string scalar: accepts string/int input (used for text-y scalars). */
const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new GraphQLError(`expected a string-coercible scalar, got ${typeof value}`);
};

/**
 * The ONE inline-literal rule of the two string-scalar helpers below: a STRING
 * or INT literal keeps its exact text (no Number conversion, so integers above
 * 2^53 stay exact), explicit NULL stays null, and every other literal kind
 * (Boolean, Float, Enum, Object, List) is a typed input error. It used to be
 * silently null, which an optional argument then read as absent. The message
 * names only the scalar, never the literal. Runtime variables never reach this
 * function (GraphQL resolves them through parseValue).
 */
const stringOrIntLiteral =
  (name: string) =>
  (ast: ValueNode): string | null => {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) return ast.value;
    if (ast.kind === Kind.NULL) return null;
    throw new GraphQLError(`${name} literal must be a string or an integer`, {
      nodes: ast,
      extensions: { code: GRAPHQL_ERROR_CODE.InvalidInput, type: 'InvalidInput' },
    });
  };

const passthroughString = (name: string, description: string): GraphQLScalarType =>
  new GraphQLScalarType({
    name,
    description,
    serialize: (value) => asString(value),
    parseValue: (value) => asString(value),
    parseLiteral: stringOrIntLiteral(name),
  });

export const CUIScalar = passthroughString('CUI', 'Normalized Romanian fiscal code (digits only).');
export const SIRUTAScalar = passthroughString('SIRUTA', 'SIRUTA territorial code as text.');
export const DateScalar = passthroughString('Date', 'ISO 8601 date (YYYY-MM-DD).');
export const DateTimeScalar = passthroughString('DateTime', 'ISO 8601 datetime with timezone.');

/**
 * Precision-strict string scalar: a JS `number` is REJECTED on serialize (it
 * would already have lost precision before reaching here). Repos always provide
 * strings (int8 parser / numeric default), so this only catches bugs.
 */
const strictString = (name: string, description: string): GraphQLScalarType =>
  new GraphQLScalarType({
    name,
    description,
    serialize: (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'bigint') return value.toString();
      throw new GraphQLError(`${name} must be a string (got ${typeof value}); precision-unsafe`);
    },
    parseValue: (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') return value;
      throw new GraphQLError(`${name} input must be a string`);
    },
    parseLiteral: stringOrIntLiteral(name),
  });

export const BigIntScalar = strictString(
  'BigInt',
  'A 64-bit integer as a decimal string (precision-safe).'
);
export const MoneyScalar = strictString(
  'Money',
  'A numeric(18,2) money amount as a string (nullable, precision-safe).'
);

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.NULL:
        return null;
      default:
        return undefined;
    }
  },
});

/** Resolver map for the kernel scalars (merged into the root resolvers). */
export const scalarResolvers = {
  CUI: CUIScalar,
  SIRUTA: SIRUTAScalar,
  BigInt: BigIntScalar,
  Money: MoneyScalar,
  Date: DateScalar,
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
};

/** SDL declaring the kernel scalars (must be declared exactly once — §14.8). */
export const scalarTypeDefs = /* GraphQL */ `
  scalar CUI
  scalar SIRUTA
  scalar BigInt
  scalar Money
  scalar Date
  scalar DateTime
  scalar JSON
`;
