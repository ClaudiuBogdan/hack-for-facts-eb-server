/**
 * Unit tests for GPT REST API authentication hook.
 */

import { describe, expect, it, vi } from 'vitest';

import { makeGptAuthHook, type GptAuthConfig } from '@/modules/mcp/shell/rest/gpt-auth.js';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock Fastify request with the given headers.
 */
function createMockRequest(headers: Record<string, string | string[] | undefined> = {}): {
  request: FastifyRequest;
  logWarn: ReturnType<typeof vi.fn>;
} {
  const logWarn = vi.fn();
  return {
    request: {
      headers,
      log: {
        warn: logWarn,
      },
    } as unknown as FastifyRequest,
    logWarn,
  };
}

/**
 * Creates a mock Fastify reply that captures the status and send calls.
 */
function createMockReply(): {
  reply: FastifyReply;
  getStatus: () => number | undefined;
  getSentBody: () => unknown;
} {
  let status: number | undefined;
  let sentBody: unknown;

  const reply = {
    status: vi.fn((code: number) => {
      status = code;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      sentBody = body;
      return reply;
    }),
  } as unknown as FastifyReply;

  return {
    reply,
    getStatus: () => status,
    getSentBody: () => sentBody,
  };
}

/**
 * Creates a mock done function.
 */
function createMockDone(): {
  done: HookHandlerDoneFunction;
  wasCalled: () => boolean;
} {
  let called = false;
  return {
    done: (() => {
      called = true;
    }) as unknown as HookHandlerDoneFunction,
    wasCalled: () => called,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGptAuthHook', () => {
  const VALID_API_KEY = 'test-api-key-12345';

  describe('when API key is not configured', () => {
    it('rejects all requests with 401 (fail-closed)', () => {
      const config: GptAuthConfig = { apiKey: undefined };
      const hook = makeGptAuthHook(config);

      const { request, logWarn } = createMockRequest({ 'x-api-key': VALID_API_KEY });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'API key not configured',
      });
      expect(wasCalled()).toBe(false);
      expect(logWarn).toHaveBeenCalled();
    });

    it('rejects when API key is empty string (fail-closed)', () => {
      const config: GptAuthConfig = { apiKey: '' };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': VALID_API_KEY });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'API key not configured',
      });
      expect(wasCalled()).toBe(false);
    });
  });

  describe('when X-API-Key header is missing', () => {
    it('rejects with 401 and helpful message', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({}); // No headers
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-API-Key header required',
      });
      expect(wasCalled()).toBe(false);
    });

    it('rejects when header is array (multiple values)', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': ['key1', 'key2'] });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'X-API-Key header required',
      });
      expect(wasCalled()).toBe(false);
    });
  });

  describe('when API key is invalid', () => {
    it('rejects with 401 for wrong key', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': 'wrong-key' });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      expect(wasCalled()).toBe(false);
    });

    it('rejects for similar but different key (timing-safe)', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      // Similar key with one character different
      const { request } = createMockRequest({ 'x-api-key': 'test-api-key-12346' });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      expect(wasCalled()).toBe(false);
    });

    it('rejects for key with different length', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': 'short' });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      expect(wasCalled()).toBe(false);
    });

    it('rejects empty provided key', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': '' });
      const { reply, getStatus, getSentBody } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(getStatus()).toBe(401);
      expect(getSentBody()).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid API key',
      });
      expect(wasCalled()).toBe(false);
    });
  });

  describe('when API key is valid', () => {
    it('calls done() to proceed with the request', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': VALID_API_KEY });
      const { reply, getStatus } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(wasCalled()).toBe(true);
      expect(getStatus()).toBeUndefined(); // No status set = no error response
    });

    it('authenticates with exact key match', () => {
      const longKey = 'a'.repeat(64); // 64 character key
      const config: GptAuthConfig = { apiKey: longKey };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': longKey });
      const { reply, getStatus } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(wasCalled()).toBe(true);
      expect(getStatus()).toBeUndefined();
    });

    it('handles keys with special characters', () => {
      const specialKey = 'key-with-$pecial_chars!@#%^&*()';
      const config: GptAuthConfig = { apiKey: specialKey };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': specialKey });
      const { reply, getStatus } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(wasCalled()).toBe(true);
      expect(getStatus()).toBeUndefined();
    });

    it('handles Unicode keys', () => {
      const unicodeKey = 'key-with-unicode-\u{1F511}\u{1F512}';
      const config: GptAuthConfig = { apiKey: unicodeKey };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': unicodeKey });
      const { reply, getStatus } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(wasCalled()).toBe(true);
      expect(getStatus()).toBeUndefined();
    });
  });

  describe('header case sensitivity', () => {
    it('works with lowercase x-api-key header', () => {
      const config: GptAuthConfig = { apiKey: VALID_API_KEY };
      const hook = makeGptAuthHook(config);

      const { request } = createMockRequest({ 'x-api-key': VALID_API_KEY });
      const { reply, getStatus } = createMockReply();
      const { done, wasCalled } = createMockDone();

      hook(request, reply, done);

      expect(wasCalled()).toBe(true);
      expect(getStatus()).toBeUndefined();
    });
  });
});
