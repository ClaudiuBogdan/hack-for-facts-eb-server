/**
 * Parliament unit tests — the member-speech full-text `q` predicate
 * (`speechSearchPredicate`). Covers (a) LIKE-wildcard escaping of user input and
 * (b) the speech_texts branch shape: an EXISTS over parliament.speech_texts is
 * present ONLY when the table is usable (`hasTexts=true`), never otherwise (a
 * missing relation would fail at PARSE time).
 */

import { Kysely, PostgresDialect } from 'kysely';
import { describe, expect, it } from 'vitest';

import { speechSearchPredicate } from '@/modules/parliament/shell/repo/parliament-repo.js';

// A no-connection Kysely just for compilation (compile is pure — never executes).
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: null as unknown as never }),
});

const compile = (q: string, hasTexts: boolean): { sql: string; parameters: readonly unknown[] } => {
  const { sql: text, parameters } = speechSearchPredicate(q, hasTexts).compile(db);
  return { sql: text, parameters };
};

describe('speechSearchPredicate — LIKE-wildcard escaping', () => {
  it('escapes %, _ and backslash in the user token and passes it as a parameter (never inlined)', () => {
    const { sql: text, parameters } = compile('a%b_c\\d', false);
    // The needle is a bound parameter (no user text spliced into the SQL string).
    expect(parameters).toContain('%a\\%b\\_c\\\\d%');
    // ILIKE ... ESCAPE '\' so the escaped metacharacters match literally.
    expect(text.toLowerCase()).toContain('ilike');
    expect(text).toContain("escape '\\'");
  });

  it('leaves a plain token unescaped inside the % wrap', () => {
    const { parameters } = compile('lege', false);
    expect(parameters).toContain('%lege%');
  });

  it('escapes a token that is ONLY wildcards', () => {
    const { parameters } = compile('%_\\', false);
    expect(parameters).toContain('%\\%\\_\\\\%');
  });
});

describe('speechSearchPredicate — speech_texts branch shape', () => {
  it('hasTexts=false → title/summary ILIKE only, NO speech_texts EXISTS', () => {
    const { sql: text, parameters } = compile('lege', false);
    expect(text).not.toContain('speech_texts');
    expect(text.toLowerCase()).not.toContain('exists');
    expect(text).toContain('s.title');
    expect(text).toContain('s.summary');
    // title + summary each bind the escaped needle → 2 parameters, no full_text bind.
    expect(parameters.filter((p) => p === '%lege%')).toHaveLength(2);
  });

  it('hasTexts=true → adds an EXISTS over parliament.speech_texts.full_text', () => {
    const { sql: text, parameters } = compile('lege', true);
    expect(text.toLowerCase()).toContain('exists');
    expect(text).toContain('parliament.speech_texts');
    expect(text).toContain('full_text');
    expect(text).toContain('s.title');
    expect(text).toContain('s.summary');
    // title + summary + full_text all reuse the SAME escaped needle.
    expect(parameters.filter((p) => p === '%lege%')).toHaveLength(3);
  });
});
