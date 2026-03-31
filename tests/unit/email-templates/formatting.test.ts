import { describe, expect, it } from 'vitest';

import { formatNumberWithUnit } from '@/modules/email-templates/shell/templates/formatting.js';

describe('formatNumberWithUnit', () => {
  it('formats large decimal strings without converting through Number', () => {
    expect(formatNumberWithUnit('9007199254740993', 'RON', 'en')).toBe('9,007,199,254,740,993 RON');
    expect(formatNumberWithUnit('9007199254740993.25', 'RON', 'en')).toBe(
      '9,007,199,254,740,993.25 RON'
    );
  });
});
