import { test } from 'node:test';
import assert from 'node:assert';
import { canFastReleaseGuard } from '../../utils/degenerate-answer.js';

const PT_NOTICE =
  'Você atingiu o limite de hoje para o Qwen3.8-Max. Faça upgrade da sua membership ou mude para outro modelo acima para continuar.';

test('guard release: a daily-limit notice is never fast released', () => {
  // The notice is a long, well-formed sentence, so without the quota check it
  // would pass the "substantive answer" rule and be streamed to the client
  // before the failover could replace it.
  assert.strictEqual(canFastReleaseGuard(PT_NOTICE), false);
  assert.strictEqual(canFastReleaseGuard(PT_NOTICE.slice(0, 90)), false);
});

test('guard release: the English daily-limit notice is never fast released', () => {
  assert.strictEqual(
    canFastReleaseGuard("You've reached the daily limit for Qwen3.8-Max. Upgrade your membership or switch to another model to continue."),
    false,
  );
});

test('guard release: ordinary long answers are still fast released', () => {
  const answer = 'Here is a detailed explanation of how the retry mechanism works in distributed systems.';
  assert.strictEqual(canFastReleaseGuard(answer), true);
});

test('guard release: short degenerate replies are not fast released', () => {
  assert.strictEqual(canFastReleaseGuard('OK'), false);
  assert.strictEqual(canFastReleaseGuard('Sim'), false);
});
