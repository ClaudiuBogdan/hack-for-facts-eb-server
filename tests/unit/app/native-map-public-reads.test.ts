/**
 * The standalone (Chronos) map mount applies the auth middleware scope-wide.
 * The three public map reads must stay anonymous exactly like the legacy
 * global-auth bypass for the same paths: an expired or foreign bearer on a
 * public GET is ignored, not answered with 401; everything else under the
 * scope keeps verification.
 */

import { describe, expect, it } from 'vitest';

import { isPublicNativeMapRead } from '@/app/native-map-routes.js';

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
