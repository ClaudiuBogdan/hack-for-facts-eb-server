import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  getElectionContest,
  getElectionEvent,
  getElectionResult,
  listElectionCompetitors,
  listElectionContests,
  listElectionEvents,
  listElectionResultScopes,
  toEvent,
} from '@/modules/elections/core/usecases.js';

import {
  COUNCIL,
  EVENT,
  EVENT_RECORD,
  MAYOR,
  OCCURRENCE,
  makeFakeElectionsRepo,
} from '../../fixtures/elections/results.js';

import type { ElectionsRepository } from '@/modules/elections/index.js';

const deps = (repo: ElectionsRepository = makeFakeElectionsRepo()) => ({ repo });

describe('events', () => {
  it('reads family and year from the event key and keeps the occurrences', () => {
    const event = toEvent(EVENT_RECORD)._unsafeUnwrap();
    expect(event).toMatchObject({
      eventKey: EVENT,
      family: 'local',
      year: 2024,
      publication: { publicationId: '2', activatedAt: '2026-10-20T17:45:00.000Z' },
      occurrences: [{ occurrenceKey: OCCURRENCE, round: 'r1', kind: 'general', status: 'held' }],
    });
  });

  it('refuses an event key outside the grammar, an unknown round and a foreign occurrence', () => {
    expect(toEvent({ ...EVENT_RECORD, eventKey: 'local-2024' }).isErr()).toBe(true);
    const occurrence = EVENT_RECORD.occurrences[0];
    if (occurrence === undefined) throw new Error('fixture');
    expect(
      toEvent({ ...EVENT_RECORD, occurrences: [{ ...occurrence, round: 'tur2' }] }).isErr()
    ).toBe(true);
    expect(
      toEvent({
        ...EVENT_RECORD,
        occurrences: [{ ...occurrence, eventKey: 'ro:local:2020' }],
      }).isErr()
    ).toBe(true);
  });

  it('pages events and answers an absent event with null', async () => {
    const page = (await listElectionEvents(deps(), { page: 1, pageSize: 20 }))._unsafeUnwrap();
    expect(page).toMatchObject({ total: 1, hasMore: false, page: 1, pageSize: 20 });
    expect((await getElectionEvent(deps(), 'ro:local:2016'))._unsafeUnwrap()).toBeNull();
    expect((await getElectionEvent(deps(), EVENT))._unsafeUnwrap()).toEqual(
      toEvent(EVENT_RECORD)._unsafeUnwrap()
    );
  });
});

describe('input bounds', () => {
  it.each([
    [{ page: 0, pageSize: 20 }, 'page'],
    [{ page: 1, pageSize: 0 }, 'pageSize'],
    [{ page: 1, pageSize: 101 }, 'pageSize'],
    [{ page: Number.MAX_SAFE_INTEGER, pageSize: 100 }, 'page'],
  ])('refuses page %o before any read', async (request, field) => {
    const repo = makeFakeElectionsRepo();
    const result = await listElectionEvents(deps(repo), request);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    expect(repo.calls).toEqual([]);
  });

  it('refuses keys with control characters, an invalid office or scope and an unknown filter', async () => {
    const repo = makeFakeElectionsRepo();
    const page = { page: 1, pageSize: 20 };
    expect(
      (
        await listElectionContests(deps(repo), { occurrenceKey: 'a\u0000b', filter: {}, ...page })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'occurrenceKey' });
    expect(
      (
        await listElectionContests(deps(repo), {
          occurrenceKey: OCCURRENCE,
          filter: { offices: { eq: 'mayor' } },
          ...page,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'offices' });
    expect(
      (
        await listElectionContests(deps(repo), {
          occurrenceKey: OCCURRENCE,
          filter: { countyCodes: { in: ['cj'] } },
          ...page,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'countyCodes' });
    expect(
      (
        await getElectionResult(deps(repo), {
          occurrenceKey: OCCURRENCE,
          office: 'mayor; drop',
          scopeKey: 'national',
          contestKey: null,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'office' });
    expect(
      (
        await listElectionResultScopes(deps(repo), {
          occurrenceKey: OCCURRENCE,
          office: 'mayor',
          scopeType: 'sector' as 'uat',
          contestKey: null,
          ...page,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'scopeType' });
    expect(
      (
        await listElectionCompetitors(deps(repo), {
          eventKey: EVENT,
          filter: { kinds: { in: ['coalition'] } },
          ...page,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'kinds' });
    expect(repo.calls).toEqual([]);
  });
});

describe('contests and results', () => {
  it('computes each contest race at its jurisdiction', async () => {
    const contest = (await getElectionContest(deps(), MAYOR))._unsafeUnwrap();
    expect(contest?.race).toMatchObject({ marginVotes: '250', leader: { votes: '600' } });
    expect((await getElectionContest(deps(), `${MAYOR}x`))._unsafeUnwrap()).toBeNull();
  });

  it('answers an unpublished occurrence, contest or event as NotFound', async () => {
    const page = { page: 1, pageSize: 20 };
    expect(
      (
        await listElectionContests(deps(), { occurrenceKey: 'x', filter: {}, ...page })
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'NotFound', resource: 'occurrence' });
    expect(
      (
        await listElectionResultScopes(deps(), {
          occurrenceKey: OCCURRENCE,
          office: 'mayor',
          scopeType: 'uat',
          contestKey: COUNCIL,
          ...page,
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'NotFound' });
    expect(
      (
        await listElectionCompetitors(deps(), { eventKey: 'x', filter: {}, ...page })
      )._unsafeUnwrapErr()
    ).toMatchObject({ type: 'NotFound', resource: 'event' });
  });

  it('gives the contest its race only at its own jurisdiction', async () => {
    const own = (
      await getElectionResult(deps(), {
        occurrenceKey: OCCURRENCE,
        office: 'county_council',
        scopeKey: 'county:AB',
        contestKey: COUNCIL,
      })
    )._unsafeUnwrap();
    expect(own?.race).not.toBeNull();
    expect(own?.contest?.race).toEqual(own?.race);
    const child = (
      await getElectionResult(deps(), {
        occurrenceKey: OCCURRENCE,
        office: 'county_council',
        scopeKey: 'uat:1017',
        contestKey: COUNCIL,
      })
    )._unsafeUnwrap();
    expect(child?.race).not.toBeNull();
    expect(child?.contest?.race).toBeNull();
  });

  it('refuses a repository answer for another place or scope type', async () => {
    const base = makeFakeElectionsRepo();
    const wrongPlace: ElectionsRepository = {
      ...base,
      result: async (request) => {
        const found = await base.result({ ...request, scopeKey: 'uat:1017' });
        return found;
      },
    };
    expect(
      (
        await getElectionResult(deps(wrongPlace), {
          occurrenceKey: OCCURRENCE,
          office: 'county_council',
          scopeKey: 'county:AB',
          contestKey: COUNCIL,
        })
      ).isErr()
    ).toBe(true);
    const wrongType: ElectionsRepository = {
      ...base,
      listResultScopes: (request) => base.listResultScopes({ ...request, scopeType: 'uat' }),
    };
    expect(
      (
        await listElectionResultScopes(deps(wrongType), {
          occurrenceKey: OCCURRENCE,
          office: 'county_council',
          scopeType: 'county',
          contestKey: COUNCIL,
          page: 1,
          pageSize: 20,
        })
      ).isErr()
    ).toBe(true);
  });

  it('refuses an inexact count', async () => {
    const repo: ElectionsRepository = {
      ...makeFakeElectionsRepo(),
      listEvents: () => Promise.resolve(ok({ items: [], total: Number.NaN })),
    };
    expect((await listElectionEvents(deps(repo), { page: 1, pageSize: 20 })).isErr()).toBe(true);
  });
});
