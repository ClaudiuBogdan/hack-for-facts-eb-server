import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGlobalSearch } from '@/modules/shared/core/usecases/global-search.js';
import { makeMeiliClient } from '@/modules/shared/shell/clients/meili-client.js';

// Explicit disposable-service URL only; no application credentials or live index.
const host = process.env['TEST_MEILI_URL'];
const index = `search_metadata_fixture_${String(process.pid)}`;
async function mutation(path: string, method: string, body?: unknown): Promise<void> {
  const response = await fetch(`${host ?? ''}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer search-disposable-test-master-key',
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  expect(response.ok).toBe(true);
  const task = (await response.json()) as { taskUid: number };
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await (
      await fetch(`${host ?? ''}/tasks/${String(task.taskUid)}`, {
        headers: { Authorization: 'Bearer search-disposable-test-master-key' },
      })
    ).json()) as { status: string };
    if (state.status === 'succeeded') return;
    if (state.status === 'failed') throw new Error('Fixture Meili task failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture Meili task timed out');
}

describe.skipIf(host === undefined || host === '')(
  'search metadata against a disposable Meilisearch',
  () => {
    beforeAll(async () => {
      await mutation('/indexes', 'POST', { uid: index, primaryKey: 'id' });
      await mutation('/indexes', 'POST', { uid: index + '_legacy', primaryKey: 'id' });
      await mutation(`/indexes/${index}_legacy/settings`, 'PATCH', {
        searchableAttributes: ['identifier_exact', 'identifiers', 'title', 'aliases'],
        filterableAttributes: ['privacy_class'],
      });
      await mutation(`/indexes/${index}/settings`, 'PATCH', {
        searchableAttributes: [
          'identifier_exact',
          'identifiers',
          'title',
          'aliases',
          'name_prefixes',
        ],
        displayedAttributes: [
          'id',
          'title',
          'doc_type',
          'roles',
          'privacy_class',
          'is_uat',
          'entity_tags',
        ],
        synonyms: { cj: ['consiliul judetean'] },
        filterableAttributes: ['privacy_class', 'doc_type', 'roles', 'is_uat', 'entity_tags'],
      });
      const base = {
        title: 'Sibiu',
        doc_type: 'organization',
        roles: ['organization'],
        privacy_class: 'public',
      };
      await mutation(`/indexes/${index}/documents`, 'POST', [
        {
          ...base,
          id: 'boundary',
          title: 'iPhone XMLParser unu doi trei patru cinci sase',
          is_uat: false,
          entity_tags: [],
        },
        {
          ...base,
          id: 'city',
          title: 'MUNICIPIUL SIBIU',
          name_prefixes: [
            'mun',
            'muni',
            'munic',
            'munici',
            'municip',
            'municipi',
            'municipiu',
            'sib',
            'sibi',
          ],
          is_uat: true,
          entity_tags: ['kind::uat', 'uat::municipality'],
        },
        {
          ...base,
          id: 'county',
          title: 'CONSILIUL JUDETEAN SIBIU',
          is_uat: false,
          entity_tags: ['kind::uat', 'uat::county'],
        },
        {
          ...base,
          id: 'school',
          is_uat: false,
          entity_tags: ['kind::school', 'sector::education'],
        },
        {
          ...base,
          id: 'hidden',
          privacy_class: 'restricted',
          is_uat: true,
          entity_tags: ['kind::uat'],
        },
        {
          ...base,
          id: 'company',
          title: 'MUN CONSULTING SRL SIBIU',
          doc_type: 'company',
          roles: ['company'],
          is_uat: null,
          entity_tags: [],
        },
      ]);
      // Separate completed tasks reproduce the Meili 1.41–1.42 dictionary bug:
      // modifying shared terms must not remove them from fuzzy matching.
      await mutation(`/indexes/${index}/documents`, 'POST', [
        {
          ...base,
          id: 'other-city',
          title: 'MUNICIPIUL CLUJ',
          name_prefixes: ['mun', 'muni', 'munic', 'munici', 'municip', 'municipi', 'municipiu'],
          is_uat: true,
          entity_tags: ['kind::uat', 'uat::municipality'],
        },
      ]);
    });
    afterAll(async () => {
      if (host !== undefined && host !== '') {
        await mutation(`/indexes/${index}`, 'DELETE');
        await mutation(`/indexes/${index}_legacy`, 'DELETE');
      }
    });
    const search = async (
      filters: Parameters<typeof makeGlobalSearch>[1],
      policy: 'baseline' | 'prefix-all' = 'baseline'
    ) =>
      (
        await makeGlobalSearch(
          {
            meiliClient: makeMeiliClient({
              host: host ?? '',
              apiKey: 'search-disposable-test-master-key',
            }),
            meiliIndexes: [index],
            searchPolicy: policy,
          },
          filters
        )
      )._unsafeUnwrap();
    it('requires all terms, expands earlier prefixes, and keeps quoted phrases on original names', async () => {
      for (const q of ['mun sibiu', 'munip sibiu', 'munip sib', 'sib mun']) {
        const result = await search({ q, isUat: true }, 'prefix-all');
        expect(result.degraded).toBe(false);
        expect(result.hits.map((hit) => hit.id)).toEqual(['city']);
        expect(result.hits[0]?.attrs).not.toHaveProperty('name_prefixes');
      }
      expect((await search({ q: 'mun nonexistentzz' }, 'prefix-all')).hits).toEqual([]);
      expect((await search({ q: '"mun sibiu"' }, 'prefix-all')).hits).toEqual([]);
      expect(
        (await search({ q: '"municipiul sibiu"' }, 'prefix-all')).hits.map((hit) => hit.id)
      ).toEqual(['city']);
      expect((await search({ q: 'cj sibiu' }, 'prefix-all')).hits.map((hit) => hit.id)).toEqual([
        'county',
      ]);
    });
    it('probes policy compatibility with the actual search-only request shape', async () => {
      const client = makeMeiliClient({
        host: host ?? '',
        apiKey: 'search-disposable-test-master-key',
        indexes: [index],
        policy: 'prefix-all',
      });
      expect((await client.healthCheck()).isOk()).toBe(true);
      expect(
        (
          await search({ q: 'iPhone XMLParser unu doi trei patru cinci sase' }, 'prefix-all')
        ).hits.map((hit) => hit.id)
      ).toEqual(['boundary']);
      const missing = makeMeiliClient({
        host: host ?? '',
        apiKey: 'search-disposable-test-master-key',
        indexes: [index + '_legacy'],
        policy: 'prefix-all',
      });
      expect((await missing.healthCheck()).isErr()).toBe(true);
    });
    it('filters before pagination, maps metadata, and excludes county councils/private data', async () => {
      const result = await search({ q: 'sibiu', isUat: true, limit: 1 });
      expect(result.degraded).toBe(false);
      expect(result.hits.map((hit) => hit.id)).toEqual(['city']);
      expect(result.hits[0]).toMatchObject({
        isUat: true,
        entityTags: ['kind::uat', 'uat::municipality'],
      });
    });
    it('uses OR within a facet, AND across facets and flat exclusions', async () => {
      const result = await search({
        q: 'sibiu',
        entityTags: ['kind::uat', 'kind::school', 'sector::education'],
      });
      expect(result.hits.map((hit) => hit.id)).toEqual(['school']);
      const excluded = await search({
        q: 'sibiu',
        entityTags: ['kind::uat'],
        excludeEntityTags: ['uat::county'],
      });
      expect(excluded.hits.map((hit) => hit.id)).toEqual(['city']);
    });
    it('keeps untagged identities when excluding a tag', async () => {
      const result = await search({ q: 'sibiu', excludeEntityTags: ['uat::county'] });
      expect(result.degraded).toBe(false);
      expect(result.hits.map((hit) => hit.id).sort()).toEqual(['city', 'company', 'school']);
    });
    it('distinguishes false from null, and never widens unknown tags', async () => {
      expect((await search({ q: 'sibiu', isUat: false })).hits.map((hit) => hit.id).sort()).toEqual(
        ['county', 'school']
      );
      const unknown = await search({ q: 'sibiu', entityTags: ['future::unknown'] });
      expect(unknown.degraded).toBe(false);
      expect(unknown.hits).toEqual([]);
    });
  }
);
