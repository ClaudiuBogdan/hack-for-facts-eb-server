import { err, errAsync, ok, okAsync, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { expectErr, expectErrAsync, expectOk, expectOkAsync } from '../../support/index.js';

describe('Result assertion helpers', () => {
  it('returns precisely narrowed Ok and Err values', () => {
    const okResult: Result<{ id: string }, { code: string }> = ok({ id: 'record-1' });
    const errResult: Result<{ id: string }, { code: string }> = err({ code: 'NOT_FOUND' });

    const value: { id: string } = expectOk(okResult);
    const error: { code: string } = expectErr(errResult);

    expect(value.id).toBe('record-1');
    expect(error.code).toBe('NOT_FOUND');
  });

  it('includes context and an inspected Err value when expectOk fails', () => {
    let thrown: unknown;
    try {
      expectOk(err({ code: 'BROKEN', details: { attempt: 2 } }), 'loading record');
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof Error) {
      expect(thrown.message).toContain('loading record');
      expect(thrown.message).toContain("code: 'BROKEN'");
      expect(thrown.message).toContain('attempt: 2');
    }
  });

  it('includes context and an inspected Ok value when expectErr fails', () => {
    expect(() => expectErr(ok({ id: 'unexpected-1' }), 'deleting record')).toThrow(
      /deleting record: expected Err; received \{ id: 'unexpected-1' \}/u
    );
  });

  it('supports both ResultAsync and Promise<Result> inputs', async () => {
    const okValue: number = await expectOkAsync(okAsync(42));
    const asyncError: string = await expectErrAsync(errAsync('async failure'));
    const promisedValue: string = await expectOkAsync(Promise.resolve(ok('promised')));
    const promisedError: { code: number } = await expectErrAsync(
      Promise.resolve(err({ code: 503 }))
    );

    expect(okValue).toBe(42);
    expect(asyncError).toBe('async failure');
    expect(promisedValue).toBe('promised');
    expect(promisedError).toEqual({ code: 503 });
  });

  it('uses informative inspected-value failures in async variants', async () => {
    await expect(expectOkAsync(errAsync({ reason: 'offline' }), 'sending')).rejects.toThrow(
      /sending: expected Ok; received \{ reason: 'offline' \}/u
    );
    await expect(expectErrAsync(okAsync({ status: 'ready' }), 'probing')).rejects.toThrow(
      /probing: expected Err; received \{ status: 'ready' \}/u
    );
  });
});
