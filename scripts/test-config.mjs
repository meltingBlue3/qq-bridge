// config.js 的纯配置回归：临时目录夹具，不读真实 config.json、不碰 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRoleInjectLimit,
  loadConfig,
  normalizeIdList,
  normalizeOwnerQQ,
  normalizeReasoningEffort,
  REASONING_EFFORT_DEFAULT
} from '../src/config.js';

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overrides, null, 2), 'utf8');
  return dir;
}

function load(overrides) {
  const root = fixture(overrides);
  try {
    return loadConfig({ root, log: () => {}, discoverDshLaunchToken: () => '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('空配置得到完整默认值', () => {
  const { cfg } = load({});
  assert.equal(cfg.dsh.baseUrl, 'http://127.0.0.1:3080');
  assert.equal(cfg.dsh.reasoningEffort, REASONING_EFFORT_DEFAULT);
  assert.equal(cfg.consolePort, 3100);
  assert.equal(cfg.socialV2.enabled, true);
  assert.equal(cfg.socialV2.tools.sendVoice, false);
  assert.equal(cfg.socialV2.voice.enabled, false);
  assert.equal(cfg.socialV2.sticker.collect.maxPerHour, 10);
  assert.equal(cfg.socialV2.media.maxBytes, 8 * 1024 * 1024);
});

test('socialV2 工具/表情/媒体做深度合并，不让旧配置丢新增默认值', () => {
  const { cfg } = load({
    socialV2: {
      tools: { sendVoice: true },
      sticker: { collect: { maxPerMinute: 9 } },
      media: { maxCount: 2 }
    }
  });
  assert.equal(cfg.socialV2.tools.sendVoice, true);
  assert.equal(cfg.socialV2.tools.getPrompt, true, '未写的工具开关必须保留默认');
  assert.equal(cfg.socialV2.sticker.collect.maxPerMinute, 9);
  assert.equal(cfg.socialV2.sticker.collect.maxPerHour, 10, '未写的 collect 字段必须保留');
  assert.equal(cfg.socialV2.media.maxCount, 2);
  assert.equal(cfg.socialV2.media.maxPixels, 64_000_000);
});

test('人格注入上限与初始提示词上限按范围收敛', () => {
  assert.equal(applyRoleInjectLimit('500'), 1000);
  assert.equal(applyRoleInjectLimit(999999), 20000);
  assert.equal(applyRoleInjectLimit('abc'), 8000);
  const { cfg, roleInjectMaxChars } = load({ role: { maxInjectChars: 500 } });
  assert.equal(cfg.role.maxInjectChars, 500, '原配置保留供控制台显示');
  assert.equal(roleInjectMaxChars, 1000, '实际注入使用收敛值');
});

test('非法思考强度回退默认值而不是让会话循环报错', () => {
  const { cfg } = load({ dsh: { reasoningEffort: 'ultra' } });
  assert.equal(cfg.dsh.reasoningEffort, REASONING_EFFORT_DEFAULT);
  assert.throws(() => normalizeReasoningEffort('ultra'));
});

test('ownerQQ / 白名单规范化保持 fail-closed', () => {
  assert.equal(normalizeOwnerQQ(''), null);
  assert.equal(normalizeOwnerQQ('12345'), 12345);
  assert.throws(() => normalizeOwnerQQ('abc'));
  assert.deepEqual(normalizeIdList(['1', 2, 'x', null]), ['1', '2']);
  assert.deepEqual(normalizeIdList('not-array'), []);
});
