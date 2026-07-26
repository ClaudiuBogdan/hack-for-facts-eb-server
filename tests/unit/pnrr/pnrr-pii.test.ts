/**
 * PNRR PII structural gate (§2.5/§8.2). Static assertions (no live DB):
 *  - the GraphQL SDL emits no `contact_*` / `isPersonalRecipient` field and never
 *    references the private contacts table;
 *  - the repo reads the default-deny public payments view and never SELECTs
 *    `announcement_contacts_private`, `is_personal_recipient`, or projects
 *    private identifiers / raw provenance;
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

  it('reads payments only through the default-deny public view', () => {
    expect(repoSource).toContain('pnrr.api_payments');
    expect(repoSource).not.toContain("selectFrom('pnrr.payments");
    expect(repoSource).not.toMatch(/\bfrom pnrr\.payments\b/u);
    expect(repoSource).not.toContain('is_personal_recipient');
  });

  it('reads commitments and procurement only through public barrier views', () => {
    for (const view of [
      'pnrr.api_commitments',
      'pnrr.api_commitment_snapshots',
      'pnrr.api_procurement_announcements',
      'pnrr.api_procurement_lots',
      'pnrr.api_procurement_acquisitions',
      'pnrr.api_procurement_participants',
    ]) {
      expect(repoSource).toContain(view);
    }
    for (const table of [
      'commitments',
      'commitment_snapshots',
      'announcements',
      'lots',
      'acquisitions',
      'contractors',
    ]) {
      expect(repoSource).not.toMatch(
        new RegExp(`(?:selectFrom\\('|from |join )pnrr\\.${table}\\b`, 'u')
      );
    }
  });

  it('never selects raw/provenance columns into a projection', () => {
    // Row-level source internals must never appear in a public projection.
    // `run_id` is intentionally public as the optimistic release token and
    // `status_raw` is the source-native public lifecycle label.
    for (const col of ['county_id_raw', 'source_record_hash', 'transform_version', 'raw_item_id']) {
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
