import { describe, expect, it } from 'vitest';

import { jsonValuesAreEqual } from '@/modules/learning-progress/core/json-equality.js';

describe('jsonValuesAreEqual', () => {
  it('treats object key order as irrelevant', () => {
    expect(
      jsonValuesAreEqual(
        {
          key: 'custom-submit::global',
          nested: {
            source: 'manual',
            value: {
              alpha: 1,
              beta: true,
            },
          },
          sourceUrl: 'https://transparenta.eu/ro/learning/path/module/lesson-1',
          updatedAt: '2024-01-01T10:00:00.000Z',
        },
        {
          updatedAt: '2024-01-01T10:00:00.000Z',
          sourceUrl: 'https://transparenta.eu/ro/learning/path/module/lesson-1',
          nested: {
            value: {
              beta: true,
              alpha: 1,
            },
            source: 'manual',
          },
          key: 'custom-submit::global',
        }
      )
    ).toBe(true);
  });

  it('treats missing and undefined object fields as equal', () => {
    expect(
      jsonValuesAreEqual(
        {
          key: 'custom-submit::global',
          sourceUrl: undefined,
          nested: {
            value: 1,
            extra: undefined,
          },
        },
        {
          key: 'custom-submit::global',
          nested: {
            value: 1,
          },
        }
      )
    ).toBe(true);
  });

  it('keeps array order significant', () => {
    expect(
      jsonValuesAreEqual(
        {
          auditEvents: ['submitted', 'evaluated'],
        },
        {
          auditEvents: ['evaluated', 'submitted'],
        }
      )
    ).toBe(false);
  });
});
