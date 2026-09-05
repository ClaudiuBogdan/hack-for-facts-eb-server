import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { observationViewRef } from '@/modules/ins-native/core/identity.js';
import {
  readInsSourcePage,
  type InsPublicationToken,
} from '@/modules/ins-native/core/source-page.js';
import { INS_PERIODICITIES } from '@/modules/ins-native/core/types.js';
import { periodPredicates } from '@/modules/ins-native/core/usecases.js';
import { makeInsMcpTools } from '@/modules/ins-native/shell/mcp/tools.js';

import { makeFakeRepo, POPTEST, DIMENSIONS } from './fake-repo.js';

const pins = [
  { dimensionIndex: 0, memberCode: '1' },
  { dimensionIndex: 1, memberCode: '105' },
  { dimensionIndex: 2, memberCode: '3075' },
  { dimensionIndex: 3, memberCode: '931' },
];
const publication: InsPublicationToken = {
  revisionId: '1',
  custodySha256: 'a'.repeat(64),
  transformContractSha256: 'b'.repeat(64),
};
const toolFor = (repo = makeFakeRepo()) =>
  makeInsMcpTools({ repo, clientBaseUrl: 'https://example.test' }).find(
    (t) => t.name === 'get_ins_series'
  )!;
const request = { datasetCode: 'POPTEST', sourcePins: pins };

describe('native MCP source pages', () => {
  it('returns exact source pairs, shared opaque IDs, metadata and nullable unknown counts', async () => {
    const repo = makeFakeRepo();
    const original = repo.listObservations;
    repo.listObservations = async (query) =>
      (await original(query)).map((page) => ({ ...page, totalCount: null }));
    const response = await toolFor(repo).handler({ ...request, limit: 2 });
    expect(response.ok).toBe(true);
    expect(response.items).toHaveLength(2);
    const rows = (await original(repo.factQueries[0]!))._unsafeUnwrap().nodes;
    expect(response.items?.map((item) => (item as { id: string }).id)).toEqual(
      rows.map(observationViewRef)
    );
    expect(response.items?.[0]).toMatchObject({
      datasetCode: 'POPTEST',
      value: rows[0]!.value,
      members: [
        { dimension: 'D0', code: '1' },
        { dimension: 'D1', code: '105' },
        { dimension: 'D2', code: '3075' },
        { dimension: 'D3', code: '931' },
      ],
    });
    expect(response.meta).toMatchObject({
      publication,
      descriptor: { ...POPTEST, dimensions: DIMENSIONS['POPTEST'] },
      offset: 0,
      limit: 2,
      totalCount: null,
      nextOffset: 2,
      hasMore: true,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });
  it('continues with unchanged publication and the same filters without duplicating rows', async () => {
    const tool = toolFor();
    const first = await tool.handler({ ...request, limit: 2 });
    const next = await tool.handler({
      ...request,
      limit: 2,
      offset: first.meta?.['nextOffset'],
      expectedPublication: first.meta?.['publication'],
    });
    expect(next.ok).toBe(true);
    expect(next.items).toHaveLength(1);
    expect(next.meta).toMatchObject({ nextOffset: null, hasMore: false, hasPreviousPage: true });
    expect(
      new Set(
        [...(first.items ?? []), ...(next.items ?? [])].map((item) => (item as { id: string }).id)
      ).size
    ).toBe(3);
  });
  it.each(['revisionId', 'custodySha256', 'transformContractSha256'] as const)(
    'rejects a changed %s before querying facts',
    async (field) => {
      const repo = makeFakeRepo();
      const response = await toolFor(repo).handler({
        ...request,
        offset: 1,
        expectedPublication: {
          ...publication,
          [field]: field === 'revisionId' ? '2' : 'f'.repeat(64),
        },
      });
      expect(response).toMatchObject({
        ok: false,
        errorType: 'ServiceUnavailable',
        meta: { reason: 'PUBLICATION_CHANGED', currentPublication: publication },
      });
      expect(repo.factQueries).toHaveLength(0);
    }
  );
  it('requires publication on continuation and validates the raw MCP boundary', async () => {
    const repo = makeFakeRepo();
    for (const extra of [
      { offset: 1 },
      { offset: -1 },
      { offset: 1.5 },
      { limit: 0 },
      { sourcePins: [null] },
      { sourcePins: [{ dimensionIndex: 7, memberCode: '1' }] },
      { sourcePins: [{ dimensionIndex: 0, memberCode: '-0' }] },
      {
        expectedPublication: {
          revisionId: '1',
          custodySha256: 'not-a-hash',
          transformContractSha256: 'b'.repeat(64),
        },
      },
    ]) {
      expect(await toolFor(repo).handler({ ...request, ...extra })).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
      });
    }
    expect(repo.factQueries).toHaveLength(0);
  });
  it('rejects mixing exact pins and either legacy list, including empty lists', async () => {
    for (const legacy of [{ classificationValueCodes: [] }, { classificationTypeCodes: [] }])
      expect(await toolFor().handler({ ...request, ...legacy })).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
      });
  });
  it('preserves the legacy TOTAL default and explicitly echoes its selection', async () => {
    const result = await toolFor().handler({ datasetCode: 'POPTEST', territoryCodes: ['54975'] });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.query).toMatchObject({ classificationValueCodes: ['TOTAL'] });
  });
  it('keeps canonical territory as an intersection and retains metadata on an empty result', async () => {
    const result = await toolFor().handler({ ...request, territoryCodes: ['1017'] });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.meta).toMatchObject({
      publication,
      descriptor: { code: 'POPTEST' },
      nextOffset: null,
    });
  });
  it('preserves unknown/not-loaded empty compatibility without inventing publication tokens', async () => {
    const repo = makeFakeRepo();
    const unknown = await toolFor(repo).handler({ datasetCode: 'UNKNOWN' });
    expect(unknown).toMatchObject({
      ok: true,
      items: [],
      meta: { descriptor: null, publication: null },
    });
    repo.getDataset = async () =>
      ok({
        ...POPTEST,
        publicationStatus: 'NOT_LOADED',
        dataStatus: 'CATALOG_ONLY',
        revisionId: null,
        custodySha256: null,
        transformContractSha256: null,
      });
    const notLoaded = await toolFor(repo).handler(request);
    expect(notLoaded).toMatchObject({
      ok: true,
      items: [],
      meta: { descriptor: { code: 'POPTEST', publicationStatus: 'NOT_LOADED' }, publication: null },
    });
    expect(repo.factQueries).toHaveLength(0);
  });
  it('rejects uncertified publications without silently returning empty observations', async () => {
    const repo = makeFakeRepo();
    repo.getDataset = async () =>
      ok({ ...POPTEST, publicationStatus: 'UNCERTIFIED', dataStatus: 'CATALOG_ONLY' });
    expect(await toolFor(repo).handler(request)).toMatchObject({
      ok: false,
      errorType: 'ServiceUnavailable',
    });
    expect(repo.factQueries).toHaveLength(0);
  });
  it('passes unit, cadence and null-only selections to the existing query unchanged', async () => {
    const repo = makeFakeRepo();
    const original = repo.listObservations;
    repo.listObservations = async (q) =>
      (await original({ ...q, hasValue: true })).map((page) => ({
        ...page,
        nodes: page.nodes.map((row) => ({ ...row, value: null, valueStatus: 'c' })),
      }));
    const result = await toolFor(repo).handler({
      ...request,
      unitCodes: ['9685'],
      periodicity: 'ANNUAL',
      hasValue: false,
    });
    expect(repo.factQueries[0]).toMatchObject({
      unitNomItemIds: [9685],
      periodicities: ['ANNUAL'],
    });
    expect(result.items?.[0]).toMatchObject({ value: null, valueStatus: 'c' });
    // The adapter passes false rather than treating it as absent.
    let received: unknown;
    repo.listObservations = async (q) => {
      received = q;
      return ok({ nodes: [], totalCount: 0, hasNextPage: false, hasPreviousPage: false });
    };
    await toolFor(repo).handler({ ...request, hasValue: false });
    expect(received).toMatchObject({ hasValue: false });
  });
  it('enters one outer snapshot and runs all dependent reads on the scoped repository', async () => {
    const outer = makeFakeRepo(),
      scoped = makeFakeRepo();
    let entered = 0;
    outer.withSnapshot = (fn) => {
      entered += 1;
      return fn(scoped);
    };
    outer.getDataset = async () =>
      err({ type: 'ServiceUnavailable', message: 'unscoped metadata read' });
    outer.listDimensions = async () =>
      err({ type: 'ServiceUnavailable', message: 'unscoped dimensions read' });
    expect(
      (
        await readInsSourcePage(outer, {
          datasetCode: 'POPTEST',
          filter: { sourcePins: pins },
          limit: 2,
          offset: 0,
        })
      ).isOk()
    ).toBe(true);
    expect(entered).toBe(1);
    expect(outer.factQueries).toHaveLength(0);
    expect(scoped.factQueries).toHaveLength(1);
  });
  it.each(INS_PERIODICITIES)(
    'admits the native %s cadence without inventing period token syntax',
    async (periodicity) => {
      expect(z.object(toolFor().inputShape).safeParse({ ...request, periodicity }).success).toBe(
        true
      );
      expect(periodPredicates({ periodicity })._unsafeUnwrap()).toEqual({
        periodicities: [periodicity],
      });
      if (!['ANNUAL', 'QUARTERLY', 'MONTHLY'].includes(periodicity))
        expect(periodPredicates({ periodicity, tokens: ['2024'] }).isErr()).toBe(true);
    }
  );
});
