/**
 * Unit tests for telemetry span attribute helpers
 *
 * These tests verify that the attribute helper functions correctly interact
 * with OpenTelemetry spans. We use in-memory fake spans (not mocking libraries)
 * following the project's testing conventions.
 */

import { SpanStatusCode, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTR,
  recordError,
  setAnalyticsContext,
  setAttribute,
  setBudgetClassificationContext,
  setBudgetSectorContext,
  setEntityContext,
  setFilterCount,
  setPeriodContext,
  setQueryResultContext,
  setUatContext,
} from '@/infra/telemetry/attributes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake Span Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fake span for testing attribute setters.
 * Records all setAttribute and setStatus calls for verification.
 */
const createFakeSpan = () => {
  const attributes: Record<string, string | number | boolean> = {};
  const exceptions: Error[] = [];
  let status: { code: SpanStatusCode; message?: string } | undefined;

  const fakeSpanContext: SpanContext = {
    traceId: 'abc123def456ghi789jkl012mno345pq',
    spanId: 'rst678uvw901',
    traceFlags: 1,
  };

  const fakeSpan: Span = {
    setAttribute: (key: string, value: string | number | boolean) => {
      attributes[key] = value;
      return fakeSpan;
    },
    setAttributes: (attrs: Record<string, string | number | boolean>) => {
      Object.assign(attributes, attrs);
      return fakeSpan;
    },
    setStatus: (newStatus: { code: SpanStatusCode; message?: string }) => {
      status = newStatus;
      return fakeSpan;
    },
    recordException: (exception: Error) => {
      exceptions.push(exception);
    },
    spanContext: () => fakeSpanContext,
    // Other methods required by Span interface (no-ops for testing)
    addEvent: () => fakeSpan,
    addLink: () => fakeSpan,
    addLinks: () => fakeSpan,
    updateName: () => fakeSpan,
    end: () => {
      // No-op for testing - span ending is not relevant for attribute tests
    },
    isRecording: () => true,
  };

  return {
    span: fakeSpan,
    getAttributes: () => attributes,
    getExceptions: () => exceptions,
    getStatus: () => status,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup - Tracer Provider Override
// ─────────────────────────────────────────────────────────────────────────────

let fakeSpanHolder: ReturnType<typeof createFakeSpan> | undefined;

/**
 * Sets up a fake tracer that returns our test span.
 * This allows the attribute helpers to find an "active" span.
 */
const setupFakeTracer = () => {
  fakeSpanHolder = createFakeSpan();

  // Override trace.getActiveSpan to return our fake span
  const originalGetActiveSpan = trace.getActiveSpan;

  // We need to monkey-patch for testing since trace.getActiveSpan() reads from context
  // This is a legitimate testing technique, not a mocking library
  (trace as { getActiveSpan: () => Span | undefined }).getActiveSpan = () => fakeSpanHolder?.span;

  return () => {
    // Restore original
    (trace as { getActiveSpan: () => Span | undefined }).getActiveSpan = originalGetActiveSpan;
    fakeSpanHolder = undefined;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ATTR constants', () => {
  it('exports entity attribute names', () => {
    expect(ATTR.ENTITY_CUI).toBe('transparenta.entity.cui');
    expect(ATTR.ENTITY_NAME).toBe('transparenta.entity.name');
    expect(ATTR.ENTITY_TYPE).toBe('transparenta.entity.type');
  });

  it('exports UAT attribute names', () => {
    expect(ATTR.UAT_ID).toBe('transparenta.uat.id');
    expect(ATTR.UAT_NAME).toBe('transparenta.uat.name');
    expect(ATTR.UAT_COUNTY).toBe('transparenta.uat.county');
  });

  it('exports analytics attribute names', () => {
    expect(ATTR.ANALYTICS_PERIOD_TYPE).toBe('transparenta.analytics.period_type');
    expect(ATTR.ANALYTICS_NORMALIZATION).toBe('transparenta.analytics.normalization');
    expect(ATTR.ANALYTICS_YEAR).toBe('transparenta.analytics.year');
    expect(ATTR.ANALYTICS_QUARTER).toBe('transparenta.analytics.quarter');
    expect(ATTR.ANALYTICS_MONTH).toBe('transparenta.analytics.month');
  });

  it('exports budget attribute names', () => {
    expect(ATTR.BUDGET_SECTOR_ID).toBe('transparenta.budget.sector_id');
    expect(ATTR.BUDGET_CLASSIFICATION).toBe('transparenta.budget.classification');
    expect(ATTR.BUDGET_FUNDING_SOURCE).toBe('transparenta.budget.funding_source');
  });

  it('exports query attribute names', () => {
    expect(ATTR.QUERY_FILTER_COUNT).toBe('transparenta.query.filter_count');
    expect(ATTR.QUERY_RESULT_COUNT).toBe('transparenta.query.result_count');
    expect(ATTR.QUERY_PAGINATION_OFFSET).toBe('transparenta.query.pagination_offset');
    expect(ATTR.QUERY_PAGINATION_LIMIT).toBe('transparenta.query.pagination_limit');
  });
});

describe('setEntityContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets entity CUI attribute', () => {
    setEntityContext('12345678');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ENTITY_CUI]).toBe('12345678');
  });

  it('sets entity name when provided', () => {
    setEntityContext('12345678', 'Test Entity');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ENTITY_CUI]).toBe('12345678');
    expect(attributes?.[ATTR.ENTITY_NAME]).toBe('Test Entity');
  });

  it('sets entity type when provided', () => {
    setEntityContext('12345678', 'Test Entity', 'PRIMARIE');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ENTITY_CUI]).toBe('12345678');
    expect(attributes?.[ATTR.ENTITY_NAME]).toBe('Test Entity');
    expect(attributes?.[ATTR.ENTITY_TYPE]).toBe('PRIMARIE');
  });

  it('does not set optional attributes when not provided', () => {
    setEntityContext('12345678');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ENTITY_CUI]).toBe('12345678');
    expect(attributes?.[ATTR.ENTITY_NAME]).toBeUndefined();
    expect(attributes?.[ATTR.ENTITY_TYPE]).toBeUndefined();
  });
});

describe('setUatContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets UAT ID attribute', () => {
    setUatContext(123);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.UAT_ID]).toBe(123);
  });

  it('sets UAT name when provided', () => {
    setUatContext(123, 'București');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.UAT_ID]).toBe(123);
    expect(attributes?.[ATTR.UAT_NAME]).toBe('București');
  });

  it('sets UAT county when provided', () => {
    setUatContext(123, 'Cluj-Napoca', 'Cluj');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.UAT_ID]).toBe(123);
    expect(attributes?.[ATTR.UAT_NAME]).toBe('Cluj-Napoca');
    expect(attributes?.[ATTR.UAT_COUNTY]).toBe('Cluj');
  });
});

describe('setAnalyticsContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets period type and normalization attributes', () => {
    setAnalyticsContext('yearly', 'per_capita');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ANALYTICS_PERIOD_TYPE]).toBe('yearly');
    expect(attributes?.[ATTR.ANALYTICS_NORMALIZATION]).toBe('per_capita');
  });

  it('sets quarterly period type', () => {
    setAnalyticsContext('quarterly', 'absolute');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ANALYTICS_PERIOD_TYPE]).toBe('quarterly');
    expect(attributes?.[ATTR.ANALYTICS_NORMALIZATION]).toBe('absolute');
  });
});

describe('setPeriodContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets year attribute', () => {
    setPeriodContext(2024);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ANALYTICS_YEAR]).toBe(2024);
  });

  it('sets year and quarter attributes', () => {
    setPeriodContext(2024, 3);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ANALYTICS_YEAR]).toBe(2024);
    expect(attributes?.[ATTR.ANALYTICS_QUARTER]).toBe(3);
  });

  it('sets year, quarter, and month attributes', () => {
    setPeriodContext(2024, 3, 9);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.ANALYTICS_YEAR]).toBe(2024);
    expect(attributes?.[ATTR.ANALYTICS_QUARTER]).toBe(3);
    expect(attributes?.[ATTR.ANALYTICS_MONTH]).toBe(9);
  });
});

describe('setBudgetSectorContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets budget sector ID attribute', () => {
    setBudgetSectorContext(42);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.BUDGET_SECTOR_ID]).toBe(42);
  });
});

describe('setBudgetClassificationContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets classification attribute', () => {
    setBudgetClassificationContext('65.10.01');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.BUDGET_CLASSIFICATION]).toBe('65.10.01');
  });

  it('sets classification and funding source attributes', () => {
    setBudgetClassificationContext('65.10.01', 'BUGET_LOCAL');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.BUDGET_CLASSIFICATION]).toBe('65.10.01');
    expect(attributes?.[ATTR.BUDGET_FUNDING_SOURCE]).toBe('BUGET_LOCAL');
  });
});

describe('setQueryResultContext', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets result count attribute', () => {
    setQueryResultContext(100);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.QUERY_RESULT_COUNT]).toBe(100);
  });

  it('sets result count and pagination attributes', () => {
    setQueryResultContext(100, 20, 50);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.QUERY_RESULT_COUNT]).toBe(100);
    expect(attributes?.[ATTR.QUERY_PAGINATION_OFFSET]).toBe(20);
    expect(attributes?.[ATTR.QUERY_PAGINATION_LIMIT]).toBe(50);
  });

  it('handles zero result count', () => {
    setQueryResultContext(0);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.QUERY_RESULT_COUNT]).toBe(0);
  });
});

describe('setFilterCount', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets filter count attribute', () => {
    setFilterCount(5);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.QUERY_FILTER_COUNT]).toBe(5);
  });

  it('handles zero filter count', () => {
    setFilterCount(0);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.[ATTR.QUERY_FILTER_COUNT]).toBe(0);
  });
});

describe('recordError', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('records error from Error object', () => {
    const error = new Error('Something went wrong');
    recordError(error);

    const exceptions = fakeSpanHolder?.getExceptions() ?? [];
    const status = fakeSpanHolder?.getStatus();

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.message).toBe('Something went wrong');
    expect(status?.code).toBe(SpanStatusCode.ERROR);
    expect(status?.message).toBe('Something went wrong');
  });

  it('records error from string message', () => {
    recordError('Database connection failed');

    const exceptions = fakeSpanHolder?.getExceptions() ?? [];
    const status = fakeSpanHolder?.getStatus();

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.message).toBe('Database connection failed');
    expect(status?.code).toBe(SpanStatusCode.ERROR);
    expect(status?.message).toBe('Database connection failed');
  });

  it('sets error type attribute when provided', () => {
    const error = new Error('Timeout');
    recordError(error, 'TimeoutError');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.['error.type']).toBe('TimeoutError');
  });

  it('does not set error type when not provided', () => {
    recordError(new Error('Test'));

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.['error.type']).toBeUndefined();
  });
});

describe('setAttribute', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupFakeTracer();
  });

  afterEach(() => {
    cleanup();
  });

  it('sets string attribute', () => {
    setAttribute('transparenta.custom.key', 'value');

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.['transparenta.custom.key']).toBe('value');
  });

  it('sets number attribute', () => {
    setAttribute('transparenta.custom.count', 42);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.['transparenta.custom.count']).toBe(42);
  });

  it('sets boolean attribute', () => {
    setAttribute('transparenta.custom.flag', true);

    const attributes = fakeSpanHolder?.getAttributes();
    expect(attributes?.['transparenta.custom.flag']).toBe(true);
  });
});

describe('behavior when no active span', () => {
  it('setEntityContext does not throw when no span is active', () => {
    // No setup of fake tracer, so getActiveSpan returns undefined
    expect(() => {
      setEntityContext('12345678');
    }).not.toThrow();
  });

  it('setAnalyticsContext does not throw when no span is active', () => {
    expect(() => {
      setAnalyticsContext('yearly', 'absolute');
    }).not.toThrow();
  });

  it('recordError does not throw when no span is active', () => {
    expect(() => {
      recordError(new Error('Test'));
    }).not.toThrow();
  });

  it('setAttribute does not throw when no span is active', () => {
    expect(() => {
      setAttribute('key', 'value');
    }).not.toThrow();
  });
});
