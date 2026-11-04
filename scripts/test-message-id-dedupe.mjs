// messageId 幂等去重模块：直接单元测试（容量淘汰、空 id 透传、重复判定）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMessageIdDedupe } from '../src/social-v2/message-id-dedupe.js';

test('isFirstSeen：首次 true，重复 false；空 id 永远视为新条目', () => {
  const d = createMessageIdDedupe();
  assert.equal(d.isFirstSeen('msg-1'), true);
  assert.equal(d.isFirstSeen('msg-1'), false);
  assert.equal(d.isFirstSeen('msg-2'), true);
  // 拍一拍等合成条目没有 id：内容允许重复，不去重
  assert.equal(d.isFirstSeen(null), true);
  assert.equal(d.isFirstSeen(null), true);
  assert.equal(d.isFirstSeen(''), true);
  assert.equal(d.isFirstSeen(undefined), true);
  // 数字 id 与字符串 id 视为同一消息（OneBot 网关两种形态都发过）
  assert.equal(d.isFirstSeen(12345), true);
  assert.equal(d.isFirstSeen('12345'), false);
});

test('容量有界：超过容量按插入序淘汰最旧', () => {
  const d = createMessageIdDedupe({ capacity: 3 });
  for (const id of ['a', 'b', 'c']) assert.equal(d.isFirstSeen(id), true);
  assert.equal(d.size, 3);
  assert.equal(d.isFirstSeen('d'), true); // 挤掉 'a'
  assert.equal(d.size, 3, '容量不增长');
  assert.equal(d.isFirstSeen('a'), true, "最旧 'a' 已被淘汰，重新算第一次");
  assert.equal(d.isFirstSeen('c'), false, "重新登记 'a' 又挤掉下一个最旧的 'b'，'c' 仍在窗口内");
});

test('capacity 非法/非正值回退默认 500，正常值有下限 1', () => {
  assert.equal(createMessageIdDedupe({ capacity: 0 }).capacity, 500);
  assert.equal(createMessageIdDedupe({ capacity: -5 }).capacity, 500);
  assert.equal(createMessageIdDedupe({ capacity: Number.NaN }).capacity, 500);
  assert.equal(createMessageIdDedupe({}).capacity, 500);
  assert.equal(createMessageIdDedupe({ capacity: 0.4 }).capacity, 1, '极小正值收敛到 1');
  const d = createMessageIdDedupe({ capacity: 0 });
  assert.equal(d.isFirstSeen('x'), true);
  assert.equal(d.isFirstSeen('x'), false);
  assert.equal(d.size, 1);
});

test('bridge.js 已接线：appendSocialV2Message 先查重再入库', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /createMessageIdDedupe\(\{ capacity: 500 \}\)/);
  assert.match(src, /v2MessageIdDedupe\.isFirstSeen\(idText\)/);
  const harness = fs.readFileSync(new URL('./audit-bridge-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /message-id-dedupe\.js/, 'VM 夹具必须注入去重模块');
});
