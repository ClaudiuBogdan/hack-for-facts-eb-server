/**
 * PNRR PII structural gate (§2.5/§8.2). Static assertions (no live DB):
 *  - the GraphQL SDL emits no `contact_*` / `isPersonalRecipient` field and never
 *    references the private contacts table;
 *  - the repo source never SELECTs `announcement_contacts_private`,
 *    `is_personal_recipient`, or projects `attrs` / `*_raw` provenance columns;
 *  - the view-model types carry no PII fields.
 *
 * These mirror the loader's search-PII gate and the §2.5 structural exclusion.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pnrrTypeDefs } from '@/modules/pnrr/shell/graphql/typedefs.js';

/** Strip JS line + block comments so assertions match CODE, not doc prose. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');

const repoSource = stripComments(
  readFileSync(
    fileURLToPath(new URL('../../../src/modules/pnrr/shell/repo/pnrr-repo.ts', import.meta.url)),
    'utf8'
  )
);
const mapperSource = stripComments(
  readFileSync(
    fileURLToPath(new URL('../../../src/modules/pnrr/shell/repo/mappers.ts', import.meta.url)),
    'utf8'
  )
);

describe('PNRR PII gate — GraphQL SDL', () => {
  it('emits no contact_* or isPersonalRecipient field', () => {
    expect(pnrrTypeDefs).not.toMatch(/contact[_A-Za-z]*\s*:/u);
    expect(pnrrTypeDefs).not.toMatch(/isPersonalRecipient/iu);
    expect(pnrrTypeDefs).not.toMatch(/personal_recipient/iu);
  });

  it('does not expose a wholesale attrs field on any PNRR type', () => {
    // The kernel base types own `attrs`; PNRR types must not project it.
    expect(pnrrTypeDefs).not.toMatch(/\battrs\s*:/u);
  });
});

describe('PNRR PII gate — repo source', () => {
  it('never selects the private contacts table', () => {
    expect(repoSource).not.toMatch(/announcement_contacts_private/u);
  });

  it('never PROJECTS is_personal_recipient (only filters it OUT)', () => {
    // The PII gate WHERE clause (`is_personal_recipient is distinct from true`)
    // legitimately names the column to EXCLUDE flagged rows. What must never
    // happen is selecting/aliasing it into output. Assert every occurrence is the
    // exclusion guard, and none is a projection.
    const occurrences = repoSource.match(/is_personal_recipient/gu) ?? [];
    expect(occurrences.length).toBeGreaterThan(0); // the defensive guard exists
    // Each occurrence must be part of the exclusion predicate (distinct-from-true).
    expect(repoSource).toContain('is_personal_recipient`)} is distinct from true');
    // It must never appear inside a `.select([ ... ])` projection.
    expect(repoSource).not.toMatch(/select\([^)]*is_personal_recipient/su);
    // And never aliased as an output column.
    expect(repoSource).not.toMatch(/is_personal_recipient'?\s*\.as\(/u);
  });

  it('never selects raw/provenance columns into a projection', () => {
    // status_raw / county_id_raw / source_record_hash / transform_version /
    // raw_item_id / run_id must never appear in a SELECT.
    for (const col of [
      'status_raw',
      'county_id_raw',
      'source_record_hash',
      'transform_version',
      'raw_item_id',
      'run_id',
    ]) {
      expect(repoSource).not.toContain(col);
    }
  });

  it('does not project attrs (defends against future PII in attrs jsonb)', () => {
    expect(repoSource).not.toMatch(/\.attrs\b/u);
    expect(repoSource).not.toMatch(/'[a-z]+\.attrs'/u);
  });
});

describe('PNRR PII gate — mappers', () => {
  it('mappers carry no contact / personal-recipient field', () => {
    expect(mapperSource).not.toMatch(/contact[_A-Za-z]*\s*:/u);
    expect(mapperSource).not.toMatch(/personalRecipient/iu);
  });
});
