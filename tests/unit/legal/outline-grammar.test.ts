/**
 * The outline grammar: which grammar tokens are TOC headings, and which are
 * deliberately NOT.
 *
 * The exclusions are the point. This grammar decides what a reader sees as the
 * structure of a law, and the interesting failure is not a crash — it is a
 * table of contents that looks plausible and is wrong.
 *
 * Measured against the current v4.1 generation in prod on 2026-08-08
 * (scrapper prod-db/LEGAL_NODES_V41_SERVING_AUDIT_2026-08-08.md).
 */

import { describe, expect, it } from 'vitest';

import {
  OUTLINE_DEPTH_RANK,
  OUTLINE_HEADING_TYPES,
  OUTLINE_MAX_DEPTH_DEFAULT,
  outlineDepthFor,
  outlineTypesForDepth,
  type OutlineHeadingType,
} from '@/modules/legal/core/outline.js';

describe('outline grammar', () => {
  it('excludes POR — a portion wrapper is not a Part', () => {
    // PRT and POR both write node_kind='parte', which is why the grammar is
    // keyed on node_type. In prod: PRT is 2,111 containers, all labeled, all
    // with a title child, at most 49 per document. POR is 43,526 containers,
    // 212 labeled, ZERO with a title child, up to 3,064 in ONE document.
    // Including it put blank rows in the default TOC of 5,031 documents.
    expect(OUTLINE_HEADING_TYPES).not.toContain('POR');
    expect(OUTLINE_HEADING_TYPES).toContain('PRT');
    expect(outlineTypesForDepth(9)).not.toContain('POR');
  });

  it('keys on grammar tokens, not on node_kind', () => {
    // A node_kind-keyed grammar cannot express the PRT/POR split at all: both
    // rows read 'parte'. If this list ever holds a lowercase kind, the filter
    // has silently regressed to the ambiguous vocabulary.
    for (const type of OUTLINE_HEADING_TYPES) {
      expect(type).toBe(type.toUpperCase());
    }
  });

  it('gives every heading type a depth rank', () => {
    for (const type of OUTLINE_HEADING_TYPES) {
      expect(OUTLINE_DEPTH_RANK[type]).toBeGreaterThan(0);
    }
    const ranked = Object.keys(OUTLINE_DEPTH_RANK) as OutlineHeadingType[];
    expect(ranked.sort()).toEqual([...OUTLINE_HEADING_TYPES].sort());
  });

  it('restarts annexes at the root instead of nesting them under the last section', () => {
    // An annex is a program of its own; ranking it below `sectiune` would
    // indent a whole annex under whatever section happened to precede it.
    expect(OUTLINE_DEPTH_RANK.ANX).toBe(1);
    expect(OUTLINE_DEPTH_RANK.APN).toBe(2);
    expect(OUTLINE_DEPTH_RANK.ANX).toBeLessThan(OUTLINE_DEPTH_RANK.SEC);
  });

  it('keeps articles out of the default depth budget', () => {
    // p99 is 83 outline nodes per document but the max is 3,083: a default
    // outline that included articles would ship the Codul Fiscal's entire
    // article list on first paint.
    const shallow = outlineTypesForDepth(OUTLINE_MAX_DEPTH_DEFAULT);
    expect(shallow).not.toContain('ART');
    expect(shallow).toEqual(['CRT', 'PRT', 'TTL', 'ANX', 'APN']);
  });

  it('admits every type once the budget reaches the deepest rank', () => {
    expect(outlineTypesForDepth(7)).toEqual([...OUTLINE_HEADING_TYPES]);
  });

  it('returns nothing for a budget below the shallowest rank', () => {
    // The repo short-circuits on an empty list rather than sending `IN ()`.
    expect(outlineTypesForDepth(0)).toEqual([]);
  });
});

describe('outlineDepthFor', () => {
  it('ranks heading types and returns null for everything else', () => {
    expect(outlineDepthFor('ART')).toBe(7);
    expect(outlineDepthFor('ANX')).toBe(1);
    // The cases that made the old cast return undefined under a `number` type:
    // a demoted portion wrapper, an ordinary structural node, and no node.
    expect(outlineDepthFor('POR')).toBeNull();
    expect(outlineDepthFor('ALN')).toBeNull();
    expect(outlineDepthFor(null)).toBeNull();
  });
});
