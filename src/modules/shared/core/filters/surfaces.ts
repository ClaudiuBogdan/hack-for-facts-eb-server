/**
 * Shared Kernel — Filter surface derivers (foundation §14.2, §7.3).
 *
 * From one `CollectionFilterSpec` derive:
 *  - `toTypeBox(spec)`     → a TypeBox object schema for REST validation.
 *  - `toGraphQLInput(spec)` → GraphQL SDL `input` types for the filter + ranges.
 *
 * Both are pure (no Fastify/GraphQL runtime imports) so they unit-test cleanly
 * and the three surfaces are guaranteed to mirror the same field/op set.
 */

import { Type, type TObject, type TSchema } from '@sinclair/typebox';

import type { CollectionFilterSpec, FilterFieldSpec, FilterOp } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// TypeBox (REST)
// ─────────────────────────────────────────────────────────────────────────────

/** REST validation for a money value: a decimal STRING (never a float). */
const MONEY_PATTERN = '^-?\\d+(\\.\\d+)?$';

const scalarSchema = (field: FilterFieldSpec): TSchema => {
  switch (field.type) {
    case 'int':
      return Type.Integer();
    case 'number':
      return Type.Number();
    case 'money':
      return Type.String({ pattern: MONEY_PATTERN, description: 'Decimal money amount as a string.' });
    case 'bool':
      return Type.Boolean();
    case 'enum':
      return Type.Union((field.enumValues ?? []).map((v) => Type.Literal(v)));
    case 'date':
      return Type.String({ format: 'date' });
    case 'string':
    default:
      return Type.String();
  }
};

const opSchema = (field: FilterFieldSpec, op: FilterOp): TSchema => {
  const scalar = scalarSchema(field);
  switch (op) {
    case 'isNull':
      return Type.Boolean();
    case 'in':
      return Type.Array(scalar);
    case 'between':
      return Type.Object(
        { from: Type.Optional(scalar), to: Type.Optional(scalar) },
        { additionalProperties: false }
      );
    case 'contains':
      return field.column.arrayColumn === true ? Type.Array(Type.String()) : Type.String();
    case 'prefix':
      return Type.String();
    default:
      return scalar;
  }
};

const fieldFilterSchema = (field: FilterFieldSpec): TObject => {
  const props: Record<string, TSchema> = {};
  for (const op of field.ops) {
    props[op] = Type.Optional(opSchema(field, op));
  }
  return Type.Object(props, { additionalProperties: false });
};

/** Derive the REST TypeBox validation schema for a collection's filter input. */
export const toTypeBox = (spec: CollectionFilterSpec): TObject => {
  const props: Record<string, TSchema> = {};
  const excludeProps: Record<string, TSchema> = {};

  for (const field of spec.fields) {
    props[field.name] = Type.Optional(fieldFilterSchema(field));
    if (field.exclude === true) {
      excludeProps[field.name] = Type.Optional(fieldFilterSchema(field));
    }
  }
  if (Object.keys(excludeProps).length > 0) {
    props['exclude'] = Type.Optional(Type.Object(excludeProps, { additionalProperties: false }));
  }
  return Type.Object(props, { additionalProperties: false, $id: `${spec.collection}Filter` });
};

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL SDL
// ─────────────────────────────────────────────────────────────────────────────

const GQL_SCALAR: Record<FilterFieldSpec['type'], string> = {
  int: 'Int',
  number: 'Float',
  money: 'Money',
  bool: 'Boolean',
  enum: 'String',
  date: 'Date',
  string: 'String',
};

const pascal = (s: string): string =>
  s
    .split(/[^a-zA-Z0-9]+/u)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

const opFieldSdl = (field: FilterFieldSpec, op: FilterOp, rangeTypeName: string): string => {
  const scalar = GQL_SCALAR[field.type];
  switch (op) {
    case 'isNull':
      return '  isNull: Boolean';
    case 'in':
      return `  in: [${scalar}!]`;
    case 'between':
      return `  between: ${rangeTypeName}`;
    case 'contains':
      return field.column.arrayColumn === true ? '  contains: [String!]' : '  contains: String';
    case 'prefix':
      return '  prefix: String';
    default:
      return `  ${op}: ${scalar}`;
  }
};

/**
 * Derive GraphQL SDL for the collection's filter input type, its per-field
 * operator inputs, and any range inputs. Returns one SDL block. Type names are
 * `<Collection>Filter`, `<Collection><Field>Filter`, `<Collection><Field>Range`.
 */
export const toGraphQLInput = (spec: CollectionFilterSpec): string => {
  const prefix = pascal(spec.collection);
  const blocks: string[] = [];
  const fieldLines: string[] = [];
  const excludeLines: string[] = [];

  for (const field of spec.fields) {
    const fieldType = `${prefix}${pascal(field.name)}Filter`;
    const rangeType = `${prefix}${pascal(field.name)}Range`;

    if (field.ops.includes('between')) {
      const scalar = GQL_SCALAR[field.type];
      blocks.push(`input ${rangeType} {\n  from: ${scalar}\n  to: ${scalar}\n}`);
    }

    const opLines = field.ops.map((op) => opFieldSdl(field, op, rangeType));
    const desc = field.description !== undefined ? `  "${field.description}"\n` : '';
    blocks.push(`${desc}input ${fieldType} {\n${opLines.join('\n')}\n}`);

    fieldLines.push(`  ${field.name}: ${fieldType}`);
    if (field.exclude === true) excludeLines.push(`  ${field.name}: ${fieldType}`);
  }

  if (excludeLines.length > 0) {
    fieldLines.push(`  exclude: ${prefix}FilterExclude`);
    blocks.push(`input ${prefix}FilterExclude {\n${excludeLines.join('\n')}\n}`);
  }

  blocks.push(`input ${prefix}Filter {\n${fieldLines.join('\n')}\n}`);
  return blocks.join('\n\n');
};

/** The derived GraphQL filter input type name for a collection. */
export const graphqlFilterTypeName = (spec: CollectionFilterSpec): string =>
  `${pascal(spec.collection)}Filter`;
