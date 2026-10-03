import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { sql } from 'kysely';
import { ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { budgetApprovedTotals } from '@/modules/budget/core/national/usecases.js';
import { makeBudgetModule, type FactorSource } from '@/modules/budget/index.js';
import { makeNationalApprovedReader } from '@/modules/budget/shell/repo/national-approved-repo.js';
import { makeNationalExecutionReader } from '@/modules/budget/shell/repo/national-execution-repo.js';
import {
  makeNationalReadPort,
  makeNationalResponseCache,
  nationalDbError,
  parseInheritedTransactionTimeout,
  type NationalAbandonedRead,
  type NationalRun,
} from '@/modules/budget/shell/repo/national-read-port.js';
import {
  baseTypeDefs,
  mergeGraphqlSlices,
  scalarResolvers,
  type ApiError,
  type ContributorRegistry,
} from '@/modules/shared/index.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';
import { makeSourceWorld } from '../../fixtures/national-budget/source-world.js';
import { makeTimedDb, toSqlDmy } from '../../fixtures/national-budget/timed-driver.js';

import type { NationalReadTx } from '@/modules/budget/core/national/ports.js';

interface StatementTx {
  read(): Promise<Result<string, ApiError>>;
}

/** A reader that issues `count` source statements (each one budgeted by the port). */
const statements =
  (count: number) =>
  (run: NationalRun): NationalReadTx => {
    const tx: StatementTx = {
      read: async () => {
        for (let index = 0; index < count; index++) await run(sql`select ${index} as n`);
        return ok('read');
      },
    };
    return tx as unknown as NationalReadTx;
  };

/** Statements, then `waitMs` of projection work before returning. */
const statementsThenWork =
  (count: number, waitMs: number) =>
  (run: NationalRun): NationalReadTx => {
    const tx: StatementTx = {
      read: async () => {
        for (let index = 0; index < count; index++) await run(sql`select ${index} as n`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return ok('read');
      },
    };
    return tx as unknown as NationalReadTx;
  };

const work = (tx: NationalReadTx): Promise<Result<string, ApiError>> =>
  (tx as unknown as StatementTx).read();

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The setup's read of the inherited setting, labelled for sequence assertions. */
const SETTINGS = 'read inherited transaction_timeout';
const isSettings = (q: string): boolean => q.includes('pg_catalog.pg_settings');
const sqlOf = (timed: ReturnType<typeof makeTimedDb>): string[] =>
  timed.events
    .filter((e) => e.kind === 'statement')
    .map((e) => (isSettings(e.sql ?? '') ? SETTINGS : (e.sql ?? '')));
const TIMEOUT_SET = /^set local (transaction|statement)_timeout = (-?\d+)$/u;
/** Every transaction_timeout value the port SET, in order. */
const transactionTimeouts = (timed: ReturnType<typeof makeTimedDb>): number[] =>
  sqlOf(timed)
    .map((q) => /^set local transaction_timeout = (-?\d+)$/u.exec(q)?.[1])
    .filter((value) => value !== undefined)
    .map(Number);

/** Collects the port's abandonment reports. */
const observer = () => {
  const reports: NationalAbandonedRead[] = [];
  return { reports, onAbandoned: (read: NationalAbandonedRead) => reports.push(read) };
};

describe('one bounded budget per root', () => {
  it('times out when individually fast statements exceed the root budget, and cleans up', async () => {
    const timed = makeTimedDb({ statementDelay: (q) => (q.startsWith('select') ? 80 : 0) });
    const port = makeNationalReadPort(timed.db, statements(3));
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 200, operation: 'budgetApprovedTotals' });
    const elapsed = timed.elapsed() - started;
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Timeout' });
    // Each statement got the REMAINING budget, not a fresh one.
    const timeouts = timed.events
      .filter((e) => e.sql?.startsWith('set local statement_timeout') === true)
      .map((e) => Number(e.sql?.split('= ')[1]));
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]).toBeLessThanOrEqual(200);
    expect(timeouts[1]).toBeLessThan(timeouts[0] ?? 0);
    expect(timeouts[2]).toBeLessThan(timeouts[1] ?? 0);
    expect(timed.events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
    // Server-side cancel, then rollback and release: nothing left running.
    const kinds = timed.events.map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(['rollback', 'release']);
    expect(kinds).not.toContain('commit');
    expect(elapsed).toBeLessThan(200 + 120);
  });

  it('reads the inherited timeout, resets and re-arms the backstop, then pins ISO dates, before any source statement', async () => {
    const timed = makeTimedDb();
    const port = makeNationalReadPort(timed.db, statements(1));
    (await port.read(work, { deadlineMs: 5000, operation: 'test' }))._unsafeUnwrap();
    expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['commit', 'release']);
    const sqls = sqlOf(timed);
    // Inherited setting read first, then reset + strictly positive re-arm, then ISO dates.
    expect(sqls[0]).toBe(SETTINGS);
    expect(sqls[1]).toBe('set local transaction_timeout = 0');
    expect(sqls[2]).toMatch(/^set local transaction_timeout = \d+$/u);
    expect(sqls[3]).toBe("set local DateStyle = 'ISO, YMD'");
    const backstop = Number(sqls[2]?.split('= ')[1]);
    expect(backstop).toBeGreaterThan(5000 - 50);
    expect(backstop).toBeLessThanOrEqual(5000 + 1000);
    expect(sqls[4]).toMatch(/^set local statement_timeout = \d+$/u);
    expect(sqls[5]).toContain('select');
  });

  it('bounds a queued checkout and releases the late connection without running SQL', async () => {
    const timed = makeTimedDb({ acquireDelays: [300] });
    const port = makeNationalReadPort(timed.db, statements(1));
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 100, operation: 'budgetNationalCatalog' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Timeout' });
    expect(timed.elapsed() - started).toBeLessThan(250);
    // Let the late connection arrive: it begins, rolls back, and is released.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const kinds = timed.events.map((e) => e.kind);
    expect(kinds).toEqual(['acquire', 'begin', 'rollback', 'release']);
  });

  it('keeps the connection usable for the next read after a timeout', async () => {
    let slow = true;
    const timed = makeTimedDb({
      statementDelay: (q) => (q.startsWith('select') && slow ? 300 : 0),
    });
    const port = makeNationalReadPort(timed.db, statements(1));
    expect(
      (await port.read(work, { deadlineMs: 100, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Timeout');
    slow = false;
    expect((await port.read(work, { deadlineMs: 100, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
  });

  it('rolls back instead of committing when projection after the last statement spends the budget', async () => {
    const timed = makeTimedDb();
    const port = makeNationalReadPort(timed.db, statementsThenWork(1, 150));
    const result = await port.read(work, { deadlineMs: 100, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    const kinds = timed.events.map((e) => e.kind);
    expect(kinds).not.toContain('commit');
    expect(kinds.slice(-2)).toEqual(['rollback', 'release']);
  });

  it('reports Timeout when the COMMIT itself completes after the budget', async () => {
    const timed = makeTimedDb({ commitDelay: 150 });
    const port = makeNationalReadPort(timed.db, statements(1), { transactionGraceMs: 50 });
    const result = await port.read(work, { deadlineMs: 100, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.events.map((e) => e.kind)).toContain('commit');
  });

  it('reports Timeout for a COMMIT that completes exactly at the deadline', async () => {
    const timed = makeTimedDb();
    // Time stands still until COMMIT has completed, then reads exactly the deadline.
    const clock = (): number => (timed.events.some((e) => e.kind === 'commit') ? 100 : 0);
    const port = makeNationalReadPort(timed.db, statements(1), { clock });
    const result = await port.read(work, { deadlineMs: 100, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    // The COMMIT itself and the normal release still happen.
    expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['commit', 'release']);
  });

  it('starts no source statement when its own timeout setup spent the budget', async () => {
    const timed = makeTimedDb({
      setupDelay: (q) => (q.startsWith('set local statement_timeout') ? 150 : 0),
    });
    const port = makeNationalReadPort(timed.db, statements(1));
    const result = await port.read(work, { deadlineMs: 100, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    const sqls = timed.events.filter((e) => e.kind === 'statement').map((e) => e.sql ?? '');
    expect(sqls.some((q) => q.startsWith('select'))).toBe(false);
    expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['rollback', 'release']);
  });

  describe('one budget guard around every awaited step (controllable clock)', () => {
    const SETUP = [
      SETTINGS,
      'set local transaction_timeout = 0',
      'set local transaction_timeout = 1100',
      "set local DateStyle = 'ISO, YMD'",
      'set local statement_timeout = 100',
      'select $1 as n',
    ];
    // The step whose round trip consumes the budget → the statements issued up to it.
    for (let index = 0; index < SETUP.length; index++) {
      const step = SETUP[index] ?? '';
      it(`stops all later setup and source work when "${step}" consumes the budget`, async () => {
        let now = 0;
        const spend = (q: string): void => {
          if ((isSettings(q) ? SETTINGS : q) === step) now = 100;
        };
        const timed = makeTimedDb({
          setupDelay: (q) => {
            spend(q);
            return 0;
          },
          statementDelay: (q) => {
            spend(q);
            return 0;
          },
        });
        const port = makeNationalReadPort(timed.db, statements(2), { clock: () => now });
        const result = await port.read(work, { deadlineMs: 100, operation: 't' });
        expect(result._unsafeUnwrapErr().type).toBe('Timeout');
        expect(sqlOf(timed)).toEqual(SETUP.slice(0, index + 1));
        expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['rollback', 'release']);
      });
    }

    it('never emits a zero or negative timeout', async () => {
      // Under 1 ms left at transaction start: no SET at all, just rollback.
      const late = makeTimedDb();
      const lateClock = (): number => (late.events.some((e) => e.kind === 'begin') ? 99.5 : 0);
      const port = makeNationalReadPort(late.db, statements(1), {
        clock: lateClock,
        transactionGraceMs: 0,
      });
      expect(
        (await port.read(work, { deadlineMs: 100, operation: 't' }))._unsafeUnwrapErr().type
      ).toBe('Timeout');
      expect(late.events.map((e) => e.kind)).toEqual(['acquire', 'begin', 'rollback', 'release']);
      // Exactly 1 ms left and no (or a negative) grace: every timeout is still ≥ 1 ms.
      for (const transactionGraceMs of [0, -500]) {
        const tight = makeTimedDb();
        const tightClock = (): number => (tight.events.some((e) => e.kind === 'begin') ? 99 : 0);
        const tightPort = makeNationalReadPort(tight.db, statements(1), {
          clock: tightClock,
          transactionGraceMs,
        });
        expect(
          (await tightPort.read(work, { deadlineMs: 100, operation: 't' }))._unsafeUnwrap()
        ).toBe('read');
        const values = sqlOf(tight)
          .map((q) => TIMEOUT_SET.exec(q)?.[2])
          .filter((value) => value !== undefined)
          .map(Number);
        // Zero only as the deliberate reset right after the setting read; then ≥ 1.
        expect(values).toEqual([0, 1, 1]);
        expect(sqlOf(tight).slice(0, 2)).toEqual([SETTINGS, 'set local transaction_timeout = 0']);
      }
    });
  });

  it('keeps a Timeout when both diagnostic stages throw, with nothing unhandled', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const stages: string[] = [];
      const timed = makeTimedDb({ beginDelay: 300 });
      const port = makeNationalReadPort(timed.db, statements(1), {
        onAbandoned: (read) => {
          stages.push(read.stage);
          throw new Error(`diagnostics failed at ${read.stage}`);
        },
      });
      const result = await port.read(work, { deadlineMs: 100, operation: 'budgetNationalCatalog' });
      // The observer's failure neither replaces nor hides the read's own answer.
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: 'Timeout',
        message: 'budgetNationalCatalog timed out before checkout/transaction start completed',
      });
      expect(stages).toEqual(['abandoned']);
      await wait(400);
      expect(stages).toEqual(['abandoned', 'settled']);
      expect(timed.events.map((e) => e.kind)).toEqual(['acquire', 'begin', 'rollback', 'release']);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('never consults diagnostics for an ordinary read error', async () => {
    const stages: string[] = [];
    const timed = makeTimedDb({
      respond: (q) => {
        if (q.startsWith('select')) {
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        }
        return [];
      },
    });
    const port = makeNationalReadPort(timed.db, statements(1), {
      onAbandoned: (read) => {
        stages.push(read.stage);
        throw new Error('diagnostics failed');
      },
    });
    const result = await port.read(work, { deadlineMs: 5000, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(stages).toEqual([]);
  });

  it('lets the armed backstop terminate a stalled transaction; the client is evicted', async () => {
    const seen = observer();
    const timed = makeTimedDb();
    // One statement, then the client stalls far past budget + grace.
    const port = makeNationalReadPort(timed.db, statementsThenWork(1, 600), {
      transactionGraceMs: 50,
      onAbandoned: seen.onAbandoned,
    });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 100, operation: 'budgetApprovedSeries' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.elapsed() - started).toBeLessThan(100 + 50 + 250 + 150);
    // Reported at once, while the transaction is still unsettled.
    expect(seen.reports).toEqual([
      { stage: 'abandoned', operation: 'budgetApprovedSeries', phase: 'stalled' },
    ]);
    const terminated = timed.events.find((e) => e.kind === 'terminated');
    expect(terminated?.at).toBeGreaterThanOrEqual(100 + 50 - 20);
    await wait(400);
    // The ROLLBACK on the terminated session fails; the client is evicted.
    expect(seen.reports[1]).toEqual({
      stage: 'settled',
      operation: 'budgetApprovedSeries',
      phase: 'stalled',
      outcome: 'rolled-back-or-failed',
    });
    expect(timed.events.map((e) => e.kind)).not.toContain('commit');
    expect(timed.events.at(-1)?.kind).toBe('evicted');
    // The next read gets a fresh session.
    const next = makeNationalReadPort(timed.db, statements(1));
    expect((await next.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
  });

  it('stops waiting at the hard bound for a lost reply; abandonment is reported at once', async () => {
    const seen = observer();
    const timed = makeTimedDb({ hang: (q) => q.startsWith('select') });
    const port = makeNationalReadPort(timed.db, statements(1), {
      transactionGraceMs: 50,
      onAbandoned: seen.onAbandoned,
    });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 100, operation: 'budgetApprovedSeries' });
    const elapsed = timed.elapsed() - started;
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    // budget + backstop grace + cleanup margin, never unbounded.
    expect(elapsed).toBeGreaterThanOrEqual(100 + 50);
    expect(elapsed).toBeLessThan(100 + 50 + 250 + 150);
    expect(seen.reports).toEqual([
      { stage: 'abandoned', operation: 'budgetApprovedSeries', phase: 'stalled' },
    ]);
    // A reply that never arrives never settles: no eviction can be claimed.
    await wait(100);
    expect(seen.reports).toHaveLength(1);
    expect(timed.events.map((e) => e.kind)).not.toContain('release');
  });

  it('bounds a never-replying BEGIN, the backstop setup and a never-replying ROLLBACK', async () => {
    const seen = observer();
    let hangs = new Set(['BEGIN']);
    const timed = makeTimedDb({
      hang: (q) => {
        const key = q.startsWith('set local transaction_timeout') ? 'BACKSTOP' : q;
        if (!hangs.has(key)) return false;
        hangs.delete(key); // only the first occurrence never replies
        return true;
      },
      statementDelay: (q) => (q.startsWith('select') ? 1_000 : 0),
    });
    const port = makeNationalReadPort(timed.db, statements(1), {
      transactionGraceMs: 50,
      onAbandoned: seen.onAbandoned,
    });
    const bound = 100 + 50 + 250 + 150;

    let started = timed.elapsed();
    let result = await port.read(work, { deadlineMs: 100, operation: 'begin' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.elapsed() - started).toBeLessThan(100 + 150); // transaction-start bound
    expect(seen.reports.at(-1)).toEqual({
      stage: 'abandoned',
      operation: 'begin',
      phase: 'transaction-start',
    });

    hangs = new Set(['BACKSTOP']);
    started = timed.elapsed();
    result = await port.read(work, { deadlineMs: 100, operation: 'setup' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.elapsed() - started).toBeLessThan(bound);
    expect(seen.reports.at(-1)).toEqual({
      stage: 'abandoned',
      operation: 'setup',
      phase: 'stalled',
    });

    hangs = new Set(['ROLLBACK']);
    started = timed.elapsed();
    result = await port.read(work, { deadlineMs: 100, operation: 'rollback' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.elapsed() - started).toBeLessThan(bound);
    expect(seen.reports.at(-1)).toEqual({
      stage: 'abandoned',
      operation: 'rollback',
      phase: 'stalled',
    });

    // None of them ever settles; later reads still get connections and succeed.
    expect(seen.reports.filter((r) => r.stage === 'settled')).toEqual([]);
    const fast = makeNationalReadPort(timed.db, statements(0));
    expect((await fast.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
  });

  it('observes a stalled rollback immediately and again when it finally settles', async () => {
    const seen = observer();
    const timed = makeTimedDb({
      statementDelay: (q) => (q.startsWith('select') ? 1_000 : 0),
      rollbackDelay: 700,
    });
    const port = makeNationalReadPort(timed.db, statements(1), {
      transactionGraceMs: 50,
      onAbandoned: seen.onAbandoned,
    });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 100, operation: 'budgetApprovedTotals' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(timed.elapsed() - started).toBeLessThan(100 + 50 + 250 + 150);
    expect(seen.reports).toEqual([
      { stage: 'abandoned', operation: 'budgetApprovedTotals', phase: 'stalled' },
    ]);
    await wait(800);
    expect(seen.reports[1]).toEqual({
      stage: 'settled',
      operation: 'budgetApprovedTotals',
      phase: 'stalled',
      outcome: 'rolled-back-or-failed',
    });
    expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['rollback', 'release']);
  });

  it('times out a slow BEGIN as transaction start and rolls the late transaction back without SQL', async () => {
    const seen = observer();
    const timed = makeTimedDb({ beginDelay: 300 });
    const port = makeNationalReadPort(timed.db, statements(1), { onAbandoned: seen.onAbandoned });
    const result = await port.read(work, { deadlineMs: 100, operation: 'budgetNationalCatalog' });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Timeout' });
    expect(seen.reports).toEqual([
      { stage: 'abandoned', operation: 'budgetNationalCatalog', phase: 'transaction-start' },
    ]);
    await wait(350);
    expect(timed.events.map((e) => e.kind)).toEqual(['acquire', 'begin', 'rollback', 'release']);
    expect(seen.reports[1]).toEqual({
      stage: 'settled',
      operation: 'budgetNationalCatalog',
      phase: 'transaction-start',
      outcome: 'rolled-back-or-failed',
    });
  });

  it('maps a COMMIT failure by evidence and keeps a source failure through a failing ROLLBACK', async () => {
    const lost = (): Error => new Error('Connection terminated unexpectedly');
    // A generic connection failure at COMMIT well before the deadline: Database.
    const early = makeTimedDb({
      lifecycleError: (phase) => (phase === 'COMMIT' ? lost() : undefined),
    });
    const commit = makeNationalReadPort(early.db, statements(1));
    expect(
      (await commit.read(work, { deadlineMs: 5000, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Database');
    // The same failure once the effective deadline has passed: Timeout.
    let now = 0;
    const late = makeTimedDb({
      lifecycleError: (phase) => {
        if (phase !== 'COMMIT') return undefined;
        now = 100;
        return lost();
      },
    });
    const lateCommit = makeNationalReadPort(late.db, statements(1), { clock: () => now });
    expect(
      (await lateCommit.read(work, { deadlineMs: 100, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Timeout');
    // A missing relation, then a failing ROLLBACK (which Kysely rethrows instead):
    // the original source failure decides the mapping.
    const sourceFails = makeTimedDb({
      respond: (q) => {
        if (q.startsWith('select')) {
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        }
        return [];
      },
      lifecycleError: (phase) => (phase === 'ROLLBACK' ? lost() : undefined),
    });
    const source = makeNationalReadPort(sourceFails.db, statements(1));
    expect(
      (await source.read(work, { deadlineMs: 5000, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
  });

  it('maps a transaction-timeout termination and post-deadline cleanup failures to Timeout', async () => {
    const terminated = makeCapturingDb([], {
      respond: (q) => {
        if (isSettings(q)) return [{ setting: '0', unit: 'ms' }];
        if (q.startsWith('select')) {
          throw Object.assign(new Error('terminating connection due to transaction timeout'), {
            code: '25P04',
          });
        }
        return [];
      },
    });
    const port = makeNationalReadPort(terminated, statements(1));
    expect(
      (await port.read(work, { deadlineMs: 5000, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Timeout');
    const lost = new Error('Connection terminated unexpectedly');
    expect(nationalDbError(lost, 'op', true).type).toBe('Timeout');
    expect(nationalDbError(lost, 'op', false).type).toBe('Database');
    // pg-pool's own acquisition timeout (connectionTimeoutMillis) is a timeout too.
    const poolTimeout = new Error('timeout exceeded when trying to connect');
    expect(nationalDbError(poolTimeout, 'op').type).toBe('Timeout');
  });
});

describe('inherited transaction_timeout (PostgreSQL 18 timer semantics)', () => {
  /** A reader: one statement, `pauseMs` of client work, then a second statement. */
  const pauseBetween =
    (pauseMs: number) =>
    (run: NationalRun): NationalReadTx => {
      const tx: StatementTx = {
        read: async () => {
          await run(sql`select 0 as n`);
          await wait(pauseMs);
          await run(sql`select 1 as n`);
          return ok('read');
        },
      };
      return tx as unknown as NationalReadTx;
    };

  it('with no inherited limit arms the local backstop and reads normally', async () => {
    const timed = makeTimedDb({ inheritedTransactionTimeoutMs: 0 });
    const port = makeNationalReadPort(timed.db, statements(1), { transactionGraceMs: 50 });
    expect((await port.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
    const [reset, armed] = transactionTimeouts(timed);
    expect(reset).toBe(0);
    expect(armed).toBeGreaterThan(500);
    expect(armed).toBeLessThanOrEqual(550);
    expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['commit', 'release']);
  });

  it('shortens a longer inherited timer (5000 ms) to the local backstop, then restores it', async () => {
    const seen: string[] = [];
    const timed = makeTimedDb({
      inheritedTransactionTimeoutMs: 5_000,
      settingsRows: (setting) => {
        seen.push(setting);
        return [{ setting, unit: 'ms' }];
      },
    });
    const port = makeNationalReadPort(timed.db, pauseBetween(300), { transactionGraceMs: 50 });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 120, operation: 'budgetApprovedTotals' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    // The session is terminated near the effective backstop (120 + 50), not after 5 s.
    const terminated = timed.events.find((e) => e.kind === 'terminated');
    expect(terminated).toBeDefined();
    expect((terminated?.at ?? 0) - started).toBeGreaterThanOrEqual(150);
    expect((terminated?.at ?? 0) - started).toBeLessThan(260);
    await wait(250); // the paused reader finishes; its ROLLBACK fails on the dead session
    expect(timed.events.at(-1)?.kind).toBe('evicted');
    expect(timed.events.map((e) => e.kind)).not.toContain('commit');
    // The next transaction sees the inherited value again (SET LOCAL ended) and succeeds.
    const next = makeNationalReadPort(timed.db, statements(1));
    expect((await next.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
    expect(seen).toEqual(['5000', '5000']);
  });

  it('keeps a stricter inherited timer (80 ms) under a 500 ms budget: Timeout, never extended', async () => {
    const timed = makeTimedDb({ inheritedTransactionTimeoutMs: 80 });
    const port = makeNationalReadPort(timed.db, pauseBetween(200), { transactionGraceMs: 100 });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 500, operation: 'budgetApprovedTotals' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    // Re-armed at what is left of the 80 ms (no grace past it), never 600.
    const [reset, armed] = transactionTimeouts(timed);
    expect(reset).toBe(0);
    expect(armed).toBeGreaterThan(0);
    expect(armed).toBeLessThanOrEqual(80);
    const terminated = timed.events.find((e) => e.kind === 'terminated');
    expect((terminated?.at ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(150);
    // No second source statement after the cap; nothing committed.
    expect(sqlOf(timed).filter((q) => q.startsWith('select'))).toEqual(['select 0 as n']);
    expect(timed.events.map((e) => e.kind)).not.toContain('commit');
  });

  it('caps the caller wait by the stricter inherited limit + margin, not the root allowance', async () => {
    const seen = observer();
    const timed = makeTimedDb({
      inheritedTransactionTimeoutMs: 80,
      hang: (q) => q.startsWith('select'),
    });
    const port = makeNationalReadPort(timed.db, statements(1), {
      transactionGraceMs: 100,
      onAbandoned: seen.onAbandoned,
    });
    const started = timed.elapsed();
    const result = await port.read(work, { deadlineMs: 500, operation: 't' });
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    // 80 + 250 margin, well before 500 + 100 + 250.
    expect(timed.elapsed() - started).toBeLessThan(80 + 250 + 150);
    expect(seen.reports).toEqual([{ stage: 'abandoned', operation: 't', phase: 'stalled' }]);
  });

  describe('the cleanup wait is one absolute bound (backstop + margin), never renewed', () => {
    /**
     * Inherited 80 ms cap, root 500 ms + 100 ms grace (allowance 80 + 250 = 330).
     * The controllable clock jumps to `discoveredAt` while the setting is read;
     * real time then measures only the hard timer's remaining delay.
     */
    const discover = (discoveredAt: number, hang: (q: string) => boolean) => {
      let now = 0;
      const seen = observer();
      const timed = makeTimedDb({
        inheritedTransactionTimeoutMs: 80,
        settingsRows: (setting) => {
          now = discoveredAt;
          return [{ setting, unit: 'ms' }];
        },
        hang,
      });
      const port = makeNationalReadPort(timed.db, statements(1), {
        clock: () => now,
        transactionGraceMs: 100,
        onAbandoned: seen.onAbandoned,
      });
      return { timed, seen, port };
    };

    const expectPendingCleanup = async (
      timed: ReturnType<typeof makeTimedDb>,
      seen: ReturnType<typeof observer>
    ): Promise<void> => {
      // Abandonment is reported at once; the stalled ROLLBACK never settles,
      // so no release, eviction or settlement is claimed.
      expect(seen.reports).toEqual([{ stage: 'abandoned', operation: 't', phase: 'stalled' }]);
      await wait(100);
      expect(seen.reports).toHaveLength(1);
      const kinds = timed.events.map((e) => e.kind);
      expect(kinds).not.toContain('rollback');
      expect(kinds).not.toContain('release');
      expect(kinds).not.toContain('evicted');
    };

    it('waits only the 130 ms left when the 80 ms cap is discovered at 200 ms', async () => {
      const { timed, seen, port } = discover(200, (q) => q === 'ROLLBACK');
      const started = timed.elapsed();
      const result = await port.read(work, { deadlineMs: 500, operation: 't' });
      const waited = timed.elapsed() - started;
      expect(result._unsafeUnwrapErr().type).toBe('Timeout');
      // 80 + 250 − 200 = 130 ms, not a renewed 250 ms (→ 450).
      expect(waited).toBeGreaterThanOrEqual(120);
      expect(waited).toBeLessThan(200);
      // Spent under the cap: no reset, no source statement.
      expect(sqlOf(timed)).toEqual([SETTINGS]);
      await expectPendingCleanup(timed, seen);
    });

    it('stops waiting at once when the cap is discovered after the whole allowance (400 ms)', async () => {
      const { timed, seen, port } = discover(400, (q) => q === 'ROLLBACK');
      const started = timed.elapsed();
      const result = await port.read(work, { deadlineMs: 500, operation: 't' });
      const waited = timed.elapsed() - started;
      expect(result._unsafeUnwrapErr().type).toBe('Timeout');
      expect(waited).toBeLessThan(60); // immediate, not 250 ms (→ 650)
      expect(sqlOf(timed)).toEqual([SETTINGS]);
      await expectPendingCleanup(timed, seen);
    });

    it('control: a cap discovered before its backstop keeps the full rest (50 ms → 280 ms)', async () => {
      const { timed, seen, port } = discover(50, (q) => q.startsWith('select'));
      const started = timed.elapsed();
      const result = await port.read(work, { deadlineMs: 500, operation: 't' });
      const waited = timed.elapsed() - started;
      expect(result._unsafeUnwrapErr().type).toBe('Timeout');
      // 80 + 250 − 50 = 280 ms (the same under either formula while the backstop is ahead).
      expect(waited).toBeGreaterThanOrEqual(270);
      expect(waited).toBeLessThan(350);
      // Reset and re-armed at the 30 ms left; the source statement never replied.
      expect(transactionTimeouts(timed)).toEqual([0, 30]);
      expect(seen.reports).toEqual([{ stage: 'abandoned', operation: 't', phase: 'stalled' }]);
    });
  });

  it('gives no grace past an equal inherited limit and keeps the read deadline', async () => {
    const timed = makeTimedDb({ inheritedTransactionTimeoutMs: 500 });
    const port = makeNationalReadPort(timed.db, statements(1), { transactionGraceMs: 1_000 });
    expect((await port.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
    const [, armed] = transactionTimeouts(timed);
    expect(armed).toBeGreaterThan(400);
    expect(armed).toBeLessThanOrEqual(500);
  });

  it('anchors both deadlines at the read start: a long checkout leaves only the absolute rest', async () => {
    const timed = makeTimedDb({ inheritedTransactionTimeoutMs: 5_500 });
    // A 4 s checkout (controllable clock): T = 5.5 s, B = 5 s, G = 1 s.
    const clock = (): number => (timed.events.some((e) => e.kind === 'acquire') ? 4_000 : 0);
    const port = makeNationalReadPort(timed.db, statements(1), { clock });
    expect((await port.read(work, { deadlineMs: 5_000, operation: 't' }))._unsafeUnwrap()).toBe(
      'read'
    );
    expect(transactionTimeouts(timed)).toEqual([0, 1_500]); // not 5500 or 6000
    expect(sqlOf(timed)).toContain('set local statement_timeout = 1000');
    // A checkout past the inherited cap but inside the root budget: no SQL at all.
    const capped = makeTimedDb({ inheritedTransactionTimeoutMs: 3_000 });
    const lateClock = (): number => (capped.events.some((e) => e.kind === 'acquire') ? 3_000 : 0);
    const cappedPort = makeNationalReadPort(capped.db, statements(1), { clock: lateClock });
    expect(
      (await cappedPort.read(work, { deadlineMs: 5_000, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Timeout');
    // The setting read itself is the only statement: spent under the cap, no reset issued.
    expect(sqlOf(capped)).toEqual([SETTINGS]);
    expect(capped.events.map((e) => e.kind).slice(-2)).toEqual(['rollback', 'release']);
  });

  it('maps a generic connection failure by the effective (inherited) deadline', async () => {
    let now = 0;
    const lostAt = (ms: number) =>
      makeTimedDb({
        inheritedTransactionTimeoutMs: 80,
        respond: (q) => {
          if (q.startsWith('select')) {
            now = ms;
            throw new Error('Connection terminated unexpectedly');
          }
          return [];
        },
      });
    // After the inherited 80 ms cap (root budget 500 still running): Timeout.
    const after = lostAt(90);
    const afterPort = makeNationalReadPort(after.db, statements(1), { clock: () => now });
    expect(
      (await afterPort.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Timeout');
    // Before it: an unrelated connection fault stays Database.
    now = 0;
    const before = lostAt(50);
    const beforePort = makeNationalReadPort(before.db, statements(1), { clock: () => now });
    expect(
      (await beforePort.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Database');
    // An early fault on the setting read itself is Database too.
    const early = makeTimedDb({
      settingsRows: () => {
        throw new Error('Connection terminated unexpectedly');
      },
    });
    const earlyPort = makeNationalReadPort(early.db, statements(1));
    expect(
      (await earlyPort.read(work, { deadlineMs: 500, operation: 't' }))._unsafeUnwrapErr().type
    ).toBe('Database');
  });

  it('fails closed on a missing or malformed setting, before any SET', async () => {
    const shapes: unknown[][] = [
      [],
      [{ setting: '5s', unit: 'ms' }],
      [{ setting: '5000', unit: 's' }],
      [{ setting: '-1', unit: 'ms' }],
      [{ setting: '01', unit: 'ms' }],
      [{ setting: '2147483648', unit: 'ms' }],
      [{ setting: 5000, unit: 'ms' }],
      [
        { setting: '0', unit: 'ms' },
        { setting: '0', unit: 'ms' },
      ],
    ];
    for (const rows of shapes) {
      const timed = makeTimedDb({ settingsRows: () => rows });
      const port = makeNationalReadPort(timed.db, statements(1));
      const result = await port.read(work, { deadlineMs: 500, operation: 't' });
      expect([rows, result._unsafeUnwrapErr().type]).toEqual([rows, 'ServiceUnavailable']);
      expect(sqlOf(timed)).toEqual([SETTINGS]);
      expect(timed.events.map((e) => e.kind).slice(-2)).toEqual(['rollback', 'release']);
    }
    expect(parseInheritedTransactionTimeout([{ setting: '0', unit: 'ms' }])).toBe(0);
    expect(parseInheritedTransactionTimeout([{ setting: '2147483647', unit: 'ms' }])).toBe(
      2_147_483_647
    );
  });

  it('caches nothing for a read the stricter inherited limit timed out', async () => {
    const world = makeSourceWorld();
    const timed = makeTimedDb({
      inheritedTransactionTimeoutMs: 80,
      statementDelay: (q) => (q.includes('budget.national:') ? 200 : 0),
      respond: (q, parameters) => world.respond(q, parameters),
    });
    const cache = makeNationalResponseCache();
    const offered: string[] = [];
    const port = makeNationalReadPort(timed.db, (run) => ({
      approved: makeNationalApprovedReader(run),
      execution: makeNationalExecutionReader(run),
    }));
    const result = await budgetApprovedTotals(
      {
        port,
        cache: {
          ...cache,
          set: (key, value, stamp) => {
            offered.push(key);
            cache.set(key, value, stamp);
          },
        },
      },
      {
        input: {
          totals: ['EXPENDITURE_5001_STATE_BUDGET'],
          creditTypes: ['BUDGET_CREDITS'],
          editionIds: ['2025:law_2025_as_sent_to_monitorul_oficial'],
          measureYears: [2025],
        },
      }
    );
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(offered).toEqual([]);
    expect(cache.probe('APPROVED')).toBeUndefined();
  });
});

describe('ISO dates whatever the session DateStyle', () => {
  const factors: FactorSource = { yearly: () => Promise.resolve(ok(null)) };
  const registry: ContributorRegistry = {
    register: () => undefined,
    list: () => [],
    get: () => undefined,
  };
  const world = makeSourceWorld();

  const harness = (ignoreDateStylePin: boolean) => {
    const timed = makeTimedDb({
      sessionDateStyle: 'SQL, DMY',
      ignoreDateStylePin,
      respond: (q, parameters, iso) => {
        const rows = world.respond(q, parameters);
        return iso ? rows : toSqlDmy(rows);
      },
    });
    const budget = makeBudgetModule({
      db: timed.db,
      registry,
      legacyFactors: factors,
      nationalCache: null,
    });
    const schema = makeExecutableSchema({
      typeDefs: mergeGraphqlSlices(baseTypeDefs, [budget.graphqlSlice]).typeDefs,
      resolvers: { ...scalarResolvers, ...budget.graphqlResolvers },
    });
    return { budget, schema };
  };

  const RELEASES = `{ budgetExecutionReleases(input: { months: { type: MONTH, selection: { dates: ["2025-12"] } } }) {
    coverage { firstMonth } months { month current { selectionId release { calendarPeriod { start end } } } } } }`;

  it('serves canonical dates under SQL,DMY through GraphQL and MCP (releases, observations, series)', async () => {
    const { budget, schema } = harness(false);
    const releases = await graphql({ schema, source: RELEASES });
    expect(releases.errors).toBeUndefined();
    expect(releases.data).toMatchObject({
      budgetExecutionReleases: {
        coverage: { firstMonth: '2006-06' },
        months: [
          {
            month: '2025-12',
            current: { release: { calendarPeriod: { start: '2025-01-01', end: '2025-12-31' } } },
          },
        ],
      },
    });
    const tool = budget.mcpTools.find((t) => t.name === 'get_budget_execution_releases');
    const output = await tool?.handler({
      input: { months: { type: 'MONTH', selection: { dates: ['2025-12'] } } },
    });
    expect(output?.ok).toBe(true);

    const observations = await graphql({
      schema,
      source: `{ budgetExecutionObservations(input: { source: { months: { type: MONTH, selection: { dates: ["2025-06"] } } } }, first: 2) {
        pageInfo { endCursor } edges { node { month } } } }`,
    });
    expect(observations.errors).toBeUndefined();
    const series = await graphql({
      schema,
      source: `{ budgetNationalExecutionSeries(input: { itemIds: ["mfin.bgc.revenue.total"], basis: YTD,
        period: { type: MONTH, selection: { dates: ["2025-06"] } } }) { results { periods { periodStart periodEnd } } } }`,
    });
    expect(series.errors).toBeUndefined();
    expect(series.data).toMatchObject({
      budgetNationalExecutionSeries: {
        results: [{ periods: [{ periodStart: '2025-01-01', periodEnd: '2025-06-30' }] }],
      },
    });
  });

  it('control: without the transaction-local pin the same session fails (the emulation bites)', async () => {
    const { schema } = harness(true);
    const releases = await graphql({ schema, source: RELEASES });
    expect(releases.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
