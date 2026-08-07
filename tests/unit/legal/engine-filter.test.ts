/**
 * Filter translation — the test that matters is the one about SILENT BREADTH.
 *
 * A filter clause the engine cannot express must never be dropped on the floor:
 * the engine would then answer a broader question than the one asked, and the
 * extra rows are indistinguishable from real hits. Every such field has to come
 * back named so the caller can refuse.
 */

import { describe, expect, it } from 'vitest';

import { LEGAL_LIVE_STATUSES, toEngineFilter } from '@/modules/legal/core/legal-engine-filter.js';

describe('toEngineFilter', () => {
  it('applies the live-status default when history was not asked for', () => {
    const { filter, unsupported } = toEngineFilter({}, false);
    expect(filter.status).toEqual([...LEGAL_LIVE_STATUSES]);
    expect(unsupported).toEqual([]);
  });

  it('leaves status open when history WAS asked for', () => {
    const { filter } = toEngineFilter({}, true);
    expect(filter.status).toBeUndefined();
  });

  it('INTERSECTS an explicit status with the live set instead of letting it win', () => {
    // The SQL path ANDs the two. Letting the explicit list replace the default
    // made the same request return abrogated acts from the engine and none
    // from Postgres — two surfaces disagreeing about what "current law" means.
    const { filter } = toEngineFilter({ status: { in: ['abrogat'] } }, false);
    expect(filter.status).toEqual([]);
  });

  it('keeps the live members of a mixed explicit status', () => {
    const { filter } = toEngineFilter({ status: { in: ['abrogat', 'in-vigoare'] } }, false);
    expect(filter.status).toEqual(['in-vigoare']);
  });

  it('lets an explicit status stand when history WAS asked for', () => {
    const { filter } = toEngineFilter({ status: { in: ['abrogat'] } }, true);
    expect(filter.status).toEqual(['abrogat']);
  });

  it('translates every supported family', () => {
    const { filter, unsupported } = toEngineFilter(
      {
        actType: { in: ['lege', 'oug'] },
        issuerSlug: { eq: 'parlamentul' },
        domain: { in: ['fiscal-si-bugetar'] },
        category: { eq: 'lege' },
        penaltiesMentioned: { eq: true },
        year: { eq: 2015 },
        yearFrom: { gte: 2000 },
        yearTo: { lte: 2020 },
      },
      true
    );
    expect(unsupported).toEqual([]);
    expect(filter).toEqual({
      actType: ['lege', 'oug'],
      issuerSlug: ['parlamentul'],
      domain: ['fiscal-si-bugetar'],
      category: ['lege'],
      penaltiesMentioned: true,
      year: 2015,
      yearFrom: 2000,
      yearTo: 2020,
    });
  });

  it('NAMES an exclude clause instead of silently widening the answer', () => {
    const { unsupported } = toEngineFilter({ exclude: { actType: { in: ['ordin'] } } }, true);
    expect(unsupported).toContain('exclude');
  });

  it('NAMES a field the engine filter does not carry', () => {
    const { unsupported } = toEngineFilter({ fiscalImpactNull: { isNull: true } }, true);
    expect(unsupported).toContain('fiscalImpactNull');
  });

  it('NAMES an unsupported operator on a supported field', () => {
    const { unsupported } = toEngineFilter({ actType: { prefix: 'leg' } }, true);
    expect(unsupported).toContain('actType.prefix');
  });

  it('NAMES a value of the wrong shape rather than coercing it', () => {
    const { unsupported } = toEngineFilter({ year: { eq: 'douamiicincisprezece' } }, true);
    expect(unsupported).toContain('year.eq');
  });

  it('NAMES filter.q rather than accepting and discarding it', () => {
    // filter.q is a SECOND text constraint, distinct from the query. Dropping
    // it silently returned the unnarrowed answer under the narrower label.
    const { unsupported } = toEngineFilter({ q: { contains: 'taxe' } }, true);
    expect(unsupported).toContain('q');
  });

  it('NAMES an operator that is valid on another field but not this one', () => {
    // MCP takes an open record, so this shape is reachable; it used to become
    // an EXACT terms filter and answer a different question.
    const { unsupported } = toEngineFilter({ actType: { contains: 'leg' } }, true);
    expect(unsupported).toContain('actType.contains');
  });

  it('NAMES a range operator applied to an exact-match field', () => {
    const { unsupported } = toEngineFilter({ year: { gte: 2015 } }, true);
    expect(unsupported).toContain('year.gte');
  });
});
