// socialv2-session-routes 的直接路由回归：内存会话状态 + stub 鉴权/聚合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2SessionRoutes } from '../src/http/socialv2-session-routes.js';
import { computeWakeSafetyV2, pickWakeTriggersV2, normalizeSpeakerIdsV2 } from '../src/social-v2/wake-policy.js';

function makeSt() {
  return {
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true }, batchWindowMs: 8000, noActionCount: 0 },
    unread: [],
    recentMessages: [],
    lastIncomingAt: 0,
    preSleepWaitSatisfiedAt: 0,
    preSleepWaitObservedAt: 0,
    preSleepWaitAccumMs: 0,
    lastWakeReason: '',
    lastAiReplyAt: 0,
    lastActionAt: 0,
    pendingWakeTimer: null
  };
}

function harness({ mode = 'reserved2', token = 'tok-1', tools = {} } = {}) {
  const states = new Map();
  const cfg = {
    socialV2: {
      tools: { ...tools },
      wake: { preSleepWaitMs: 300000, sleepMinMs: 60000, sleepMaxMs: 7200000, recommendedSleepMinMs: 300000, recommendedSleepMaxMs: 7200000 },
      send: {}, wait: {}, proactive: {}, sticker: { enabled: false, includeInPrompt: false },
      voice: { enabled: false }, provideRecommendations: false
    },
    slang: { enabled: false },
  };
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    log: () => {},
    agentTokenOk: (key, t) => t === token,
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => tools[flag] !== false,
    getCurrentMode: () => mode,
    getSocialV2State: (key) => { if (!states.has(key)) states.set(key, makeSt()); return states.get(key); },
    saveSocialV2State: () => {},
    computeWakeSafetyV2,
    isSleepingConfigV2: (wc) => wc && wc.mode !== 'active' && !wc.triggers?.anyMessage,
    preSleepWaitBlockedV2: (st) => !(st.preSleepWaitSatisfiedAt || st.preSleepWaitObservedAt || st.lastIncomingAt),
    ensureWakeableV2: () => {},
    pickWakeTriggersV2,
    normalizeSpeakerIdsV2,
    readThroughSeqV2: (st, additional = []) => {
      const seqs = [...st.unread, ...(additional || [])].map((m) => m.seq).filter(Number.isSafeInteger);
      return seqs.length ? Math.max(...seqs) : 0;
    },
    requestedReadThroughSeqV2: (st, body2, isAgent) => {
      const v = Number(body2?.throughSeq);
      return Number.isSafeInteger(v) && v >= 0 ? v : null;
    },
    acknowledgeMessagesV2: (st, throughSeq) => {
      const before = st.unread.length;
      st.unread = throughSeq == null ? [] : st.unread.filter((m) => Number(m.seq) > throughSeq);
      return before - st.unread.length;
    },
    noteModelMessagesV2: (st, messages) => deps.readThroughSeqV2(st, messages),
    markReadCalledKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    wakeConfigMissCount: new Set(),
    cancelReplyCheckCalls: [],
    cancelReplyCheckV2: (key) => deps.cancelReplyCheckCalls.push(key),
    setupSleepTimerCalls: [],
    setupSleepTimerV2: (key) => deps.setupSleepTimerCalls.push(key),
    syncStickerLibrary: async () => {},
    readRoleState: () => ({ role: null, mode: 'active' }),
    stickerEnabled: () => false,
    getSelfIdentity: () => ({ nickname: 'Tesphmil', userId: '2705014082', line: '你是 Tesphmil' }),
    currentRoleHint: () => '',
    currentRoleHintV2: () => '',
    replyTimingV2: () => ({ purpose: 'reply', quietMs: 10000, remainingQuietMs: 0 }),
    formatMemoryV2: () => '',
    formatParticipationV2: () => '',
    confirmedSlangListV2: () => [],
    slangEntries: [],
    buildSlangContext: () => '',
    stickerEntries: [],
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    voiceLibrary: () => [],
    voiceCfg: () => ({ maxSeconds: 300 })
  };
  const call = async (method, pathname, bodyValue = {}, headers = {}) => {
    body = bodyValue;
    const handled = await handleSocialV2SessionRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, states, cfg };
}

test('state：带 token 时校验 token/工具开关，返回唤醒安全摘要', async () => {
  const h = harness();
  const ok = await h.call('GET', '/api/socialV2/state?key=group:456', {}, { 'x-agent-token': 'tok-1' });
  assert.equal(ok.last.obj.wakeConfig.mode, 'diving');
  assert.equal(ok.last.obj.wakeSafety.guaranteed, true);
  const badToken = await h.call('GET', '/api/socialV2/state?key=group:456', {}, { 'x-agent-token': 'wrong' });
  assert.equal(badToken.last.status, 403);
  const toolOff = await h.call('GET', '/api/socialV2/state?key=group:456', {}, { 'x-agent-token': 'tok-1' });
  assert.equal(toolOff.last.status, 200);
  const h2 = harness({ tools: { socialState: false } });
  assert.equal((await h2.call('GET', '/api/socialV2/state?key=group:456', {}, { 'x-agent-token': 'tok-1' })).last.status, 403);
});

test('prompt：工具清单按开关与表情开关过滤；语音关闭时不给语音摘要', async () => {
  const h = harness();
  const result = await h.call('GET', '/api/socialV2/prompt?key=group:456', {}, { 'x-agent-token': 'tok-1' });
  const names = result.last.obj.enabledTools;
  assert.ok(names.includes('qq_send_message'));
  assert.ok(!names.includes('qq_list_stickers'), '表情体系关闭时表情工具不出现');
  assert.deepEqual(result.last.obj.voices, { enabled: false });
  assert.equal(result.last.obj.self.nickname, 'Tesphmil');
});

test('unread：afterSeq 校验、光标分页、带 token 记录已读水位', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.unread = [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }];
  const bad = await h.call('GET', '/api/socialV2/unread?key=group:456&afterSeq=-1', {}, { 'x-agent-token': 'tok-1' });
  assert.equal(bad.last.status, 400);
  const paged = await h.call('GET', '/api/socialV2/unread?key=group:456&afterSeq=1', {}, { 'x-agent-token': 'tok-1' });
  assert.deepEqual(paged.last.obj.messages.map((m) => m.seq), [2, 3]);
  assert.equal(paged.last.obj.readThroughSeq, 3);
  const tail = await h.call('GET', '/api/socialV2/unread?key=group:456&limit=2', {}, { 'x-agent-token': 'tok-1' });
  assert.deepEqual(tail.last.obj.messages.map((m) => m.seq), [2, 3]);
});

test('mark-read：潜水+未观察 → 400 阻塞；已观察 → 清未读并确认配置', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.unread = [{ seq: 1, text: 'a' }];
  const blocked = await h.call('POST', '/api/socialV2/mark-read', { key: 'group:456', throughSeq: 1 }, { 'x-agent-token': 'tok-1' });
  assert.equal(blocked.last.status, 400);
  assert.match(blocked.last.obj.error, /沉睡前观察/);
  st.preSleepWaitSatisfiedAt = Date.now();
  const ok = await h.call('POST', '/api/socialV2/mark-read', { key: 'group:456', throughSeq: 1 }, { 'x-agent-token': 'tok-1' });
  assert.equal(ok.last.obj.markedCount, 1);
  assert.equal(ok.last.obj.wakeConfig.confirmedBy, 'mark_read');
  assert.ok(h.deps.markReadCalledKeys.has('group:456'));
});

test('wake-config：active 强制 anyMessage+无限；diving 缺省清 anyMessage；无限必须留触发', async () => {
  const h = harness();
  const active = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'active' } }, { 'x-agent-token': 'tok-1' });
  assert.equal(active.last.obj.wakeConfig.mode, 'active');
  assert.equal(active.last.obj.wakeConfig.triggers.anyMessage, true);
  assert.equal(active.last.obj.wakeConfig.infinite, true);

  const st = h.deps.getSocialV2State('group:456');
  st.preSleepWaitSatisfiedAt = Date.now(); // 已完成沉睡前观察，diving 不再被闸门挡
  const diving = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving' } }, { 'x-agent-token': 'tok-1' });
  assert.equal(diving.last.obj.wakeConfig.triggers.anyMessage, false, '未显式保留时清除');

  const noTrigger = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: false } } }, { 'x-agent-token': 'tok-1' });
  assert.equal(noTrigger.last.status, 400);
  assert.match(noTrigger.last.obj.error, /永眠/);

  st.preSleepWaitSatisfiedAt = Date.now(); // diving 成功会清标记，这条再置一次
  const withTrigger = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true } } }, { 'x-agent-token': 'tok-1' });
  assert.equal(withTrigger.last.obj.wakeConfig.confirmedBy, 'set_wake_config');
  assert.deepEqual(h.deps.cancelReplyCheckCalls.filter((k) => k === 'group:456').length >= 1, true);
});

test('wake-config：speakerIds 归一化；私聊强制清空；未观察潜水被阻塞', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.preSleepWaitSatisfiedAt = Date.now();
  const group = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true, speakerIds: ['123', 'x', '123'] } } }, { 'x-agent-token': 'tok-1' });
  assert.deepEqual(group.last.obj.wakeConfig.triggers.speakerIds, ['123']);

  h.deps.getSocialV2State('private:123').preSleepWaitSatisfiedAt = Date.now(); // 私聊是独立会话状态
  const priv = await h.call('POST', '/api/socialV2/wake-config', { key: 'private:123', config: { mode: 'diving', infinite: true, triggers: { atMention: true, speakerIds: ['123'] } } }, { 'x-agent-token': 'tok-1' });
  assert.deepEqual(priv.last.obj.wakeConfig.triggers.speakerIds, []);

  const blocked = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true } } }, { 'x-agent-token': 'tok-1' });
  assert.equal(blocked.last.status, 400);
  assert.match(blocked.last.obj.error, /沉睡前观察/);
});

test('wake-config：markRead 关闭时只改配置不确认水位', async () => {
  const h = harness({ tools: { markRead: false } });
  const st = h.deps.getSocialV2State('group:456');
  st.unread = [{ seq: 1, text: 'a' }];
  st.preSleepWaitSatisfiedAt = Date.now();
  const result = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', throughSeq: 1, config: { mode: 'diving', infinite: true, triggers: { atMention: true } } }, { 'x-agent-token': 'tok-1' });
  assert.equal(result.last.obj.markedCount, 0);
  assert.equal(st.unread.length, 1, 'markRead 关闭时不确认水位');
});

test('wake-config：batchWindowMs 不传跟随全局，显式合法值才覆盖', async () => {
  const h = harness();
  h.deps.cfg.socialV2.wake.batchWindowMs = 12000;
  const st = h.deps.getSocialV2State('group:456');
  st.wakeConfig.batchWindowMs = 8000; // 旧实现会把这个会话旧值逐字回写，钉死全局调参
  st.preSleepWaitSatisfiedAt = Date.now();
  const follow = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true } } }, { 'x-agent-token': 'tok-1' });
  assert.equal(follow.last.obj.wakeConfig.batchWindowMs, 12000, '不传时跟随全局，不被会话旧值钉死');

  st.preSleepWaitSatisfiedAt = Date.now(); // diving 成功会清观察标记，每次 diving 前重置
  const explicit = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true }, batchWindowMs: 5000 } }, { 'x-agent-token': 'tok-1' });
  assert.equal(explicit.last.obj.wakeConfig.batchWindowMs, 5000, '显式合法值覆盖');

  st.preSleepWaitSatisfiedAt = Date.now();
  const tooSmall = await h.call('POST', '/api/socialV2/wake-config', { key: 'group:456', config: { mode: 'diving', infinite: true, triggers: { atMention: true }, batchWindowMs: 500 } }, { 'x-agent-token': 'tok-1' });
  assert.equal(tooSmall.last.obj.wakeConfig.batchWindowMs, 12000, '非法值回落全局，而不是沿用上一条的会话值');
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/config')).handled, false);
});
