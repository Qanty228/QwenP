import { test } from 'node:test';
import assert from 'node:assert';
import { detectQuotaLimitMessage, isQuotaLimitMessage } from '../../utils/quota-detector.js';

const PT = 'Você atingiu o limite de hoje para o Qwen3.8-Max. Faça upgrade da sua membership ou mude para outro modelo acima para continuar.';

test('quota detector: detects the Portuguese daily-limit notice', () => {
  assert.strictEqual(isQuotaLimitMessage(PT), true);
});

test('quota detector: extracts the model name from the notice', () => {
  const match = detectQuotaLimitMessage(PT);
  assert.strictEqual(match.isQuotaLimit, true);
  assert.ok(match.model, 'expected a model name');
  assert.match(match.model!, /qwen/i);
});

test('quota detector: detects the English notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage("You've reached the daily limit for Qwen3.8-Max. Upgrade your membership or switch to another model to continue."),
    true,
  );
});

test('quota detector: detects the Spanish notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Has alcanzado el límite de hoy para Qwen3.8-Max. Actualiza tu membresía o cambia a otro modelo para continuar.'),
    true,
  );
});

test('quota detector: detects the German notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Du hast das Tageslimit für Qwen3.8-Max erreicht. Aktualisiere deine Mitgliedschaft oder wechsle zu einem anderen Modell.'),
    true,
  );
});

test('quota detector: detects the French notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage("Vous avez atteint la limite du jour pour Qwen3.8-Max. Mettez à niveau votre abonnement ou passez à un autre modèle."),
    true,
  );
});

test('quota detector: detects the Italian notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Hai raggiunto il limite di oggi per Qwen3.8-Max. Aggiorna il tuo abbonamento o passa a un altro modello.'),
    true,
  );
});

test('quota detector: detects the Japanese notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Qwen3.8-Max の本日の利用制限に達しました。プランをアップグレードするか、別のモデルに変更してください。'),
    true,
  );
});

test('quota detector: detects the Korean notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Qwen3.8-Max의 오늘의 사용 한도에 도달했습니다. 멤버십을 업그레이드하거나 다른 모델로 전환하세요.'),
    true,
  );
});

test('quota detector: detects the Chinese notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('您已达到 Qwen3.8-Max 今日的使用限额。请升级您的会员或切换到其他模型以继续。'),
    true,
  );
});

test('quota detector: detects the Russian notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Вы достигли сегодняшнего лимита для Qwen3.8-Max. Обновите свою подписку или переключитесь на другую модель.'),
    true,
  );
});

test('quota detector: detects the Dutch notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Je hebt de dagelijkse limiet bereikt voor Qwen3.8-Max. Werk je abonnement bij of schakel over naar een ander model.'),
    true,
  );
});

test('quota detector: detects the Turkish notice', () => {
  assert.strictEqual(
    isQuotaLimitMessage('Qwen3.8-Max için günlük kullanım limitinize ulaştınız. Üyeliğinizi yükseltin veya başka bir modele geçin.'),
    true,
  );
});

test('quota detector: does not flag ordinary answers', () => {
  assert.strictEqual(isQuotaLimitMessage('The limit is 4096 tokens per request.'), false);
  assert.strictEqual(isQuotaLimitMessage('Here is a normal answer about limits in mathematics.'), false);
  assert.strictEqual(isQuotaLimitMessage('Please upgrade your dependencies to the latest version.'), false);
});

test('quota detector: ignores empty content', () => {
  assert.strictEqual(isQuotaLimitMessage(''), false);
  assert.strictEqual(isQuotaLimitMessage(undefined), false);
  assert.strictEqual(isQuotaLimitMessage(null), false);
});

test('quota detector: ignores oversized content', () => {
  // A long answer that merely quotes the notice is not a limit notice.
  const longAnswer = `${PT}\n\n${'lorem ipsum dolor sit amet '.repeat(80)}`;
  assert.strictEqual(isQuotaLimitMessage(longAnswer), false);
});
