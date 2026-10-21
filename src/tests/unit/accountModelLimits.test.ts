import { test } from 'node:test';
import assert from 'node:assert';
import {
  clearAccountModelLimit,
  clearAllAccountModelLimits,
  getModelLimit,
  getModelLimitRemainingMs,
  isAccountModelLimited,
  listModelLimits,
  markAccountModelLimited,
  normalizeModelId,
} from '../../core/account-model-limits.js';

const ACCOUNT = 'acct-quota-test';

function reset() {
  clearAllAccountModelLimits(ACCOUNT);
}

test('model limits: normalizes model ids for comparison', () => {
  assert.strictEqual(normalizeModelId('Qwen3.8-Max'), 'qwen3.8-max');
  assert.strictEqual(normalizeModelId('  qwen3.7-plus  '), 'qwen3.7-plus');
});

test('model limits: a fresh account has no limits', () => {
  reset();
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), false);
  assert.strictEqual(getModelLimit(ACCOUNT, 'qwen3.8-max'), null);
  assert.strictEqual(getModelLimitRemainingMs(ACCOUNT, 'qwen3.8-max'), 0);
});

test('model limits: marking a model blocks only that model', () => {
  reset();
  const until = Date.now() + 60_000;
  markAccountModelLimited(ACCOUNT, 'qwen3.8-max', until, 'MembershipLimit');

  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), true);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.7-plus'), false);
  assert.ok(getModelLimitRemainingMs(ACCOUNT, 'qwen3.8-max') > 0);
});

test('model limits: matching ignores the model id casing', () => {
  reset();
  markAccountModelLimited(ACCOUNT, 'Qwen3.8-Max', Date.now() + 60_000);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), true);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'QWEN3.8-MAX'), true);
});

test('model limits: an expired limit is not enforced', () => {
  reset();
  markAccountModelLimited(ACCOUNT, 'qwen3.8-max', Date.now() - 1_000);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), false);
  assert.strictEqual(getModelLimit(ACCOUNT, 'qwen3.8-max'), null);
});

test('model limits: clearing one model keeps the others', () => {
  reset();
  markAccountModelLimited(ACCOUNT, 'qwen3.8-max', Date.now() + 60_000);
  markAccountModelLimited(ACCOUNT, 'qwen3.7-plus', Date.now() + 60_000);

  clearAccountModelLimit(ACCOUNT, 'qwen3.8-max');
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), false);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.7-plus'), true);
});

test('model limits: clearing all limits for an account', () => {
  reset();
  markAccountModelLimited(ACCOUNT, 'qwen3.8-max', Date.now() + 60_000);
  markAccountModelLimited(ACCOUNT, 'qwen3.7-plus', Date.now() + 60_000);

  clearAllAccountModelLimits(ACCOUNT);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), false);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.7-plus'), false);
  assert.strictEqual(listModelLimits().filter(l => l.accountId === ACCOUNT).length, 0);
});

test('model limits: an empty model id is ignored', () => {
  reset();
  markAccountModelLimited(ACCOUNT, '', Date.now() + 60_000);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, ''), false);
});

test('model limits: a limit expires and is released automatically', () => {
  reset();
  markAccountModelLimited(ACCOUNT, 'qwen3.8-max', Date.now() - 1);
  assert.strictEqual(isAccountModelLimited(ACCOUNT, 'qwen3.8-max'), false);
  assert.strictEqual(listModelLimits().filter(l => l.accountId === ACCOUNT).length, 0);
});
