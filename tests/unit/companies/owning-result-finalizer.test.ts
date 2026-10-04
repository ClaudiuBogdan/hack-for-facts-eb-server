/**
 * The owning-result finalizer's client-facing error (`companies-graphql-access`):
 * a withheld result keeps the module-written message of a ServiceUnavailable
 * or an InvalidInput — with the InvalidInput's safe `field` (analytics' stale
 * `release`) — and every other type reads "Internal server error": never a
 * driver cause, connection string or SQL.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  finalizeOwningResults,
  makeRequestOwningResultGuard,
} from '@/app/companies-graphql-access.js';
import {
  OWNING_RESULT_GUARD,
  databaseError,
  invalidInput,
  serviceUnavailable,
  timeoutError,
  type ApiError,
} from '@/modules/shared/index.js';

const withheld = async (error: ApiError) => {
  const guard = makeRequestOwningResultGuard();
  guard.confirm(['root'], async () => err(error));
  guard.confirm(['kept'], async () => ok(undefined));
  const execution: { data: Record<string, unknown>; errors?: readonly unknown[] } = {
    data: { root: { secret: 'EARLIER_FIGURE' }, kept: 'still served' },
    errors: [{ message: 'beneath', path: ['root', 'secret'] }],
  };
  await finalizeOwningResults(execution, { [OWNING_RESULT_GUARD]: guard });
  return execution;
};

describe('owning-result finalizer error mapping', () => {
  it('keeps an InvalidInput message and its field (a stale analytics release)', async () => {
    const execution = await withheld(
      invalidInput(
        'companies analytics release 7 was withdrawn after a privacy change; re-read companyAnalysisRelease and repeat the request',
        'release'
      )
    );
    expect(execution.data).toEqual({ root: null, kept: 'still served' });
    expect(execution.errors).toEqual([
      {
        message:
          'companies analytics release 7 was withdrawn after a privacy change; re-read companyAnalysisRelease and repeat the request',
        path: ['root'],
        extensions: { code: 'INVALID_INPUT', type: 'InvalidInput', field: 'release' },
      },
    ]);
  });

  it('keeps a ServiceUnavailable message, without a field', async () => {
    const execution = await withheld(serviceUnavailable('companies analytics cannot confirm'));
    expect(execution.errors).toEqual([
      {
        message: 'companies analytics cannot confirm',
        path: ['root'],
        extensions: { code: 'SERVICE_UNAVAILABLE', type: 'ServiceUnavailable' },
      },
    ]);
  });

  it.each([
    [
      'a database error with a driver cause',
      databaseError(
        'select failed',
        new Error('password authentication failed for postgres://u:pw@db:5432')
      ),
    ],
    ['a timeout', timeoutError('companies analytics query exceeded its time budget')],
  ])('never forwards %s: "Internal server error" only', async (_label, error) => {
    const execution = await withheld(error);
    expect(execution.errors).toHaveLength(1);
    const [only] = execution.errors ?? [];
    expect(only).toMatchObject({ message: 'Internal server error', path: ['root'] });
    expect(JSON.stringify(execution)).not.toMatch(/pw@|password|select failed|time budget/u);
    expect(JSON.stringify(only)).not.toContain('field');
  });
});
