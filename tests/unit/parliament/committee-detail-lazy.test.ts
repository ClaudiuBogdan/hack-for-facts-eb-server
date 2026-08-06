/**
 * `ParliamentCommitteeDetail` is a LAZY type, and this pins the two properties
 * that makes it worth being one.
 *
 * The root used to assemble roster + bills + counts eagerly. Once the page pages
 * its documents, every "load more" re-enters `parliamentCommittee`, so each click
 * re-paid a roster, up to 500 bills (~78 KB of BILL_SELECT) and 3 statements the
 * client already held. Now each child costs exactly the client that selected it —
 * and `linkedBills` / `linkedBillsTotal` share ONE read, because a page and a
 * total measured by two statements can disagree about what the cap truncated.
 *
 * The memo lives on the parent object, so its lifetime is this committee in this
 * request. That matters for the error path too: a failing read must not be
 * cached into a second request, and must surface as a GraphQL error rather than
 * a silently empty list.
 */
import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';

import type { ApiError, CursorPage } from '@/modules/shared/index.js';

const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

const COMMITTEE = 'senate:a3ba8a6b-8b59-47b1-8932-0d30b5f7add1';

const committee = {
  committeeKey: COMMITTEE,
  chamber: 'senat',
  name: 'Comisia pentru test',
  legislature: null,
  committeeType: 'permanent',
  sourceUrl: 'https://www.senat.ro/EnumComisii.aspx',
};

interface Detail {
  readonly committeeKey: string;
  linkedOnce?: unknown;
}

const makeResolvers = (repo: Record<string, unknown>) =>
  makeParliamentResolvers({
    repo,
    transcriptSearch: null,
    legalActLoader: undefined,
    searchEngineUp: false,
    isApiKeyAuthorized: () => true,
  } as never) as {
    Query: { parliamentCommittee: (r: unknown, a: { committeeKey: string }) => Promise<unknown> };
    ParliamentCommitteeDetail: {
      members: (p: Detail) => Promise<unknown>;
      linkedBills: (p: Detail) => Promise<unknown>;
      linkedBillsTotal: (p: Detail) => Promise<unknown>;
      meetingsCount: (p: Detail) => Promise<unknown>;
      documents: (p: Detail, a: { first?: number; after?: string }) => Promise<unknown>;
    };
  };

describe('ParliamentCommitteeDetail — lazy children, one shared read', () => {
  it('the root reads the committee row and nothing else', async () => {
    const findCommittee = vi.fn(() => okp(committee));
    const listCommitteeRoster = vi.fn(() => okp([]));
    const listCommitteeLinkedBills = vi.fn(() => okp({ bills: [], total: 0 }));
    const committeeMeetingsCount = vi.fn(() => okp(0));
    const listCommitteeDocuments = vi.fn(() =>
      okp({ items: [], cursors: [], next: null, total: 0 })
    );

    const r = makeResolvers({
      findCommittee,
      listCommitteeRoster,
      listCommitteeLinkedBills,
      committeeMeetingsCount,
      listCommitteeDocuments,
    });
    const detail = await r.Query.parliamentCommittee({}, { committeeKey: COMMITTEE });

    expect(detail).toMatchObject({ committeeKey: COMMITTEE });
    expect(findCommittee).toHaveBeenCalledTimes(1);
    for (const child of [
      listCommitteeRoster,
      listCommitteeLinkedBills,
      committeeMeetingsCount,
      listCommitteeDocuments,
    ]) {
      expect(child).not.toHaveBeenCalled();
    }
  });

  it('serves linkedBills and linkedBillsTotal from ONE repo read', async () => {
    const listCommitteeLinkedBills = vi.fn(() =>
      okp({ bills: [{ billKey: '12760' } as never], total: 3_352 })
    );
    const r = makeResolvers({ findCommittee: () => okp(committee), listCommitteeLinkedBills });

    const parent: Detail = { committeeKey: COMMITTEE };
    const [bills, total] = await Promise.all([
      r.ParliamentCommitteeDetail.linkedBills(parent),
      r.ParliamentCommitteeDetail.linkedBillsTotal(parent),
    ]);

    expect(bills).toHaveLength(1);
    expect(total).toBe(3_352);
    // The load-bearing assertion: selecting BOTH fields is one statement, so the
    // total can never describe a different set than the page beside it.
    expect(listCommitteeLinkedBills).toHaveBeenCalledTimes(1);
  });

  it('memoizes per PARENT — a second committee pays its own read', async () => {
    const listCommitteeLinkedBills = vi.fn(() => okp({ bills: [], total: 0 }));
    const r = makeResolvers({ findCommittee: () => okp(committee), listCommitteeLinkedBills });

    const first: Detail = { committeeKey: COMMITTEE };
    const second: Detail = { committeeKey: 'cdep:2:2024:11' };
    await r.ParliamentCommitteeDetail.linkedBills(first);
    await r.ParliamentCommitteeDetail.linkedBillsTotal(first);
    await r.ParliamentCommitteeDetail.linkedBills(second);

    // Two committees, two reads — the memo must not be shared across parents, or
    // an aliased operation would serve one committee's bills under another's key.
    expect(listCommitteeLinkedBills).toHaveBeenCalledTimes(2);
    expect(listCommitteeLinkedBills.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      COMMITTEE,
      'cdep:2:2024:11',
    ]);
  });

  it('surfaces a failed child read as an error, never as an empty list', async () => {
    const failure: ApiError = { type: 'Database', message: 'boom' };
    const listCommitteeLinkedBills = vi.fn(() => Promise.resolve(err(failure)));
    const r = makeResolvers({ findCommittee: () => okp(committee), listCommitteeLinkedBills });

    const parent: Detail = { committeeKey: COMMITTEE };
    await expect(r.ParliamentCommitteeDetail.linkedBills(parent)).rejects.toThrow('boom');
    // The memoized REJECTION is reused within the request rather than retried —
    // both fields fail identically instead of one succeeding on a retry and
    // reporting a total the other could not produce.
    await expect(r.ParliamentCommitteeDetail.linkedBillsTotal(parent)).rejects.toThrow('boom');
    expect(listCommitteeLinkedBills).toHaveBeenCalledTimes(1);
  });

  it('builds the documents connection from the repo cursors, not a re-derivation', async () => {
    const page: CursorPage<never> & { total: number; cursors: readonly string[] } = {
      items: [
        { committeeDocumentKey: 'a', docDate: '2024-03-01' } as never,
        { committeeDocumentKey: 'b', docDate: null } as never,
      ],
      cursors: ['cursor-for-a', 'cursor-for-b'],
      next: 'cursor-for-b',
      total: 188,
    };
    const listCommitteeDocuments = vi.fn(() => okp(page));
    const r = makeResolvers({ findCommittee: () => okp(committee), listCommitteeDocuments });

    const conn = (await r.ParliamentCommitteeDetail.documents({ committeeKey: COMMITTEE }, {})) as {
      edges: readonly { cursor: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      total: number;
    };

    // Verbatim from the repo — these encode the sort key, and the sort key has
    // exactly one definition (the ordinal the database computed).
    expect(conn.edges.map((e) => e.cursor)).toEqual(['cursor-for-a', 'cursor-for-b']);
    expect(conn.pageInfo).toEqual({ hasNextPage: true, endCursor: 'cursor-for-b' });
    // The total rides with the page rather than costing a second statement.
    expect(conn.total).toBe(188);
    expect(listCommitteeDocuments).toHaveBeenCalledTimes(1);
  });
});
