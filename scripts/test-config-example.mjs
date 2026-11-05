import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDefaultConfig } from '../src/config-defaults.js';

test('示例配置逐字匹配唯一默认值，不在测试期间改写生成物', () => {
  assert.equal(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n'),
    `${JSON.stringify(createDefaultConfig(), null, 2)}\n`, '请运行 node scripts/build-config-example.mjs');
});

test('默认配置副本相互隔离', () => {
  const first = createDefaultConfig();
  first.socialV2.wake.recommendedKeywords.push('changed');
  first.allow.groups.push('123');
  first.webSearch.apiKey = 'fixture';
  const second = createDefaultConfig();
  assert.ok(!second.socialV2.wake.recommendedKeywords.includes('changed'));
  assert.deepEqual(second.allow.groups, []);
  assert.equal(second.webSearch.apiKey, '');
});
