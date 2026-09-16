import { describe, expect, it } from 'vitest';

import {
  searchQueryProblem,
  searchRequestPolicy,
} from '@/modules/shared/core/filters/search-policy.js';

describe('search policy', () => {
  it('pins baseline behavior and enables every-word prefixes explicitly', () => {
    expect(searchRequestPolicy('mun sibiu')).toEqual({
      matchingStrategy: 'last',
      attributesToSearchOn: ['identifier_exact', 'identifiers', 'title', 'aliases'],
    });
    expect(searchRequestPolicy('munip sib', 'prefix-all')).toEqual({
      locales: ['ron'],
      matchingStrategy: 'all',
      attributesToSearchOn: [
        'identifier_exact',
        'identifiers',
        'title',
        'aliases',
        'name_prefixes',
      ],
    });
    expect(
      searchRequestPolicy('"municipiul sibiu" mun', 'prefix-all').attributesToSearchOn
    ).not.toContain('name_prefixes');
  });
  it('rejects ignored terms and malformed input instead of truncating', () => {
    expect(
      searchQueryProblem(
        'unu-doi trei patru cinci sase sapte opt noua zece unsprezece',
        'prefix-all'
      )
    ).toContain('10');
    expect(searchQueryProblem('"sibiu')).toContain('quoted');
    expect(searchQueryProblem('\u0000sibiu')).toContain('control');
    expect(searchQueryProblem('x'.repeat(2049))).toContain('2048');
    expect(searchQueryProblem('...')).toContain('name');
    expect(searchQueryProblem('sibiu -mun')).toContain('Negative');
    expect(searchQueryProblem('sibiu,-mun')).toContain('Negative');
    expect(searchQueryProblem('(-mun)')).toContain('Negative');
    expect(
      searchQueryProblem('iPhone XMLParser unu doi trei patru cinci sase', 'prefix-all')
    ).toBeUndefined();
    expect(
      searchQueryProblem('iPhone XMLParser unu doi trei patru cinci sase sapte', 'prefix-all')
    ).toContain('10');
    expect(searchQueryProblem('MUNICIPIUL SIBIU ١٢٣', 'prefix-all')).toBeUndefined();
    for (const q of ['munip sib', 'Legea 227/2015', 'Școala nr. 1 Iași', '"Sibiu" mun', '']) {
      expect(searchQueryProblem(q)).toBeUndefined();
    }
  });
});
