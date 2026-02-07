import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { deserialize, serialize } from '@/infra/cache/serialization.js';

describe('Cache Serialization', () => {
  describe('serialize', () => {
    it('serializes primitive values', () => {
      expect(serialize('hello')).toBe('"hello"');
      expect(serialize(42)).toBe('42');
      expect(serialize(true)).toBe('true');
      expect(serialize(null)).toBe('null');
    });

    it('serializes objects', () => {
      const obj = { name: 'test', value: 123 };
      const result = serialize(obj);
      expect(result).toBe('{"name":"test","value":123}');
    });

    it('serializes arrays', () => {
      const arr = [1, 2, 3];
      const result = serialize(arr);
      expect(result).toBe('[1,2,3]');
    });

    it('serializes Decimal values with marker', () => {
      const value = new Decimal('1234567890.123456789');
      const result = serialize({ amount: value });
      expect(result).toBe('{"amount":{"__decimal__":"1234567890.123456789"}}');
    });

    it('serializes Date values with marker', () => {
      const value = new Date('2024-01-02T03:04:05.000Z');
      const result = serialize({ at: value });
      expect(result).toBe('{"at":{"__date__":"2024-01-02T03:04:05.000Z"}}');
    });

    it('serializes nested Decimal values', () => {
      const data = {
        items: [{ price: new Decimal('99.99') }, { price: new Decimal('149.55') }],
        total: new Decimal('249.49'),
      };
      const result = serialize(data);
      // Verify the serialized format contains the decimal marker
      expect(result).toContain('__decimal__');
      expect(result).toContain('99.99');
      expect(result).toContain('149.55');
      expect(result).toContain('249.49');
    });
  });

  describe('deserialize', () => {
    it('deserializes primitive values', () => {
      expect(deserialize('"hello"')).toEqual({ ok: true, value: 'hello' });
      expect(deserialize('42')).toEqual({ ok: true, value: 42 });
      expect(deserialize('true')).toEqual({ ok: true, value: true });
      expect(deserialize('null')).toEqual({ ok: true, value: null });
    });

    it('deserializes objects', () => {
      const result = deserialize('{"name":"test","value":123}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ name: 'test', value: 123 });
      }
    });

    it('deserializes Decimal values from marker', () => {
      const json = '{"amount":{"__decimal__":"1234567890.123456789"}}';
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { amount: Decimal };
        expect(value.amount).toBeInstanceOf(Decimal);
        expect(value.amount.toString()).toBe('1234567890.123456789');
      }
    });

    it('deserializes Date values from marker', () => {
      const json = '{"at":{"__date__":"2024-01-02T03:04:05.000Z"}}';
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { at: Date };
        expect(value.at).toBeInstanceOf(Date);
        expect(value.at.toISOString()).toBe('2024-01-02T03:04:05.000Z');
      }
    });

    it('keeps objects with date marker plus extra fields as plain objects', () => {
      const json = '{"meta":{"__date__":"2024-01-02T03:04:05.000Z","source":"ins"}}';
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { meta: Record<string, string> };
        expect(value.meta).toEqual({
          __date__: '2024-01-02T03:04:05.000Z',
          source: 'ins',
        });
      }
    });

    it('deserializes nested Decimal values', () => {
      const json = '{"items":[{"price":{"__decimal__":"99.99"}}],"total":{"__decimal__":"249.49"}}';
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const value = result.value as { items: { price: Decimal }[]; total: Decimal };
        const firstItem = value.items[0];
        expect(firstItem).toBeDefined();
        expect(firstItem?.price).toBeInstanceOf(Decimal);
        expect(firstItem?.price.toString()).toBe('99.99');
        expect(value.total).toBeInstanceOf(Decimal);
        expect(value.total.toString()).toBe('249.49');
      }
    });

    it('returns error for invalid JSON', () => {
      const result = deserialize('not valid json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('SerializationError');
      }
    });

    it('roundtrips complex data with Decimals', () => {
      const original = {
        id: 'test-123',
        amounts: [new Decimal('100.00'), new Decimal('200.50')],
        nested: {
          value: new Decimal('999.999'),
        },
      };

      const json = serialize(original);
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value as typeof original;
        expect(restored.id).toBe('test-123');
        const amount0 = restored.amounts[0];
        const amount1 = restored.amounts[1];
        expect(amount0).toBeDefined();
        expect(amount1).toBeDefined();
        expect(amount0?.toString()).toBe('100');
        expect(amount1?.toString()).toBe('200.5');
        expect(restored.nested.value.toString()).toBe('999.999');
      }
    });

    it('roundtrips mixed Decimal and Date data', () => {
      const original = {
        measuredAt: new Date('2024-03-05T06:07:08.000Z'),
        amount: new Decimal('42.123'),
      };

      const json = serialize(original);
      const result = deserialize(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value as typeof original;
        expect(restored.measuredAt).toBeInstanceOf(Date);
        expect(restored.measuredAt.toISOString()).toBe('2024-03-05T06:07:08.000Z');
        expect(restored.amount).toBeInstanceOf(Decimal);
        expect(restored.amount.toString()).toBe('42.123');
      }
    });
  });
});
