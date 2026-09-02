import { describe, expect, it } from 'vitest';

import {
  canonicalizeEndpoint,
  redactEndpoint,
  sameEndpoint,
} from '../../golden-master/endpoint.js';

describe('golden-master endpoint canonicalization', () => {
  it('treats host case, default ports, trailing slashes, fragments and userinfo as the same endpoint', () => {
    const base = 'http://localhost:3000/graphql';
    for (const alias of [
      'http://LOCALHOST:3000/graphql',
      'http://localhost:3000/graphql/',
      'http://localhost:3000/graphql#frag',
      'http://user:pw@localhost:3000/graphql',
      'http://localhost:3000//graphql/'.replace('//graphql', '/graphql'),
    ]) {
      expect(sameEndpoint(base, alias), alias).toBe(true);
    }
    expect(
      sameEndpoint('https://api.example.com:443/graphql', 'https://api.example.com/graphql')
    ).toBe(true);
    expect(
      sameEndpoint('http://api.example.com:80/graphql', 'http://api.example.com/graphql')
    ).toBe(true);
  });

  it('keeps different paths, non-loopback hosts, ports, schemes and query strings distinct', () => {
    expect(
      sameEndpoint('http://localhost:3000/graphql', 'http://localhost:3000/api/v1/graphql')
    ).toBe(false);
    expect(sameEndpoint('http://localhost:3000/graphql', 'http://127.0.0.1:3000/graphql')).toBe(
      true
    );
    expect(sameEndpoint('http://[::1]:3000/graphql', 'http://127.0.0.1:3000/graphql')).toBe(true);
    expect(sameEndpoint('http://localhost:3000/graphql', 'http://127.0.0.1:3001/graphql')).toBe(
      false
    );
    expect(sameEndpoint('http://localhost:3000/graphql', 'http://localhost:3001/graphql')).toBe(
      false
    );
    expect(sameEndpoint('http://localhost/graphql', 'https://localhost/graphql')).toBe(false);
    expect(sameEndpoint('http://localhost/graphql?a=1', 'http://localhost/graphql')).toBe(false);
  });

  it('rejects relative URLs and non-http schemes', () => {
    expect(() => canonicalizeEndpoint('/graphql')).toThrow(/Not an absolute URL/);
    expect(() => canonicalizeEndpoint('ftp://x/graphql')).toThrow(/Unsupported protocol/);
    expect(canonicalizeEndpoint('HTTP://Example.COM:80/graphql/')).toBe(
      'http://example.com/graphql'
    );
  });

  it('redacts userinfo for display and leaves everything else untouched', () => {
    expect(redactEndpoint('http://user:secret@localhost:3000/graphql')).toBe(
      'http://localhost:3000/graphql'
    );
    expect(redactEndpoint('http://localhost:3000/graphql')).toBe('http://localhost:3000/graphql');
    expect(redactEndpoint('inject:/graphql')).toBe('inject:/graphql');
    expect(() => canonicalizeEndpoint('ftp://u:p@x/graphql')).toThrow(/ftp:\/\/x\/graphql/);
  });
});
