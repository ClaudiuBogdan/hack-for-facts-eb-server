/**
 * The standalone (Chronos) map mount applies the auth middleware scope-wide.
 * The three public map reads must stay anonymous exactly like the legacy
 * global-auth bypass for the same paths: an expired or foreign bearer on a
 * public GET is ignored, not answered with 401; everything else under the
 * scope keeps verification.
 */

import { describe, expect, it } from 'vitest';

import {
  PUBLIC_MAP_READ_RATE_LIMIT,
  isPublicNativeMapRead,
  mapRateLimitKey,
} from '@/app/native-map-routes.js';

describe('isPublicNativeMapRead', () => {
  it.each([
    '/api/v1/advanced-map-datasets/public',
    '/api/v1/advanced-map-datasets/public?limit=5',
    '/api/v1/advanced-map-datasets/public/abc123',
    '/api/v1/advanced-map-analytics/public/abc123',
    '/api/v1/advanced-map-analytics/public/abc123?year=2024',
  ])('treats GET/HEAD %s as a public read', (url) => {
    expect(isPublicNativeMapRead('GET', url)).toBe(true);
    expect(isPublicNativeMapRead('HEAD', url)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never bypasses %s', (method) => {
    expect(isPublicNativeMapRead(method, '/api/v1/advanced-map-datasets/public')).toBe(false);
    expect(isPublicNativeMapRead(method, '/api/v1/advanced-map-analytics/public/x')).toBe(false);
  });

  it.each([
    '/api/v1/advanced-map-datasets',
    '/api/v1/advanced-map-datasets/123',
    '/api/v1/advanced-map-datasets/publicity',
    '/api/v1/advanced-map-analytics/maps',
    '/api/v1/advanced-map-analytics/maps/1/snapshots',
    '/api/v1/advanced-map-analytics/public',
  ])('keeps auth on %s', (url) => {
    expect(isPublicNativeMapRead('GET', url)).toBe(false);
  });
});

describe('mapRateLimitKey', () => {
  it('sends anonymous public reads to their own per-IP bucket', () => {
    expect(mapRateLimitKey('GET', '/api/v1/advanced-map-analytics/public/abc', '10.0.0.1')).toEqual(
      {
        bucket: 'public-read',
        key: 'maps:public:10.0.0.1',
      }
    );
    expect(mapRateLimitKey('HEAD', '/api/v1/advanced-map-datasets/public', '10.0.0.1').bucket).toBe(
      'public-read'
    );
  });

  it('keeps writes and owner reads on the kernel bucket', () => {
    expect(mapRateLimitKey('POST', '/api/v1/advanced-map-analytics/maps', '10.0.0.1')).toEqual({
      bucket: 'default',
      key: 'maps:10.0.0.1',
    });
    expect(mapRateLimitKey('GET', '/api/v1/advanced-map-datasets/123', '10.0.0.1').bucket).toBe(
      'default'
    );
  });

  it('sizes the public bucket for viewers, not writers', () => {
    expect(PUBLIC_MAP_READ_RATE_LIMIT.maxTokens).toBeGreaterThan(30);
    expect(PUBLIC_MAP_READ_RATE_LIMIT.windowMs).toBe(60_000);
  });
});
