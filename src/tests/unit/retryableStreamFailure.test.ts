import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RetryableQwenStreamError,
  QwenUpstreamError,
  isRetryableStreamFailure,
  isExpiredTokenError,
} from '../../services/error-handler.js';

test('isRetryableStreamFailure: browser relay header timeout is retryable', () => {
  // Exact shape thrown by stream-creator.ts when the in-page fetch never
  // receives response headers (the "Opencode Timed out waiting for response
  // headers" client error).
  const err = new Error(
    'Browser stream fetch failed with active Qwen page: Browser stream fetch timed out waiting for response headers after 60000ms'
  );
  assert.equal(isRetryableStreamFailure(err), true);
});

test('isRetryableStreamFailure: plain fetch failures are retryable', () => {
  assert.equal(isRetryableStreamFailure(new Error('fetch failed')), true);
  assert.equal(isRetryableStreamFailure(new Error('socket hang up')), true);
  // "chat is in progress" arrives wrapped as RetryableQwenStreamError by
  // handleErrorBody, which is covered by the dedicated test below.
});

test('isRetryableStreamFailure: RetryableQwenStreamError is always retryable', () => {
  const err = new RetryableQwenStreamError('some transient stream problem', 2000);
  assert.equal(isRetryableStreamFailure(err), true);
});

test('isRetryableStreamFailure: explicit upstream rejections are NOT transport failures', () => {
  const rateLimited = new QwenUpstreamError(
    'Qwen upstream error: RateLimited: too many requests.',
    'RateLimited',
    429
  );
  assert.equal(isRetryableStreamFailure(rateLimited), false);

  const unauthorized = new QwenUpstreamError(
    'Qwen upstream error: unauthorized: Token has expired, please log in again..',
    'unauthorized',
    502
  );
  assert.equal(isRetryableStreamFailure(unauthorized), false);
});

test('isRetryableStreamFailure: null/undefined and unrelated errors are not retryable', () => {
  assert.equal(isRetryableStreamFailure(null), false);
  assert.equal(isRetryableStreamFailure(undefined), false);
  assert.equal(isRetryableStreamFailure(new Error('Daily message limit reached')), false);
});

test('isExpiredTokenError: transport timeouts are never treated as dead tokens', () => {
  // Regression guard: previously any message containing "unauthorized" sent
  // these into the token-renewal replay path ("Retry after token renewal did
  // not succeed: fetch failed"). They must go to retry/failover instead.
  const wrappedTimeout = new Error(
    'Browser stream fetch failed with active Qwen page: upstream unauthorized but no headers arrived'
  );
  assert.equal(isExpiredTokenError(wrappedTimeout), false);
  assert.equal(isRetryableStreamFailure(wrappedTimeout), true);
});

test('isExpiredTokenError: genuine upstream token rejection still renews', () => {
  const authErr = new QwenUpstreamError(
    'Qwen upstream error: unauthorized: Token has expired, please log in again.',
    'unauthorized',
    502
  );
  assert.equal(isExpiredTokenError(authErr), true);

  const msgErr = new Error('unauthorized: Token has expired, please log in again');
  assert.equal(isExpiredTokenError(msgErr), true);
});

test('RetryableQwenStreamError preserves cause', () => {
  const inner = new Error('Browser stream fetch timed out waiting for response headers after 60000ms');
  const outer = new RetryableQwenStreamError(`Browser stream fetch failed with active Qwen page: ${inner.message}`, 2000, { cause: inner });
  assert.equal(outer.cause, inner);
  assert.equal(outer.retryAfterMs, 2000);
});
