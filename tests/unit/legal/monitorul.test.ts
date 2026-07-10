/**
 * Monitorul-Oficial (`mo/` area) — unit tests: mappers, the §6.1 enum
 * value-translation round-trip, filter-spec → SQL compilation, and the cursor
 * fhash equivalence across surfaces. Pure (no DB).
 */

import { describe, expect, it } from 'vitest';

import { isPlausibleMatch } from '@/modules/legal/mo/contributor.js';
import { moEdgesSpec, moIssuesSpec, moPublicationsSpec } from '@/modules/legal/mo/filters.js';
import {
  MO_EDGE_RESOLUTION_GQL,
  MO_MATCHED_VIA_GQL,
  MO_STATUS_KIND_GQL,
  mapEdge,
  mapIssue,
  mapPublication,
  mapStatusEvent,
  type MoActPublicationRow,
  type MoIssueRow,
  type MoLifecycleEdgeRow,
  type MoStatusEventRow,
} from '@/modules/legal/mo/mappers.js';
import { MO_EDGE_RESOLUTIONS, MO_MATCHED_VIA, MO_STATUS_KINDS } from '@/modules/legal/mo/types.js';
import {
  canonicalizeFilters,
  fhashFor,
  toConditionBuilders,
  toGraphQLInput,
  type FilterInput,
} from '@/modules/shared/index.js';

// ── mappers ────────────────────────────────────────────────────────────────────

describe('MO mappers', () => {
  it('maps an issue row (camelCase + part-code coercion)', () => {
    const row: MoIssueRow = {
      mo_issue_id: '10245',
      part_code: 'PI',
      mo_part: 1,
      issue_label: '632',
      issue_number: 632,
      issue_suffix: '',
      issue_year: 2006,
      issue_date: '2006-07-21',
      pdf_url: 'https://x/y.pdf',
      has_archive_index: true,
      has_emonitor_link: true,
      pdf_bytes: null,
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-02T00:00:00Z',
    };
    const m = mapIssue(row);
    expect(m.moIssueId).toBe('10245');
    expect(m.partCode).toBe('PI');
    expect(m.moPart).toBe(1);
    expect(m.issueLabel).toBe('632');
    expect(m.hasEmonitorLink).toBe(true);
  });

  it('maps a publication row and translates matchedVia DB value', () => {
    const row: MoActPublicationRow = {
      mo_act_key: 'abc',
      mo_issue_id: '10245',
      act_type: 'lege',
      act_number_norm: '334',
      act_year: 2006,
      issue_year: 2006,
      issuer_slug: '',
      title: 'Lege',
      act_date: '2006-07-17',
      act_id: '25592',
      resolution: 'unique',
      matched_via: 'act-year',
      source_pdf_url: 'https://x',
      first_seen_at: '2024-01-01T00:00:00Z',
      last_seen_at: '2024-01-01T00:00:00Z',
    };
    const m = mapPublication(row);
    expect(m.actId).toBe('25592');
    expect(m.resolution).toBe('unique');
    // The view model keeps the DB value; the GraphQL layer aliases it (§6.1).
    expect(m.matchedVia).toBe('act-year');
  });

  it('maps an edge row keeping the hyphenated mo-only resolution', () => {
    const row: MoLifecycleEdgeRow = {
      edge_id: '7',
      source_mo_act_key: 'src',
      relation: 'rectifica',
      target_raw: 'lege 334/2006',
      target_index: 0,
      target_act_type: 'lege',
      target_act_number: '334',
      target_act_year: 2006,
      target_issuer_slug: '',
      target_act_id: null,
      target_mo_act_key: 'tgt',
      resolution: 'mo-only',
      matched_via: null,
      method: 'citation',
      confidence: 0.8,
    };
    const m = mapEdge(row);
    expect(m.resolution).toBe('mo-only');
    expect(m.targetActId).toBeNull();
    expect(m.targetMoActKey).toBe('tgt'); // mo-only target reachable by the MO-local key
    expect(m.matchedVia).toBeNull();
  });

  it('drops an out-of-set status event kind (§2.4 guard), never throws', () => {
    const ok: MoStatusEventRow = {
      event_id: '1',
      act_id: '25592',
      event_kind: 'promulgare',
      effective_date: '2006-07-14',
      source_act_id: '209553',
    };
    const bad: MoStatusEventRow = { ...ok, event_id: '2', event_kind: 'abrogare-totala' };
    expect(mapStatusEvent(ok)?.eventKind).toBe('promulgare');
    expect(mapStatusEvent(bad)).toBeNull();
  });
});

// ── §6.1 enum value-translation round-trip ───────────────────────────────────────

describe('MO enum value-translation (§6.1)', () => {
  it('every edge-resolution DB value has exactly one GraphQL alias (and back)', () => {
    for (const dbVal of MO_EDGE_RESOLUTIONS) {
      const aliases = Object.entries(MO_EDGE_RESOLUTION_GQL).filter(([, v]) => v === dbVal);
      expect(aliases).toHaveLength(1);
    }
    // mo-only ↔ mo_only specifically (the hyphen case).
    expect(MO_EDGE_RESOLUTION_GQL['mo_only']).toBe('mo-only');
  });

  it('every status-kind DB value round-trips through the alias map', () => {
    for (const dbVal of MO_STATUS_KINDS) {
      const aliases = Object.entries(MO_STATUS_KIND_GQL).filter(([, v]) => v === dbVal);
      expect(aliases).toHaveLength(1);
    }
    expect(MO_STATUS_KIND_GQL['aprobare_oug']).toBe('aprobare-oug');
    expect(MO_STATUS_KIND_GQL['aprobare_og']).toBe('aprobare-og');
  });

  it('matched-via maps both hyphenated values', () => {
    for (const dbVal of MO_MATCHED_VIA) {
      const aliases = Object.entries(MO_MATCHED_VIA_GQL).filter(([, v]) => v === dbVal);
      expect(aliases).toHaveLength(1);
    }
    expect(MO_MATCHED_VIA_GQL['act_year']).toBe('act-year');
  });
});

// ── filter spec → SQL compilation ───────────────────────────────────────────────

describe('MO filter specs compile to parameterized SQL', () => {
  it('mo_issues year + partCode compile to eq + array overlap', () => {
    const input: FilterInput = { year: { eq: 2006 }, partCode: { in: ['PI', 'PII'] } };
    const built = toConditionBuilders(moIssuesSpec, input);
    expect(built.isOk()).toBe(true);
  });

  it('mo_edges resolution filter accepts the hyphenated DB value mo-only', () => {
    const input: FilterInput = { resolution: { in: ['mo-only', 'unique'] } };
    const built = toConditionBuilders(moEdgesSpec, input);
    expect(built.isOk()).toBe(true);
  });

  it('rejects an out-of-enum resolution value (InvalidInput)', () => {
    const input: FilterInput = { resolution: { in: ['bogus'] } };
    const built = toConditionBuilders(moEdgesSpec, input);
    expect(built.isErr()).toBe(true);
  });

  it('publications actId compiles as a string eq (bigint-safe, Codex #3)', () => {
    const input: FilterInput = { actId: { eq: '25592' } };
    const built = toConditionBuilders(moPublicationsSpec, input);
    expect(built.isOk()).toBe(true);
  });

  it('generated GraphQL input names follow the collection prefix', () => {
    expect(toGraphQLInput(moPublicationsSpec)).toContain('input MoPublicationsFilter');
    expect(toGraphQLInput(moEdgesSpec)).toContain('input MoEdgesFilter');
    expect(toGraphQLInput(moIssuesSpec)).toContain('input MoIssuesFilter');
  });
});

// ── cursor fhash equivalence (the tri-surface contract) ───────────────────────────

describe('MO cursor fhash (cross-surface determinism)', () => {
  it('identical logical filters produce one fhash regardless of key order', () => {
    const a: FilterInput = { actYear: { eq: 2006 }, issuerSlug: { in: ['guvernul-romaniei'] } };
    const b: FilterInput = { issuerSlug: { in: ['guvernul-romaniei'] }, actYear: { eq: 2006 } };
    expect(fhashFor(moPublicationsSpec, a)).toBe(fhashFor(moPublicationsSpec, b));
  });

  it('canonicalization folds int strings to numbers (REST≡GraphQL)', () => {
    const rest: FilterInput = { actYear: { eq: '2006' } };
    const graphql: FilterInput = { actYear: { eq: 2006 } };
    expect(canonicalizeFilters(moPublicationsSpec, rest)).toBe(
      canonicalizeFilters(moPublicationsSpec, graphql)
    );
  });

  it('a different filter set yields a different fhash', () => {
    const a: FilterInput = { actYear: { eq: 2006 } };
    const b: FilterInput = { actYear: { eq: 2007 } };
    expect(fhashFor(moPublicationsSpec, a)).not.toBe(fhashFor(moPublicationsSpec, b));
  });
});

// ── contributor issuer-match guard (Codex #5) ───────────────────────────────────

describe('MO contributor org-name → issuer-slug match guard', () => {
  it('accepts a clear name match (diacritics-folded token containment)', () => {
    expect(isPlausibleMatch('Ministerul Finanțelor Publice', 'ministerul-finantelor-publice')).toBe(
      true
    );
    expect(isPlausibleMatch('Banca Națională a României', 'banca-nationala-a-romaniei')).toBe(true);
  });

  it('rejects a spurious top-by-count hit whose name does not match', () => {
    // a random company name must NOT match the busiest issuer slug.
    expect(isPlausibleMatch('SC Profi Rom Food SRL', 'guvernul-romaniei')).toBe(false);
    expect(isPlausibleMatch('Primăria Cluj-Napoca', 'curtea-constitutionala-a-romaniei')).toBe(
      false
    );
  });
});
