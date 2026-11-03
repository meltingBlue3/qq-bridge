// state-store 的直接单测：真实临时文件 + 真实 wake-policy 纯函数。
// 钉住部署语义：key 规范化、默认字段、脏数据清洗、多实例写覆盖保护、save 切片上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialV2StateStore } from '../src/social-v2/state-store.js';
import {
  defaultWakeConfigV2,
  pickWakeTriggersV2,
  normalizeSpeakerIdsV2,
  refreshDefaultWakeConfigV2
} from '../src/social-v2/wake-policy.js';

function setup({ fileContent = null, canonicalKey = (k) => (/^(group|private):\d+$/.test(String(k ?? '').trim()) ? String(k).trim() : null) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-state-store-'));
  const file = path.join(dir, 'social-v2.json');
  if (fileContent !== null) fs.writeFileSync(file, JSON.stringify(fileContent), 'utf8');
  const socialV2 = { paused: false, conversations: new Map() };
  const seenForwardIds = new Map();
  const calls = { tokens: [], proactive: [], sleep: [], logs: [] };
  const hooks = {};
  const store = createSocialV2StateStore({
    socialV2,
    file,
    log: (...a) => calls.logs.push(a.join(' ')),
    canonicalKey,
    defaultWakeConfig: () => defaultWakeConfigV2(),
    pickWakeTriggers: pickWakeTriggersV2,
    normalizeSpeakerIds: normalizeSpeakerIdsV2,
    refreshDefaultWakeConfig: refreshDefaultWakeConfigV2,
    ensureWakeable: (st, opts) => { hooks.ensureWakeable?.(st, opts); },
    rememberAgentToken: (key, token) => { calls.tokens.push([key, token]); },
    scheduleProactiveCheck: (key) => { calls.proactive.push(key); },
    setupSleepTimer: (key) => { calls.sleep.push(key); },
    sanitizeForwardId: (fid) => (typeof fid === 'string' && fid ? fid : null),
    seenForwardIds
  });
  return { store, socialV2, seenForwardIds, file, dir, calls, hooks };
}

test('get：非法 key 抛 400；新会话补全默认字段并登记 token/排调度；同 key 复用同一对象', () => {
  const h = setup();
  assert.throws(() => h.store.get('oops'), (e) => e.statusCode === 400);
  const st = h.store.get('group:456');
  assert.equal(st.lastAiReplyAt, 0);
  assert.ok(typeof st.agentToken === 'string' && st.agentToken.length === 32);
  assert.ok(Array.isArray(st.recentMessages) && st.wakeConfig.triggers);
  assert.deepEqual(h.calls.proactive, ['group:456']);
  assert.deepEqual(h.calls.sleep, ['group:456']);
  assert.deepEqual(h.calls.tokens, [['group:456', st.agentToken]]);
  assert.equal(h.store.get('group:456'), st, '同 key 返回同一状态对象');
  assert.deepEqual([...h.socialV2.conversations.keys()], ['group:456']);
});

test('load：解析会话、过滤 wake triggers、私聊清空 speakerIds、清洗原型键、重建 seenForwardIds、token 去重', () => {
  const fileContent = {
    paused: true,
    conversations: {
      'group:456': {
        agentToken: 'tok-a',
        wakeConfig: { confirmedBy: 'admin', infinite: false, triggers: { atMention: true, hackerKey: 'x', speakerIds: ['123', null, '456'] } },
        recentMessages: [{ seq: 1, forwardIds: ['fw-1', '', 'fw-1'] }],
        unread: [],
        lastReadThroughSeq: 99,
        lastUnreadSeq: 50,
        memberImpressions: { '小明': { traits: [] }, __proto__: { evil: true }, constructor: {} },
        seenForwardIds: ['fw-persist', null]
      },
      'private:789': {
        agentToken: 'tok-b',
        wakeConfig: { triggers: { speakerIds: ['999'] } }
      },
      'private:000': {
        agentToken: 'tok-b',
        wakeConfig: {}
      },
      'bad-key': { agentToken: 'tok-c' }
    }
  };
  const h = setup({ fileContent });
  h.store.load();
  assert.equal(h.socialV2.paused, true);
  assert.equal(h.socialV2.conversations.size, 3, 'bad-key 被拒');
  const g = h.socialV2.conversations.get('group:456');
  assert.equal(g.wakeConfig.infinite, false, '显式确认过的配置（confirmedBy=admin）不被默认刷新覆盖');
  assert.deepEqual(Object.keys(g.wakeConfig.triggers).sort(), Object.keys(defaultWakeConfigV2().triggers).sort(), 'triggers 按已知字段过滤');
  assert.deepEqual(g.wakeConfig.triggers.speakerIds, ['123', '456'], 'speakerIds 归一化');
  assert.equal(g.lastReadThroughSeq, 50, 'lastReadThroughSeq 不得超过 lastUnreadSeq');
  assert.deepEqual(Object.keys(g.memberImpressions), ['小明'], '原型键被清洗');
  assert.deepEqual([...(h.seenForwardIds.get('group:456') || [])], ['fw-persist', 'fw-1'], '重建顺序：先持久化字段，后消息字段（Set 去重）');
  const p1 = h.socialV2.conversations.get('private:789');
  assert.deepEqual(p1.wakeConfig.triggers.speakerIds, [], '私聊 speakerIds 强制清空');
  // tok-b 重复 → 第二个实例被换新
  const p2 = h.socialV2.conversations.get('private:000');
  assert.notEqual(p2.agentToken, 'tok-b');
  assert.ok(h.calls.tokens.some(([k, t]) => k === 'private:000' && t === p2.agentToken));
});

test('load：加载期间文件被其它进程改写 → 跳过回写（多实例保护）', () => {
  const h = setup({ fileContent: { paused: false, conversations: { 'group:1': { agentToken: 't1' } } } });
  // ensureWakeable 钩子里模拟「别的进程」改写文件（内容变化 → 指纹失配）
  h.hooks.ensureWakeable = () => {
    fs.writeFileSync(h.file, JSON.stringify({ paused: true, conversations: { 'group:2': { agentToken: 't2' } } }), 'utf8');
  };
  h.store.load();
  const onDisk = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(onDisk.paused, true, '加载末尾的统一回写被跳过');
  assert.ok(h.socialV2.conversations.has('group:1'), '内存态照常装载');
});

test('load：文件未被改写 → 加载末尾统一落盘一次', () => {
  const h = setup({ fileContent: { paused: false, conversations: { 'group:1': { agentToken: 't1', recentMessages: [{ seq: 3 }] } } } });
  h.store.load();
  const onDisk = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  assert.equal(onDisk.conversations['group:1'].agentToken, 't1');
  assert.ok(onDisk.conversations['group:1'].wakeConfig, '回写后补全了默认字段');
  assert.ok(h.calls.proactive.includes('group:1'), '加载后为每个会话排主动检查定时器（sleep 定时器只在 get 新建会话时排）');
});

test('save：切片上限（recent 200 / unread 100 / sendTimes 500 / seenForwardIds 1000）与原型无关对象', () => {
  const h = setup();
  const st = h.store.get('group:1');
  st.recentMessages = Array.from({ length: 260 }, (_, i) => ({ seq: i }));
  st.unread = Array.from({ length: 130 }, (_, i) => ({ seq: i }));
  st.sendTimes = Array.from({ length: 600 }, (_, i) => i);
  h.seenForwardIds.set('group:1', new Set(Array.from({ length: 1100 }, (_, i) => `f${i}`)));
  h.store.save();
  const onDisk = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  const saved = onDisk.conversations['group:1'];
  assert.equal(onDisk.paused, false);
  assert.equal(saved.recentMessages.length, 200);
  assert.equal(saved.recentMessages[0].seq, 60, '保留最新的 200 条');
  assert.equal(saved.unread.length, 100);
  assert.equal(saved.sendTimes.length, 500);
  assert.equal(saved.seenForwardIds.length, 1000);
  // 坏状态的 memberImpressions 不炸 save：非对象一律落盘为 {}
  st.memberImpressions = 'not-an-object';
  h.store.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')).conversations['group:1'].memberImpressions, {});
});
