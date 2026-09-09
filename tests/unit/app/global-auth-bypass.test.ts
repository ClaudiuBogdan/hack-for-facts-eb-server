import { describe, expect, it } from 'vitest';

import { shouldBypassGlobalAuthValidation } from '@/app/build-app.js';

/**
 * Pins the global-auth bypass matrix for the redesign surface
 * (build-app.ts): exact-path set, public GET/HEAD data prefixes, and the
 * deliberate exclusions. The redesign REST prefixes serve public read-only
 * data (the standalone redesign server has no auth at all), so when the
 * surface is mounted inside the legacy app their GET/HEAD traffic must not
 * be blocked by the legacy auth preHandler — while everything else keeps
 * exactly the pre-flag behavior.
 */
describe('shouldBypassGlobalAuthValidation — redesign public GET prefixes', () => {
  const req = (method: string, url: string) => ({ method, url });

  it.each([
    '/api/v1/legal/documents/171282/render',
    '/api/v1/legal/documents/171282/render/chunks/2',
    '/api/v1/parliament/some/route',
    '/api/v1/pnrr/some/route',
  ])('bypasses auth for GET %s when the surface is mounted', (url) => {
    expect(shouldBypassGlobalAuthValidation(req('GET', url))).toBe(true);
    expect(shouldBypassGlobalAuthValidation(req('HEAD', url))).toBe(true);
  });

  it('bypasses GET/HEAD only — writes under the prefixes stay authenticated', () => {
    expect(shouldBypassGlobalAuthValidation(req('POST', '/api/v1/legal/documents/1/render'))).toBe(
      false
    );
    expect(shouldBypassGlobalAuthValidation(req('DELETE', '/api/v1/pnrr/x'))).toBe(false);
  });

  it('does not bypass the agent surface (the one authenticated redesign REST prefix)', () => {
    expect(shouldBypassGlobalAuthValidation(req('GET', '/api/v1/agent/chats'))).toBe(false);
    expect(shouldBypassGlobalAuthValidation(req('POST', '/api/v1/agent/chat'))).toBe(false);
  });

  it('does not bypass prefix-lookalike paths', () => {
    expect(shouldBypassGlobalAuthValidation(req('GET', '/api/v1/legalx/leak'))).toBe(false);
  });

  it('ignores query strings when matching', () => {
    expect(
      shouldBypassGlobalAuthValidation(req('GET', '/api/v1/legal/documents/1/render?x=1'))
    ).toBe(true);
  });

  it('keeps the exact-path redesign set working as before', () => {
    expect(shouldBypassGlobalAuthValidation(req('POST', '/api/v1/graphql'))).toBe(true);
  });

  it.each(['/api/v1/live', '/api/v1/health', '/api/v1/ready'])(
    'bypasses auth for the probe route %s only when the surface is mounted',
    (url) => {
      // kubelet probes send no Authorization header; a 401 would restart or
      // de-register a healthy pod.
      expect(shouldBypassGlobalAuthValidation(req('GET', url))).toBe(true);
    }
  );
});
