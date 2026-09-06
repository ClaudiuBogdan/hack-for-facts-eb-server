import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { makeUserDataPool } from '@/infra/database/user-client.js';

const directory = mkdtempSync(join(tmpdir(), 'user-db-client-'));
const caFile = join(directory, 'ca.pem');
writeFileSync(caFile, 'test public certificate');
afterAll(() => {
  rmSync(directory, { recursive: true });
});
const url = 'postgres://app:fixture-password@db.dev.svc/userdata';

describe('dedicated user-data pool', () => {
  it('rejects malformed URLs without retaining credentials', () => {
    let caught: unknown;
    try {
      makeUserDataPool({ url: 'invalid-fixture-password', caFile });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe('Error: Invalid user-data database URL');
    expect(caught).not.toHaveProperty('input');
    expect(caught).not.toHaveProperty('cause');
  });

  it('rejects connection-string TLS overrides and mismatched DNS identities', () => {
    expect(() => makeUserDataPool({ url: `${url}?sslmode=disable`, caFile })).toThrow(
      'without connection overrides'
    );
    expect(() => makeUserDataPool({ url, caFile, tlsServername: 'other.dev.svc' })).toThrow(
      'TLS name must match'
    );
  });

  it('retains certificate verification through an IP tunnel', async () => {
    const pool = makeUserDataPool({
      url: 'postgres://app:fixture-password@127.0.0.1:62883/userdata',
      caFile,
      tlsServername: 'db.dev.svc',
    });
    expect(pool.options.ssl).toEqual({
      ca: 'test public certificate',
      rejectUnauthorized: true,
      servername: 'db.dev.svc',
    });
    await pool.end();
  });

  it('handles checked-out and idle connection errors without exposing their details', async () => {
    const reports: unknown[][] = [];
    const pool = makeUserDataPool({ url, caFile }, (...args: unknown[]) => {
      reports.push(args);
    });
    const client = new pg.Client();
    pool.emit('connect', client);
    const error = new Error('fixture-password and private database host');
    expect(() => client.emit('error', error)).not.toThrow();
    expect(() => pool.emit('error', error, client)).not.toThrow();
    expect(reports).toEqual([[], []]);
    await pool.end();
  });
});
