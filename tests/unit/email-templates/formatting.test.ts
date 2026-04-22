import { describe, expect, it } from 'vitest';

import {
  formatTemplateDate,
  formatNumberWithUnit,
  formatTemplateTimestamp,
} from '@/modules/email-templates/shell/templates/formatting.js';

describe('formatNumberWithUnit', () => {
  it('formats large decimal strings without converting through Number', () => {
    expect(formatNumberWithUnit('9007199254740993', 'RON', 'en')).toBe('9,007,199,254,740,993 RON');
    expect(formatNumberWithUnit('9007199254740993.25', 'RON', 'en')).toBe(
      '9,007,199,254,740,993.25 RON'
    );
  });
});

describe('formatTemplateTimestamp', () => {
  it('formats template dates using Romanian locale', () => {
    expect(formatTemplateTimestamp('2026-04-03T10:00:00.000Z')).toBe('3 aprilie 2026 la 10:00');
  });
});

describe('formatTemplateDate', () => {
  it('formats template dates using Romanian day month year', () => {
    expect(formatTemplateDate('2026-05-10')).toBe('10 mai 2026');
  });
});
