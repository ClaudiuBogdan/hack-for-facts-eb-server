import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { validateDocument, validateLogicalKey } from '@/modules/user-data/core/planners/shared.js';

import { expectErr, expectOk } from '../../../support/result.js';
import { makeDefinition } from '../fixtures.js';

const permissiveSchema = Type.Record(Type.String(), Type.Unknown());

describe('planner shared limits', () => {
  it.each([
    ['payload byte cap', { value: 'long' }, 8, 'PayloadTooLarge'],
    ['annotation namespace byte cap', { status: 'approved' }, 10, 'PayloadTooLarge'],
    ['string length', { value: 'x'.repeat(16_385) }, 65_536, 'InvalidPayload'],
    [
      'collection size',
      { value: Array.from({ length: 257 }, () => null) },
      65_536,
      'InvalidPayload',
    ],
    [
      'depth',
      { value: Array.from({ length: 18 }).reduce<unknown>((value) => [value], null) },
      65_536,
      'InvalidPayload',
    ],
  ])('enforces %s', (_label, value, bytes, type) => {
    expect(expectErr(validateDocument(value, permissiveSchema, bytes)).type).toBe(type);
  });

  it('accepts a document within all limits', () => {
    expectOk(validateDocument({ value: ['safe'] }, permissiveSchema, 65_536));
  });

  it.each([
    ['pattern', makeDefinition({ pattern: /^allowed:/ }), 'wrong:key'],
    ['length', makeDefinition({ maxLength: 4 }), 'record:key'],
  ])('enforces logical-key %s', (_label, definition, key) => {
    expect(expectErr(validateLogicalKey(definition, key)).type).toBe('InvalidLogicalKey');
  });
});
