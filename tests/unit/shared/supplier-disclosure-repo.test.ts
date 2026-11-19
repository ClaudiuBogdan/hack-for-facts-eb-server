/**
 * Site-wide D6 — the supplier disclosure port and the flows decorator: off
 * means no query and no change; on, the public set comes from
 * supplier_privacy, is cached per data_as_of, and fails closed (absent table,
 * absent release, read error → empty). A non-public code's incoming
 * direct-acquisition flows are excluded; outgoing flows and public codes are
 * untouched.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeSupplierDisclosureRepo,
  withSupplierDisclosure,
} from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { FlowReadOptions, FlowsRepo, SupplierDisclosurePort } from '@/modules/shared/index.js';

interface World {
  tables: boolean;
  asOf: string | null;
  codes: string[];
  fail: boolean;
}

const build = (world: World, clock = { t: 0 }) => {
  const captured: CapturedQuery[] = [];
  const db = makeCapturingDb(captured, {
    respond: (text) => {
      if (world.fail && text.includes('supplier_privacy')) throw new Error('boom');
      if (text.includes('to_regclass')) return [{ release: world.tables, privacy: world.tables }];
      if (text.includes('max(data_as_of)')) return [{ as_of: world.asOf }];
      if (text.includes('where public is true')) return world.codes.map((code) => ({ code }));
      return [];
    },
  });
  return {
    captured,
    port: (enforced: boolean) => makeSupplierDisclosureRepo(db, enforced, () => clock.t),
  };
};

const codeLoads = (captured: CapturedQuery[]) =>
  captured.filter((query) => query.sql.includes('where public is true')).length;

describe('supplier disclosure port', () => {
  it('runs no query when not enforced', async () => {
    const { captured, port } = build({ tables: true, asOf: 'a', codes: ['1'], fail: false });
    expect((await port(false).publicSupplierCodes())._unsafeUnwrap().size).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it('loads the public codes and caches them per data_as_of', async () => {
    const world = {
      tables: true,
      asOf: '2026-11-18 03:10:00+00',
      codes: ['14399840'],
      fail: false,
    };
    const { captured, port } = build(world);
    const disclosure = port(true);
    expect([...(await disclosure.publicSupplierCodes())._unsafeUnwrap()]).toEqual(['14399840']);
    await disclosure.publicSupplierCodes();
    expect(codeLoads(captured)).toBe(1);
    world.asOf = '2026-11-19 03:10:00+00';
    world.codes = ['14399840', '4305857'];
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().size).toBe(2);
    expect(codeLoads(captured)).toBe(2);
  });

  it('the set carries the publication it was read from (null when none is readable)', async () => {
    const world = { tables: true, asOf: '2026-11-18T03:10:00.000000Z', codes: ['1'], fail: false };
    const { port } = build(world);
    expect((await port(true).publicSupplierCodes())._unsafeUnwrap().asOf).toBe(world.asOf);
    const absent = build({ ...world, tables: false });
    expect((await absent.port(true).publicSupplierCodes())._unsafeUnwrap().asOf).toBeNull();
    // D6 off: no publication applies.
    expect((await port(false).publicSupplierCodes())._unsafeUnwrap().asOf).toBeUndefined();
  });

  it.each([
    ['tables absent', { tables: false, asOf: 'a', codes: ['1'], fail: false }],
    ['no release row', { tables: true, asOf: null, codes: ['1'], fail: false }],
    ['a read error', { tables: true, asOf: 'a', codes: ['1'], fail: true }],
  ] as const)('fails closed with %s', async (_label, world) => {
    const { port } = build({ ...world, codes: [...world.codes] });
    expect((await port(true).publicSupplierCodes())._unsafeUnwrap().size).toBe(0);
  });

  it('withholds everyone once the grant is revoked, even with a warm set and the same data_as_of', async () => {
    const world = {
      tables: true,
      asOf: '2026-11-18 03:10:00+00',
      codes: ['14399840'],
      fail: false,
    };
    const { port } = build(world);
    const disclosure = port(true);
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().size).toBe(1);
    // A revoked SELECT leaves the catalog entry and data_as_of in place; the probe reports it.
    world.tables = false;
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().size).toBe(0);
  });

  it("a fresh read never joins a load already in flight (it may predate the caller's facts)", async () => {
    const world = {
      tables: true,
      asOf: '2026-11-18 03:10:00+00',
      codes: ['14399840'],
      fail: false,
    };
    const releaseReads = (captured: CapturedQuery[]) =>
      captured.filter((query) => query.sql.includes('max(data_as_of)')).length;
    const joined = build(world);
    const shared = joined.port(true);
    await Promise.all([shared.publicSupplierCodes(), shared.publicSupplierCodes()]);
    expect(releaseReads(joined.captured)).toBe(1);
    const fresh = build(world);
    const own = fresh.port(true);
    await Promise.all([own.publicSupplierCodes(), own.publicSupplierCodes({ fresh: true })]);
    expect(releaseReads(fresh.captured)).toBe(2);
  });

  it('a call after a publish never joins a load that read the publication before it', async () => {
    const before = '2026-11-18T03:10:00.000000Z';
    const after = '2026-11-19T03:10:00.000000Z';
    const world = { asOf: before, codes: ['14399840'] };
    const holder: { port?: SupplierDisclosurePort } = {};
    let later: Promise<unknown[]> | undefined;
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (text) => {
        if (text.includes('to_regclass')) return [{ release: true, privacy: true }];
        if (text.includes('max(data_as_of)')) return [{ as_of: world.asOf }];
        if (!text.includes('where public is true')) return [];
        const rows = world.codes.map((code) => ({ code }));
        if (later === undefined && holder.port !== undefined) {
          // The first load has read; the nightly publish withholds the supplier and
          // commits; then a status request and a supplier check arrive.
          world.asOf = after;
          world.codes = [];
          const port = holder.port;
          later = Promise.all([port.privacyAsOf(), port.publicSupplierCodes()]);
        }
        return rows;
      },
    });
    const disclosure = makeSupplierDisclosureRepo(db, true);
    holder.port = disclosure;
    expect((await disclosure.privacyAsOf())._unsafeUnwrap()).toBe(before);
    const [asOf, codes] = (await later) as [
      Awaited<ReturnType<SupplierDisclosurePort['privacyAsOf']>>,
      Awaited<ReturnType<SupplierDisclosurePort['publicSupplierCodes']>>,
    ];
    expect(asOf._unsafeUnwrap()).toBe(after);
    expect(codes._unsafeUnwrap().has('14399840')).toBe(false);
    // The two later calls arrived together and shared one load.
    expect(captured.filter((query) => query.sql.includes('max(data_as_of)'))).toHaveLength(2);
  });

  it('withholds everyone, and warns once, when a load reads an older publication than one served', async () => {
    const newer = '2026-11-19T03:10:00.000000Z';
    const older = '2026-11-18T03:10:00.000000Z';
    const world = { tables: true, asOf: newer, codes: ['14399840'], fail: false };
    const warnings: unknown[] = [];
    const captured: CapturedQuery[] = [];
    const db = makeCapturingDb(captured, {
      respond: (text) => {
        if (text.includes('to_regclass')) return [{ release: true, privacy: true }];
        if (text.includes('max(data_as_of)')) return [{ as_of: world.asOf }];
        if (text.includes('where public is true')) return world.codes.map((code) => ({ code }));
        return [];
      },
    });
    const disclosure = makeSupplierDisclosureRepo(db, true, () => 0, {
      warn: (obj) => warnings.push(obj),
    });
    expect((await disclosure.privacyAsOf())._unsafeUnwrap()).toBe(newer);
    // A replica behind the one that served `newer` still names the supplier.
    world.asOf = older;
    expect((await disclosure.privacyAsOf())._unsafeUnwrap()).toBeNull();
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().size).toBe(0);
    expect((await disclosure.publicSupplierCodes({ fresh: true }))._unsafeUnwrap().size).toBe(0);
    expect(warnings).toEqual([
      { component: 'supplier-disclosure', readAsOf: older, servedAsOf: newer },
    ]);
    // Caught up: served again, and the withheld answer was never cached as absent.
    world.asOf = newer;
    expect((await disclosure.privacyAsOf())._unsafeUnwrap()).toBe(newer);
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().has('14399840')).toBe(true);
  });

  it('re-probes an absent source only after its TTL', async () => {
    const world = { tables: false, asOf: 'a', codes: ['9'], fail: false };
    const clock = { t: 0 };
    const { port } = build(world, clock);
    const disclosure = port(true);
    await disclosure.publicSupplierCodes();
    world.tables = true;
    clock.t = 30_000;
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().size).toBe(0);
    clock.t = 61_000;
    expect((await disclosure.publicSupplierCodes())._unsafeUnwrap().has('9')).toBe(true);
  });
});

describe('flows decorator', () => {
  const recordingFlows = () => {
    const calls: { method: string; options: FlowReadOptions | undefined }[] = [];
    const flows = {
      getFlowSummary: (
        _c: string,
        direction: 'in' | 'out',
        _y?: boolean,
        options?: FlowReadOptions
      ) => {
        calls.push({ method: `summary:${direction}`, options });
        return Promise.resolve(
          ok({
            direction,
            count: 0,
            totalAmountRon: '0',
            minYear: null,
            maxYear: null,
            byFlowType: [],
            byYear: [],
          })
        );
      },
      getTopCounterparties: (
        _c: string,
        direction: 'in' | 'out',
        _l: number,
        options?: FlowReadOptions
      ) => {
        calls.push({ method: `top:${direction}`, options });
        return Promise.resolve(ok([]));
      },
    } as unknown as FlowsRepo;
    return { calls, flows };
  };
  const disclosure = (enforced: boolean, codes: string[]): SupplierDisclosurePort => ({
    enforced,
    privacyAsOf: () => Promise.resolve(ok(null)),
    publicSupplierCodes: () => Promise.resolve(ok(new Set(codes))),
  });

  it("withholds a non-public code's incoming direct-acquisition flows", async () => {
    const { calls, flows } = recordingFlows();
    const gated = withSupplierDisclosure(flows, disclosure(true, ['14399840']));
    await gated.getFlowSummary('30254716', 'in', true);
    await gated.getTopCounterparties('30254716', 'in', 10);
    expect(calls.map((c) => c.options?.excludeFlowTypes)).toEqual([
      ['direct_acquisition'],
      ['direct_acquisition'],
    ]);
  });

  it('leaves public codes, outgoing flows and the disabled rule unchanged', async () => {
    const { calls, flows } = recordingFlows();
    await withSupplierDisclosure(flows, disclosure(true, ['14399840'])).getFlowSummary(
      '14399840',
      'in'
    );
    await withSupplierDisclosure(flows, disclosure(true, [])).getFlowSummary('4305857', 'out');
    await withSupplierDisclosure(flows, disclosure(false, [])).getFlowSummary('30254716', 'in');
    expect(calls.map((c) => c.options?.excludeFlowTypes)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
