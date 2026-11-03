// memory-routes 的直接路由回归：内存会话状态 + stub 记忆函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryRoutes } from '../src/http/memory-routes.js';

const ident = (v) => String(v ?? '');

function harness() {
  const states = new Map();
  const sent = [];
  let body = {};
  const deps = {
    cfg: { socialV2: { tools: {} } },
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getSocialV2State: (key) => {
      if (!states.has(key)) {
        states.set(key, { activeTopics: [], pendingThoughts: [], memberImpressions: {}, toString: 'safe' });
        delete states.get(key).toString;
      }
      return states.get(key);
    },
    saveSocialV2State: () => {},
    formatMemoryV2: () => '（记忆摘要）',
    appendMemoryV2: (st, category, content, extra) => {
      if (category === 'activeTopic') st.activeTopics.push({ text: content, ...extra });
      else if (category === 'pendingThought') st.pendingThoughts.push({ text: content, ...extra });
      else if (category === 'memberImpression') {
        st.memberImpressions[extra.target] = { traits: content.split(/[,，、]/), interactionCount: 1, lastSeenAt: Date.now() };
      }
    },
    redactKnownTokensOnly: ident
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 't' }) => {
    body = bodyValue;
    const handled = await handleMemoryRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, states, deps };
}

test('append：activeTopic / memberImpression 正常写入；非法 category 400', async () => {
  const h = harness();
  const ok = await h.call('POST', '/api/socialV2/memory-append', { key: 'group:456', category: 'activeTopic', content: '在聊塞尔达' });
  assert.equal(ok.last.obj.ok, true);
  const imp = await h.call('POST', '/api/socialV2/memory-append', { key: 'group:456', category: 'memberImpression', content: '热情', extra: { target: '小明' } });
  assert.equal(imp.last.obj.ok, true);
  const bad = await h.call('POST', '/api/socialV2/memory-append', { key: 'group:456', category: 'zzz', content: 'x' });
  assert.equal(bad.last.status, 400);
  const noTarget = await h.call('POST', '/api/socialV2/memory-append', { key: 'group:456', category: 'memberImpression', content: 'x' });
  assert.equal(noTarget.last.status, 400);
  const st = h.states.get('group:456');
  assert.equal(st.activeTopics[0].text, '在聊塞尔达');
  assert.ok(st.memberImpressions['小明']);
});

test('memory GET：按 category 过滤，pendingThought 过期条目被隐藏', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.pendingThoughts = [{ text: '过期想法', expiresAt: Date.now() - 1 }, { text: '还想着', expiresAt: Date.now() + 60000 }];
  const all = await h.call('GET', '/api/socialV2/memory?key=group:456');
  assert.deepEqual(all.last.obj.raw.pendingThoughts.map((t) => t.text), ['还想着']);
  const filtered = await h.call('GET', '/api/socialV2/memory?key=group:456&category=activeTopic');
  assert.deepEqual(filtered.last.obj.raw.pendingThoughts, []);
});

test('update：memberImpression 必须命中已有条目；改名 + 淘汰上限', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.memberImpressions = { '小明': { traits: ['热情'], interactionCount: 1, lastSeenAt: 1 } };
  const missing = await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'memberImpression', target: '小红', newContent: 'x' });
  assert.equal(missing.last.status, 404);
  const proto = await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'memberImpression', target: '__proto__', newContent: 'x' });
  assert.equal(proto.last.status, 400);
  const rename = await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'memberImpression', target: '小明', newContent: '热情,靠谱', newExtra: { target: '大明' } });
  assert.equal(rename.last.obj.ok, true);
  assert.equal(st.memberImpressions['小明'], undefined);
  assert.deepEqual(st.memberImpressions['大明'].traits, ['热情', '靠谱']);
  // 淘汰上限：51 个条目 → 按 lastSeenAt 淘到 50
  for (let i = 0; i < 51; i++) st.memberImpressions[`u${i}`] = { traits: [], lastSeenAt: i };
  await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'memberImpression', target: '大明', newExtra: { target: '大明' } });
  assert.equal(Object.keys(st.memberImpressions).length, 50, '超出 50 条按 lastSeenAt 淘汰最旧');
});

test('update：activeTopic 找不到 404；pendingThought 改过期时间', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.pendingThoughts = [{ text: '想问x', motivation: '', expiresAt: 0 }];
  const missing = await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'activeTopic', oldContent: '不存在' });
  assert.equal(missing.last.status, 404);
  const ok = await h.call('POST', '/api/socialV2/memory-update', { key: 'group:456', category: 'pendingThought', oldContent: '想问x', newContent: '想问y', newExtra: { expiresAtMs: 5000 } });
  assert.equal(ok.last.obj.ok, true);
  assert.equal(st.pendingThoughts[0].text, '想问y');
  assert.ok(st.pendingThoughts[0].expiresAt > Date.now());
});

test('remove / clear：按内容删、原型名拒、clear 全清', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.activeTopics = [{ text: '话题A' }, { text: '话题B' }];
  const proto = await h.call('POST', '/api/socialV2/memory-remove', { key: 'group:456', category: 'memberImpression', target: 'constructor' });
  assert.equal(proto.last.status, 400);
  const removed = await h.call('POST', '/api/socialV2/memory-remove', { key: 'group:456', category: 'activeTopic', content: '话题A' });
  assert.equal(removed.last.obj.ok, true);
  assert.deepEqual(st.activeTopics.map((t) => t.text), ['话题B']);
  const cleared = await h.call('POST', '/api/socialV2/memory-clear', { key: 'group:456' });
  assert.equal(cleared.last.obj.category, 'all');
  assert.deepEqual(st.activeTopics, []);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/unread?key=group:456')).handled, false);
});
