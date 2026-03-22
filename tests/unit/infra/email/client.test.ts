import { describe, expect, it } from 'vitest';

import { redactEmailAddress } from '@/infra/email/client.js';

describe('redactEmailAddress', () => {
  it('redacts short local parts instead of logging the full address', () => {
    expect(redactEmailAddress('a@example.com')).toBe('a***@example.com');
    expect(redactEmailAddress('ab@example.com')).toBe('ab***@example.com');
    expect(redactEmailAddress('abc@example.com')).toBe('abc***@example.com');
  });

  it('keeps only the first three characters for longer local parts', () => {
    expect(redactEmailAddress('abcdef@example.com')).toBe('abc***@example.com');
  });

  it('falls back to a placeholder for malformed input', () => {
    expect(redactEmailAddress('not-an-email')).toBe('***');
  });
});
