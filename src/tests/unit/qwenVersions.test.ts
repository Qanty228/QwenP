import { test } from 'node:test';
import assert from 'node:assert';
import {
  getBxVersion,
  getQwenWebVersion,
  rememberQwenVersions,
} from '../../services/qwen-versions.js';
import {
  QWEN_BX_VERSION_FALLBACK,
  QWEN_WEB_VERSION_FALLBACK,
} from '../../utils/qwen-constants.js';

test('qwen versions: fall back to defaults before anything is detected', () => {
  assert.strictEqual(getQwenWebVersion(), QWEN_WEB_VERSION_FALLBACK);
  assert.strictEqual(getBxVersion(), QWEN_BX_VERSION_FALLBACK);
});

test('qwen versions: detected values replace the defaults', () => {
  rememberQwenVersions({ webVersion: '9.9.9', bxVersion: '8.8.8' });
  assert.strictEqual(getQwenWebVersion(), '9.9.9');
  assert.strictEqual(getBxVersion(), '8.8.8');
});

test('qwen versions: empty detections do not overwrite known values', () => {
  rememberQwenVersions({ webVersion: '9.9.9', bxVersion: '8.8.8' });
  rememberQwenVersions({ webVersion: null, bxVersion: null });
  assert.strictEqual(getQwenWebVersion(), '9.9.9');
  assert.strictEqual(getBxVersion(), '8.8.8');
});

test('qwen versions: partial detection only updates the provided value', () => {
  rememberQwenVersions({ webVersion: '7.7.7' });
  assert.strictEqual(getQwenWebVersion(), '7.7.7');
  assert.strictEqual(getBxVersion(), '8.8.8');
});
