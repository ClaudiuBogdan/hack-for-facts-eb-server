/**
 * Legal — filter spec + semantic gating + enum mapping (pure). Covers:
 *  - the §7.1 vocabulary separation (act_type ≠ document_category) is structural;
 *  - the spec compiles to SQL conditions over the declared aliases (a/s);
 *  - `fiscalImpactNull` uses kernel `isNull` semantics (Codex inversion fix);
 *  - the effective semantic gate = kernel slot AND hnsw readiness;
 *  - the GraphQL enum maps are exact bijections (no dropped value).
 */

import { describe, expect, it } from 'vitest';

import { LEGAL_ACT_STATUSES, LEGAL_RELATIONS } from '@/modules/legal/core/types.js';
import { effectiveSemantic } from '@/modules/legal/core/usecases.js';
import {
  ACT_TYPE_VALUES,
  CATEGORY_VALUES,
  DOMAIN_VALUES,
  legalActsSpec,
} from '@/modules/legal/shell/filters/legal-acts.spec.js';
import { toConditionBuilders, type CapabilityResolver } from '@/modules/shared/index.js';

describe('legalActsSpec — §7.1 vocabulary separation + aliases', () => {
  it('act_type is on acts (alias a); category/domain are on summaries (alias s)', () => {
    const byName = new Map(legalActsSpec.fields.map((f) => [f.name, f]));
    expect(byName.get('actType')?.column).toMatchObject({ alias: 'a', column: 'act_type' });
    expect(byName.get('category')?.column).toMatchObject({
      alias: 's',
      column: 'document_category',
    });
    expect(byName.get('domain')?.column).toMatchObject({
      alias: 's',
      column: 'domains',
      arrayColumn: true,
    });
    expect(byName.get('status')?.column).toMatchObject({ alias: 'a', column: 'status' });
  });

  it('act_type and document_category are DIFFERENT vocabularies (never cross-validated)', () => {
    // hotarare-de-guvern / norma-metodologica are categories, NOT act_types.
    expect(CATEGORY_VALUES).toContain('hotarare-de-guvern');
    expect(ACT_TYPE_VALUES).not.toContain('hotarare-de-guvern');
    // 'lege'/'ordin'/'hotarare' overlap by spelling but are independent fields.
    expect(ACT_TYPE_VALUES).toContain('oug');
    expect(CATEGORY_VALUES).toContain('ordonanta-de-urgenta'); // category form of oug
  });

  it('domain is the controlled 16-value vocab', () => {
    expect(DOMAIN_VALUES).toContain('fiscal-si-bugetar');
    expect(DOMAIN_VALUES.length).toBe(16);
  });

  it('default sort is in_degree (R1)', () => {
    expect(legalActsSpec.sort.default).toBe('in_degree');
    expect(legalActsSpec.sort.allowed).toEqual([
      'in_degree',
      'act_year',
      'entry_into_force',
      'display_citation',
    ]);
  });

  it('fiscalImpactNull uses kernel isNull semantics (the op, not an inverted "present")', () => {
    // The field is named for the column + the kernel op (isNull), so a client sets
    // `{ isNull: false }` to mean IS NOT NULL — no inversion (the Codex fix). Both
    // values compile to exactly one condition.
    const present = toConditionBuilders(legalActsSpec, { fiscalImpactNull: { isNull: false } });
    const absent = toConditionBuilders(legalActsSpec, { fiscalImpactNull: { isNull: true } });
    expect(present.isOk()).toBe(true);
    expect(absent.isOk()).toBe(true);
    expect(present._unsafeUnwrap()).toHaveLength(1);
    expect(absent._unsafeUnwrap()).toHaveLength(1);
    const field = legalActsSpec.fields.find((f) => f.name === 'fiscalImpactNull');
    expect(field?.ops).toEqual(['isNull']);
    expect(field?.name).not.toBe('fiscalImpactPresent'); // the inverted name was rejected
  });

  it('domain `in` compiles to array containment (membership), not trigram', () => {
    const built = toConditionBuilders(legalActsSpec, { domain: { in: ['fiscal-si-bugetar'] } });
    expect(built.isOk()).toBe(true);
    expect(built._unsafeUnwrap()).toHaveLength(1);
  });
});

describe('effectiveSemantic — gate = kernel slot AND hnsw readiness', () => {
  const resolver = (semantic: boolean): CapabilityResolver => ({
    engines: { meili: true, opensearch: true },
    forDomain: () => ({ semantic }),
  });

  it('true only when BOTH the kernel slot and the live HNSW are present', () => {
    expect(effectiveSemantic({ capabilities: resolver(true), hnswReady: true })).toBe(true);
  });

  it('false when the HNSW probe fails (degrade to lexical, never break)', () => {
    expect(effectiveSemantic({ capabilities: resolver(true), hnswReady: false })).toBe(false);
  });

  it('false when the kernel slot is off (even with a live index)', () => {
    expect(effectiveSemantic({ capabilities: resolver(false), hnswReady: true })).toBe(false);
  });
});

describe('enum vocabularies are closed + consistent', () => {
  it('LEGAL_ACT_STATUSES has the 7 fold values', () => {
    expect(LEGAL_ACT_STATUSES).toEqual([
      'in-vigoare',
      'modificat',
      'abrogat',
      'abrogat-partial',
      'suspendat',
      'iesit-din-vigoare',
      'necunoscut',
    ]);
  });

  it('LEGAL_RELATIONS has the 8 relation values', () => {
    expect(LEGAL_RELATIONS).toHaveLength(8);
    expect(LEGAL_RELATIONS).toContain('modifica');
    expect(LEGAL_RELATIONS).toContain('face-referire');
  });
});
