import { describe, expect, it, vi } from 'vitest';

import {
  LEARNING_PROGRESS_REVIEW_API_KEY_HEADER,
  makeLearningProgressAdminReviewAuthHook,
  type LearningProgressAdminReviewAuthConfig,
} from '@/modules/learning-progress/index.js';

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

function createMockRequest(headers: Record<string, string | string[] | undefined> = {}) {
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

function createMockReply() {
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

function createMockDone() {
  let called = false;
  return {
    done: (() => {
      called = true;
    }) as unknown as HookHandlerDoneFunction,
    wasCalled: () => called,
  };
}

describe('makeLearningProgressAdminReviewAuthHook', () => {
  const VALID_API_KEY = 'review-api-key-12345678901234567890';

  it('fails closed when the API key is not configured', () => {
    const config: LearningProgressAdminReviewAuthConfig = { apiKey: undefined };
    const hook = makeLearningProgressAdminReviewAuthHook(config);
    const { request, logWarn } = createMockRequest({
      [LEARNING_PROGRESS_REVIEW_API_KEY_HEADER]: VALID_API_KEY,
    });
    const { reply, getStatus, getSentBody } = createMockReply();
    const { done, wasCalled } = createMockDone();

    hook(request, reply, done);

    expect(getStatus()).toBe(401);
    expect(getSentBody()).toEqual({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'Learning progress review API key not configured',
      retryable: false,
    });
    expect(wasCalled()).toBe(false);
    expect(logWarn).toHaveBeenCalled();
  });

  it('rejects missing review API key headers', () => {
    const config: LearningProgressAdminReviewAuthConfig = { apiKey: VALID_API_KEY };
    const hook = makeLearningProgressAdminReviewAuthHook(config);
    const { request } = createMockRequest();
    const { reply, getStatus, getSentBody } = createMockReply();
    const { done, wasCalled } = createMockDone();

    hook(request, reply, done);

    expect(getStatus()).toBe(401);
    expect(getSentBody()).toEqual({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'X-Learning-Progress-Review-Api-Key header required',
      retryable: false,
    });
    expect(wasCalled()).toBe(false);
  });

  it('rejects invalid review API keys', () => {
    const config: LearningProgressAdminReviewAuthConfig = { apiKey: VALID_API_KEY };
    const hook = makeLearningProgressAdminReviewAuthHook(config);
    const { request } = createMockRequest({
      [LEARNING_PROGRESS_REVIEW_API_KEY_HEADER]: 'wrong-key',
    });
    const { reply, getStatus, getSentBody } = createMockReply();
    const { done, wasCalled } = createMockDone();

    hook(request, reply, done);

    expect(getStatus()).toBe(401);
    expect(getSentBody()).toEqual({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'Invalid API key',
      retryable: false,
    });
    expect(wasCalled()).toBe(false);
  });

  it('allows requests with a valid review API key', () => {
    const config: LearningProgressAdminReviewAuthConfig = { apiKey: VALID_API_KEY };
    const hook = makeLearningProgressAdminReviewAuthHook(config);
    const { request } = createMockRequest({
      [LEARNING_PROGRESS_REVIEW_API_KEY_HEADER]: VALID_API_KEY,
    });
    const { reply, getStatus } = createMockReply();
    const { done, wasCalled } = createMockDone();

    hook(request, reply, done);

    expect(wasCalled()).toBe(true);
    expect(getStatus()).toBeUndefined();
  });
});
