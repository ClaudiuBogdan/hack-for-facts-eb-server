import { describe, expect, it } from 'vitest';

import {
  EnvelopeError,
  LosslessNumber,
  parseEnvelope,
  parseLosslessJson,
  toPlain,
} from '../../golden-master/envelope.js';

describe('golden-master envelope: lossless parsing', () => {
  it('keeps every numeric token as its wire text', () => {
    const parsed = parseLosslessJson('{"a":9007199254740993,"b":1.10,"c":-0,"d":1e3}') as Record<
      string,
      LosslessNumber
    >;
    expect(parsed['a']).toBeInstanceOf(LosslessNumber);
    expect(parsed['a']?.source).toBe('9007199254740993');
    expect(parsed['a']?.toString()).toBe('9007199254740993');
    expect(parsed['b']?.source).toBe('1.10');
    expect(parsed['b']?.toString()).toBe('1.1');
    expect(parsed['d']?.toString()).toBe('1000');
  });

  it('distinguishes integers beyond 2^53 that native JSON.parse collapses', () => {
    const a = parseLosslessJson('9007199254740992') as LosslessNumber;
    const b = parseLosslessJson('9007199254740993') as LosslessNumber;
    expect(a.decimal.eq(b.decimal)).toBe(false);
    expect(a.toNumber()).toBe(b.toNumber());
  });

  it('rejects non-finite numeric tokens and non-JSON bodies', () => {
    expect(() => parseLosslessJson('{"a":1e999}')).toThrow(EnvelopeError);
    expect(() => parseLosslessJson('{"a":1e999}')).toThrow(/non-finite numeric token 1e999/);
    expect(() => parseLosslessJson('<html>')).toThrow(/body is not JSON/);
    expect(() => parseLosslessJson('{"a":NaN}')).toThrow(EnvelopeError);
  });

  it('converts back to plain JS numbers for the snapshot path', () => {
    const parsed = parseLosslessJson('{"nodes":[{"v":1.5,"n":null,"s":"x"}],"t":true}');
    expect(toPlain(parsed)).toEqual({ nodes: [{ v: 1.5, n: null, s: 'x' }], t: true });
  });
});

describe('golden-master envelope: shape validation', () => {
  it('accepts data-only, errors-only and data+errors bodies and records the final url', () => {
    const ok = parseEnvelope('{"data":{"a":1}}', 200, 'http://x/graphql');
    expect(ok.status).toBe(200);
    expect(ok.url).toBe('http://x/graphql');
    expect(ok.errors).toBeUndefined();
    expect(toPlain(ok.data)).toEqual({ a: 1 });

    const failed = parseEnvelope('{"errors":[{"message":"boom"}]}', 400, 'http://x/graphql');
    expect(failed.data).toBeUndefined();
    expect(failed.errors?.[0]?.message).toBe('boom');

    const partial = parseEnvelope(
      '{"data":null,"errors":[{"message":"e","path":["a",0]}],"extensions":{"x":1}}',
      200,
      'u'
    );
    expect(partial.data).toBeNull();
    expect(partial.errors).toHaveLength(1);
  });

  it("rejects Fastify's 404 body: it is JSON but not a GraphQL envelope", () => {
    const body = '{"message":"Route POST:/graphql not found","error":"Not Found","statusCode":404}';
    expect(() => parseEnvelope(body, 404, 'http://x/graphql')).toThrow(EnvelopeError);
    expect(() => parseEnvelope(body, 404, 'http://x/graphql')).toThrow(
      /HTTP 404 body is not a GraphQL envelope/
    );
    try {
      parseEnvelope(body, 404, 'u');
    } catch (error) {
      expect((error as EnvelopeError).kind).toBe('non-envelope');
    }
  });

  it('rejects bodies with neither data nor errors, and non-object data', () => {
    expect(() => parseEnvelope('{}', 200, 'u')).toThrow(/neither "data" nor "errors"/);
    expect(() => parseEnvelope('{"extensions":{}}', 200, 'u')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('{"data":[1]}', 200, 'u')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('{"data":"x"}', 200, 'u')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('{"errors":[{"msg":"no message"}]}', 400, 'u')).toThrow(
      EnvelopeError
    );
  });
});
