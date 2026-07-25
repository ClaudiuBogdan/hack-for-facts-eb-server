/**
 * The `organizationLabels` contract — the batch naming surface.
 *
 * These pin BEHAVIOUR, not SQL shape: the sibling `identity-containment-sql`
 * tests assert what reaches the database, and codex's review noted they would
 * stay green if the repo returned an empty map. Here the fake repo returns known
 * rows, so a broken mapping fails.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { databaseError } from '@/modules/shared/core/errors.js';
import {
  MAX_ORGANIZATION_LABELS,
  makeOrganizationLabels,
} from '@/modules/shared/core/usecases/organization-labels.js';

import type { Organization } from '@/modules/shared/index.js';

const org = (cui: string, name: string, kind = 'company'): Organization => ({
  orgId: cui,
  cui,
  registrationNumber: null,
  kind,
  name,
  normalizedName: name.toLowerCase(),
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'onrc',
  attrs: {},
});

const NAMED = org('36727850', 'COMPANIA NAŢIONALĂ DE INVESTIŢII RUTIERE S.A.');
const PLACEHOLDER = org('9124401', '9124401', 'unknown');
const NUMERIC_BUT_REAL = org('4305857', '1234', 'company');

const deps = (rows: readonly Organization[] = [NAMED, PLACEHOLDER, NUMERIC_BUT_REAL]) => {
  const findManyByCui = vi.fn(async (cuis: readonly string[]) =>
    ok(new Map(rows.filter((r) => r.cui !== null && cuis.includes(r.cui)).map((r) => [r.cui!, r])))
  );
  return { deps: { identityRepo: { findManyByCui } as never }, findManyByCui };
};

describe('organizationLabels', () => {
  it('classifies named, placeholder and unavailable distinctly', async () => {
    const { deps: d } = deps();
    const res = await makeOrganizationLabels(d, ['36727850', '9124401', '55555555']);
    const labels = (res as unknown as { value: readonly Record<string, unknown>[] }).value;

    expect(labels.map((l) => l['status'])).toEqual(['named', 'placeholder', 'unavailable']);
    expect(labels[0]?.['canonicalName']).toBe(NAMED.name);
    // A placeholder's stored name IS the CUI — it must never leak out as a name.
    expect(labels[1]?.['canonicalName']).toBeNull();
    expect(labels[1]?.['cui']).toBe('9124401');
  });

  it('a numeric name that is NOT the cui stays a real name', async () => {
    // Exactly one such organization exists on prod; a "looks numeric" test would
    // have suppressed it.
    const { deps: d } = deps();
    const res = await makeOrganizationLabels(d, ['4305857']);
    const label = (res as unknown as { value: readonly Record<string, unknown>[] }).value[0];

    expect(label?.['status']).toBe('named');
    expect(label?.['canonicalName']).toBe('1234');
  });

  it('never reflects a withheld or malformed identifier back, and never queries it', async () => {
    const { deps: d, findManyByCui } = deps();
    const res = await makeOrganizationLabels(d, ['9999999999999', 'abc', '36727850']);
    const labels = (res as unknown as { value: readonly Record<string, unknown>[] }).value;

    expect(labels.map((l) => l['status'])).toEqual(['unavailable', 'unavailable', 'named']);
    // The identifier itself must not come back — it is restricted input, and the
    // CUI scalar promises normalized digits.
    expect(labels[0]?.['cui']).toBeNull();
    expect(labels[1]?.['cui']).toBeNull();
    expect(findManyByCui).toHaveBeenCalledWith(['36727850']);
  });

  it('preserves request order and length, including duplicates', async () => {
    const { deps: d } = deps();
    const requested = ['9124401', '36727850', '9124401', 'abc'];
    const res = await makeOrganizationLabels(d, requested);
    const labels = (res as unknown as { value: readonly Record<string, unknown>[] }).value;

    // Positional correlation is the ONLY correlation callers have once `cui` can
    // be null, so length and order are load-bearing.
    expect(labels).toHaveLength(requested.length);
    expect(labels.map((l) => l['status'])).toEqual([
      'placeholder',
      'named',
      'placeholder',
      'unavailable',
    ]);
  });

  it('rejects an over-sized batch instead of truncating it', async () => {
    const { deps: d, findManyByCui } = deps();
    const tooMany = Array.from({ length: MAX_ORGANIZATION_LABELS + 1 }, (_, i) =>
      String(10_000_000 + i)
    );
    const res = await makeOrganizationLabels(d, tooMany);

    expect(res.isErr()).toBe(true);
    const error = (res as unknown as { error: { type: string; message: string } }).error;
    expect(error.type).toBe('InvalidInput');
    // Silently answering "unidentified" for the overflow would be a silent cap.
    expect(error.message).toContain(String(MAX_ORGANIZATION_LABELS));
    expect(findManyByCui).not.toHaveBeenCalled();
  });

  it('propagates a repo failure as an error, never as unnamed organizations', async () => {
    const findManyByCui = vi.fn(async () => err(databaseError('boom', new Error('boom'))));
    const res = await makeOrganizationLabels({ identityRepo: { findManyByCui } as never }, [
      '36727850',
    ]);

    expect(res.isErr()).toBe(true);
  });

  it('displayName is always null while the derived column is broken', async () => {
    const { deps: d } = deps();
    const res = await makeOrganizationLabels(d, ['36727850']);
    const label = (res as unknown as { value: readonly Record<string, unknown>[] }).value[0];

    expect(label?.['displayName']).toBeNull();
  });
});
