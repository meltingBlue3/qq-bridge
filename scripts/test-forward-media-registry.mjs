// forward-media 会话登记：模块直测 + bridge/路由接线断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createForwardMediaRegistry } from '../src/social-v2/forward-media-registry.js';

const NOW = 1_700_000_000_000;
const SEEN = { url: 'https://multimedia.nt.qq.com.cn/a.jpg' };
const SEEN2 = { file: 'cache/abc.jpg', url: 'https://gchat.qpic.cn/b.jpg' };

test('filter：登记过（未过期）放行；没见过的拒绝', () => {
  const r = createForwardMediaRegistry();
  r.remember('group:456', [SEEN], NOW);
  const { allowed, denied } = r.filter('group:456', [SEEN, { url: 'https://evil.example.com/x.jpg' }], [], NOW);
  assert.deepEqual(allowed, [SEEN]);
  assert.deepEqual(denied, [{ url: 'https://evil.example.com/x.jpg' }]);
});

test('filter：本会话已入库消息的 media 也算见过（messageLists=[recent, unread]）', () => {
  const r = createForwardMediaRegistry();
  const stored = [[{ media: [SEEN2] }], []]; // 与 bridge 传参一致：消息数组的列表
  const { allowed, denied } = r.filter('group:456', [SEEN2], stored, NOW);
  assert.deepEqual(allowed, [SEEN2]);
  assert.deepEqual(denied, []);
});

test('keyOf：url > file > emojiId > faceId；无身份键视为未见过', () => {
  const r = createForwardMediaRegistry();
  assert.equal(r.keyOf({ url: 'u', file: 'f', emojiId: 'e', faceId: '1' }), 'u');
  assert.equal(r.keyOf({ file: 'f', emojiId: 'e' }), 'f');
  assert.equal(r.keyOf({ emojiId: 'e', faceId: '1' }), 'e');
  assert.equal(r.keyOf({ faceId: '1' }), '1');
  assert.equal(r.keyOf({}), '');
  assert.equal(r.keyOf(null), '');
  // 无身份键的条目：登记忽略、过滤拒绝
  r.remember('group:456', [{ summary: '没有 url 的对象' }], NOW);
  const { allowed } = r.filter('group:456', [{ summary: '没有 url 的对象' }], [], NOW);
  assert.deepEqual(allowed, []);
});

test('TTL：超过 10 分钟的登记视为未见过；容量按插入序淘汰', () => {
  const r = createForwardMediaRegistry({ ttlMs: 600000 });
  r.remember('group:456', [SEEN], NOW);
  assert.equal(r.filter('group:456', [SEEN], [], NOW + 600001).allowed.length, 0, '过期即拒绝');
  assert.equal(r.filter('group:456', [SEEN], [], NOW + 600000).allowed.length, 1, '恰好到期边界仍放行');

  const cap = createForwardMediaRegistry({ capacity: 2 });
  cap.remember('g', [{ url: 'a' }, { url: 'b' }, { url: 'c' }], NOW);
  const out = cap.filter('g', [{ url: 'a' }, { url: 'b' }, { url: 'c' }], [], NOW);
  assert.deepEqual(out.allowed.map((m) => m.url), ['b', 'c'], "最旧的 'a' 被挤出");
});

test('forget：会话退役后登记清空（key 复用不得读到旧登记）', () => {
  const r = createForwardMediaRegistry();
  r.remember('group:456', [SEEN], NOW);
  r.forget('group:456');
  assert.equal(r.filter('group:456', [SEEN], [], NOW).allowed.length, 0);
  assert.equal(r.size, 0);
});

test('bridge.js / 路由已接线：登记在转发读取后发生、过滤在抓取前生效', () => {
  const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridgeSrc, /const forwardMediaRegistry = createForwardMediaRegistry\(\);/);
  assert.match(bridgeSrc, /rememberForwardMediaV2,\r?\n\s*filterForwardMediaV2/, 'readRouteDeps 必须注入两个回调');
  assert.match(bridgeSrc, /forwardMediaRegistry\.filter\(key, mediaList, \[st\?\.recentMessages, st\?\.unread\]\)/, '过滤必须带上本会话已入库消息');
  const routeSrc = fs.readFileSync(new URL('../src/http/socialv2-read-routes.js', import.meta.url), 'utf8');
  assert.match(routeSrc, /rememberForwardMediaV2\?\.\(key, m\.media\)/, '转发读取成功后登记媒体');
  assert.match(routeSrc, /不在本会话已见范围内（只能读取本会话收到的转发\/消息媒体）/);
  const harness = fs.readFileSync(new URL('./audit-bridge-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /forward-media-registry\.js/, 'VM 夹具必须注入登记器模块');
});
