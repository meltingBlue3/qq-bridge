// socialv2-admin-routes 的直接路由回归：临时 config.json + 内存状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSocialV2AdminRoutes } from '../src/http/socialv2-admin-routes.js';
import { createInitialPromptStore } from '../src/initial-prompts.js';

const canonicalV2Key = (key) => {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  return m ? `${m[1]}:${Number(m[2])}` : null;
};

function fixture(cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-v2-admin-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg), 'utf8');
  const promptsFile = path.join(root, 'state', 'initial-prompts.json');
  const stateDir = path.dirname(promptsFile);
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, promptsFile, socialV2File: path.join(root, 'state', 'social-v2.json') };
}

function harness({ root, promptsFile, socialV2File }, cfgOverride = {}) {
  const cfg = JSON.parse(JSON.stringify({
    socialV2: { enabled: true, tools: { sendVoice: false, setStickerRemark: false }, wake: {}, send: {}, wait: {}, sticker: {} },
    ...cfgOverride
  }));
  const socialV2 = { paused: false, conversations: new Map() };
  const map = () => new Map();
  const initialPromptStore = createInitialPromptStore({
    file: promptsFile, maxChars: () => 2000, canonicalKey: canonicalV2Key, log: () => {}
  });
  initialPromptStore.load();
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    root,
    socialV2,
    state: { sessions: { 'group:456': 'sid-1' }, sessionPolicies: { 'group:456': 'pol' } },
    api: { events: { forgetCalls: [], forget(sid) { this.forgetCalls.push(sid); } } },
    log: () => {},
    refreshAllDefaultWakeConfigsCalls: 0,
    refreshAllDefaultWakeConfigsV2: () => { deps.refreshAllDefaultWakeConfigsCalls += 1; },
    clearAllSocialV2TimersCalls: 0,
    clearAllSocialV2Timers: () => { deps.clearAllSocialV2TimersCalls += 1; },
    setupSleepTimerCalls: [],
    setupSleepTimerV2: (key) => deps.setupSleepTimerCalls.push(key),
    scheduleProactiveCheckCalls: [],
    scheduleProactiveCheckV2: (key) => deps.scheduleProactiveCheckCalls.push(key),
    saveSocialV2State: () => {},
    bumpSessionEpochCalls: 0,
    bumpSessionEpoch: () => { deps.bumpSessionEpochCalls += 1; },
    sessionPromises: map(),
    drainAllPromptQueuesCalls: [],
    drainAllPromptQueues: (msg) => deps.drainAllPromptQueuesCalls.push(msg),
    stopRetiredSessionCalls: [],
    stopRetiredSessionWork: (sid, key) => deps.stopRetiredSessionCalls.push([sid, key]),
    sessionModels: map(),
    modelAppliedSessions: map(),
    reverse: map(),
    collectors: map(),
    v2TurnStartAt: map(),
    turnLeaseNoted: map(),
    toolCallNames: map(),
    pendingSendToolCalls: map(),
    sendToolSucceededSessions: map(),
    forgetAgentTokenCalls: [],
    forgetAgentToken: (key) => deps.forgetAgentTokenCalls.push(key),
    seenForwardIds: map(),
    saveState: () => {},
    pendingWakeKeys: new Set(['group:456']),
    clearAllPendingWakeLeases: () => {},
    wakeConfigUpdatedKeys: new Set(['x']),
    markReadCalledKeys: new Set(['x']),
    wakeConfigMissCount: map(),
    socialV2File,
    getCurrentMode: () => 'reserved2',
    modeAllowed: () => true,
    getSocialV2State: (key) => {
      if (!socialV2.conversations.has(key)) {
        socialV2.conversations.set(key, { wakeConfig: { mode: 'diving', infinite: true, triggers: {} }, unread: [], recentMessages: [], bootstrapSent: false, pendingWakeTimer: null, lastWakeReason: '', lastAiReplyAt: 0 });
      }
      return socialV2.conversations.get(key);
    },
    sendWakePromptCalls: [],
    sendWakePromptV2: async (key, reason) => { deps.sendWakePromptCalls.push([key, reason]); return { ok: true }; },
    initialPrompts: initialPromptStore.entries,
    initialPromptStore,
    initialPromptMaxChars: () => 2000,
    canonicalV2Key,
    setInitialPrompt: (key, text) => initialPromptStore.set(key, text)
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleSocialV2AdminRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, cfg, socialV2 };
}

test('config POST：布尔收敛、keywords 字符串转数组、未知工具开关按默认关闭处理', async () => {
  const f = fixture();
  const h = harness(f);
  const result = await h.call('POST', '/api/socialV2/config', {
    enabled: 'yes',
    tools: { sendVoice: 'not-bool' },   // 非布尔 → 兜底 current.tools[k] !== false → cfg 默认 false 的话应保持 false
    wake: { recommendedKeywords: 'a, b，c', preSleepWaitEnabled: 1 }
  });
  assert.equal(result.last.obj.ok, true);
  assert.equal(h.cfg.socialV2.enabled, false, 'enabled 布尔化（=== 严格比较，非真值转换）');
  assert.equal(h.cfg.socialV2.tools.sendVoice, false, '非布尔开关不得把默认关闭的 sendVoice 打开');
  assert.deepEqual(h.cfg.socialV2.wake.recommendedKeywords, ['a', 'b', 'c']);
  assert.equal(h.cfg.socialV2.wake.preSleepWaitEnabled, false, '布尔化同样走 === 严格比较（1 不是 true）');
  assert.equal(h.deps.refreshAllDefaultWakeConfigsCalls, 1, 'wake 默认字段变化触发默认配置同步');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('config POST：子对象传 null/数组时保留当前值，不落盘垃圾', async () => {
  const f = fixture();
  const h = harness(f);
  const result = await h.call('POST', '/api/socialV2/config', { tools: null, wake: [] });
  assert.equal(result.last.obj.ok, true);
  assert.equal(typeof h.cfg.socialV2.tools, 'object');
  assert.equal(typeof h.cfg.socialV2.wake, 'object');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('activity：暂停清定时器，恢复逐会话重排定时器', async () => {
  const f = fixture();
  const h = harness(f);
  h.socialV2.conversations.set('group:456', {});
  await h.call('POST', '/api/socialV2/activity', { paused: true });
  assert.equal(h.socialV2.paused, true);
  assert.equal(h.deps.clearAllSocialV2TimersCalls, 1);
  const resume = await h.call('POST', '/api/socialV2/activity', { paused: false });
  assert.equal(resume.last.obj.paused, false);
  assert.deepEqual(h.deps.setupSleepTimerCalls, ['group:456']);
  assert.deepEqual(h.deps.scheduleProactiveCheckCalls, ['group:456']);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('reset：逐会话停工作/退订/清表，写空状态文件', async () => {
  const f = fixture();
  const h = harness(f);
  h.socialV2.conversations.set('group:456', {});
  h.socialV2.conversations.set('group:789', {});
  const result = await h.call('POST', '/api/socialV2/reset', {});
  assert.equal(result.last.obj.ok, true);
  assert.equal(h.deps.bumpSessionEpochCalls, 1);
  assert.deepEqual(h.deps.stopRetiredSessionCalls, [['sid-1', 'group:456']]);
  assert.deepEqual(h.deps.api.events.forgetCalls, ['sid-1']);
  assert.deepEqual(h.deps.forgetAgentTokenCalls.sort(), ['group:456', 'group:789']);
  assert.equal(h.socialV2.conversations.size, 0);
  assert.equal(h.socialV2.paused, false);
  const persisted = JSON.parse(fs.readFileSync(h.deps.socialV2File, 'utf8'));
  assert.deepEqual(persisted.conversations, {}, '状态文件被写成空 conversations');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('wake：首次唤醒升级为 bootstrap，非首次用请求原因', async () => {
  const f = fixture();
  const h = harness(f);
  const first = await h.call('POST', '/api/socialV2/wake', { key: 'group:456', reason: 'admin' });
  assert.equal(first.last.obj.firstWake, true);
  assert.equal(first.last.obj.reason, 'bootstrap');
  const second = await h.call('POST', '/api/socialV2/wake', { key: 'group:456', reason: 'admin' });
  assert.equal(second.last.obj.firstWake, false);
  assert.equal(second.last.obj.reason, 'admin');
  assert.deepEqual(h.deps.sendWakePromptCalls, [['group:456', 'bootstrap'], ['group:456', 'admin']]);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('wake：非 reserved2 模式 403；坏 key 400', async () => {
  const f = fixture();
  const h = harness(f);
  h.deps.getCurrentMode = () => 'chat';
  assert.equal((await h.call('POST', '/api/socialV2/wake', { key: 'group:456' })).last.status, 403);
  h.deps.getCurrentMode = () => 'reserved2';
  assert.equal((await h.call('POST', '/api/socialV2/wake', { key: 'evil' })).last.status, 400);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('initial-prompt：列表/读取/保存/显式删除全链路', async () => {
  const f = fixture();
  const h = harness(f);
  const save = await h.call('POST', '/api/socialV2/initial-prompt', { key: 'group:456', text: '群背景：技术群' });
  assert.equal(save.last.obj.ok, true);
  assert.equal(save.last.obj.chars, '群背景：技术群'.length);
  const read = await h.call('GET', '/api/socialV2/initial-prompt?key=group:456');
  assert.equal(read.last.obj.text, '群背景：技术群');
  const list = await h.call('GET', '/api/socialV2/initial-prompt');
  assert.equal(list.last.obj.entries.length, 1);
  const del = await h.call('POST', '/api/socialV2/initial-prompt', { key: 'group:456', delete: true });
  assert.equal(del.last.obj.deleted, true);
  // 缺 text 且未显式 delete：400，不得误删
  const missing = await h.call('POST', '/api/socialV2/initial-prompt', { key: 'group:456' });
  assert.equal(missing.last.status, 400);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('states：全会话概览带 noActionCount 兜底', async () => {
  const f = fixture();
  const h = harness(f);
  h.deps.getSocialV2State('group:456');
  const result = await h.call('GET', '/api/socialV2/states');
  assert.equal(result.last.obj.conversations[0].key, 'group:456');
  assert.equal(result.last.obj.conversations[0].noActionCount, 0);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('非本组路由返回 false', async () => {
  const f = fixture();
  const h = harness(f);
  assert.equal((await h.call('GET', '/api/socialV2/unread?key=group:456')).handled, false);
  fs.rmSync(f.root, { recursive: true, force: true });
});
