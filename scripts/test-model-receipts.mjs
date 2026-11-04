// 已展示回执（会话方反馈①）：同一条消息不再同时出现在 快照/未读/最近 三个面。
//  - receipts 纯函数直测：登记去重/有界、修剪、recent 过滤、未看过计数；
//  - recent 路由：agent 视角去重 + 控制台视角全量；
//  - harness 端到端：唤醒快照投递登记回执后，下一回合快照不再重复下发 recent 上下文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  countUnseenUnread,
  filterUnshownRecent,
  isShownSeq,
  pruneShownSeqs,
  rememberShownSeqs,
  shownPendingCount,
  unreadCountNote,
  SHOWN_SEQS_CAPACITY_DEFAULT
} from '../src/social-v2/receipts.js';
import { handleSocialV2SessionRoutes } from '../src/http/socialv2-session-routes.js';

// ── 模块直测 ─────────────────────────────────────────────────────────────
test('rememberShownSeqs：去重、有界 FIFO、容忍脏条目', () => {
  const st = {};
  assert.equal(rememberShownSeqs(st, [{ seq: 3 }, { seq: 5 }, { seq: 3 }, null, {}, { seq: 0 }, { seq: -1 }]), 2);
  assert.deepEqual(st.modelShownSeqs, [3, 5]);
  assert.equal(isShownSeq(st, 3), true);
  assert.equal(isShownSeq(st, 4), false);

  const tiny = {};
  rememberShownSeqs(tiny, Array.from({ length: 10 }, (_, i) => ({ seq: i + 1 })), { capacity: 4 });
  assert.deepEqual(tiny.modelShownSeqs, [7, 8, 9, 10], '超容量时保留最新的');
  assert.equal(rememberShownSeqs(tiny, []), 0);

  // 容量缺省值有界：灌 2× 容量也不炸
  const big = {};
  rememberShownSeqs(big, Array.from({ length: SHOWN_SEQS_CAPACITY_DEFAULT * 2 }, (_, i) => ({ seq: i + 1 })));
  assert.equal(big.modelShownSeqs.length, SHOWN_SEQS_CAPACITY_DEFAULT);
});

test('pruneShownSeqs：滚出 recent/unread 的回执自动失效', () => {
  const st = { recentMessages: [{ seq: 2 }], unread: [], modelShownSeqs: [1, 2, 3] };
  pruneShownSeqs(st);
  assert.deepEqual(st.modelShownSeqs, [2]);
  // 没有字段时安全初始化
  const empty = {};
  pruneShownSeqs(empty);
  assert.deepEqual(empty.modelShownSeqs, []);
});

test('filterUnshownRecent：未读缓冲 + 已展示 + modelSeenSeqs 三路去重', () => {
  const st = {
    recentMessages: [
      { seq: 1, text: '旧' }, { seq: 2, text: '在未读' }, { seq: 3, text: '已展示' }, { seq: 4, text: '新的' }
    ],
    unread: [{ seq: 2 }],
    modelShownSeqs: [3],
    modelSeenSeqs: new Set([4])
  };
  const r = filterUnshownRecent(st, st.recentMessages, { hideUnreadSeqs: new Set([2]) });
  assert.deepEqual(r.messages.map((m) => m.seq), [1], '只剩谁都没见过的 seq 1');
  assert.equal(r.excludedUnread, 1);
  assert.equal(r.excludedShown, 2);
  // 不传 hideUnreadSeqs：未读成员照常返回（未读工具关闭时的兜底）
  const r2 = filterUnshownRecent(st, st.recentMessages);
  assert.deepEqual(r2.messages.map((m) => m.seq), [1, 2]);
  assert.equal(r2.excludedUnread, 0);
});

test('countUnseenUnread：只数模型没见过的未读', () => {
  const st = {
    unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    modelSeenSeqs: new Set([1, 2])
  };
  assert.equal(countUnseenUnread(st), 1);
  assert.equal(countUnseenUnread({ unread: [] }), 0);
  assert.equal(countUnseenUnread({ unread: [{ seq: 9 }] }), 1, '无回执字段时全部算没看过');
});

test('unreadCountNote：两口径不一致时自解释，一致时返回 null（N1）', () => {
  const st = {
    unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    modelSeenSeqs: new Set([1, 2, 3])
  };
  assert.equal(shownPendingCount(st), 3);
  const note = unreadCountNote(st);
  assert.match(note, /3 条已经展示给你/);
  assert.match(note, /mark_read/);
  assert.equal(unreadCountNote({ unread: [{ seq: 5 }], modelSeenSeqs: new Set() }), null, '全是新消息时不需要解释');
  assert.equal(unreadCountNote({ unread: [] }), null);
});

// ── recent 路由 ──────────────────────────────────────────────────────────
function routeHarness() {
  const states = new Map();
  const sent = [];
  const deps = {
    cfg: { socialV2: { tools: {}, wake: {}, sticker: { enabled: false, includeInPrompt: false }, voice: { enabled: false }, provideRecommendations: false }, slang: { enabled: false } },
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => 'reserved2',
    getSocialV2State: (key) => {
      if (!states.has(key)) {
        states.set(key, { unread: [], recentMessages: [], modelShownSeqs: [], modelSeenSeqs: new Set(), lastUnreadSeq: 0, lastReadThroughSeq: 0, wakeConfig: { mode: 'diving', triggers: {} }, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0, lastAiReplyAt: 0, lastActionAt: 0, lastIncomingAt: 0, pendingWakeTimer: null, agentToken: 'tok' });
      }
      return states.get(key);
    },
    saveSocialV2State: () => {},
    computeWakeSafetyV2: () => ({ guaranteed: true }),
    isSleepingConfigV2: () => true,
    preSleepWaitBlockedV2: () => false,
    ensureWakeableV2: () => {},
    pickWakeTriggersV2: (s, fb) => ({ ...fb }),
    normalizeSpeakerIdsV2: (v) => (Array.isArray(v) ? v : []),
    readThroughSeqV2: (st) => st.lastReadThroughSeq ?? 0,
    // 与 bridge 一致：登记 readThrough 凭证 + 展示回执
    noteModelMessagesV2: (st, messages) => {
      for (const m of messages) if (Number.isSafeInteger(m?.seq)) st.modelSeenSeqs.add(m.seq);
      rememberShownSeqs(st, messages);
      pruneShownSeqs(st);
      return readThroughSeqV2Deps(st);
    },
    requestedReadThroughSeqV2: () => null,
    acknowledgeMessagesV2: () => 0,
    markReadCalledKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    wakeConfigMissCount: new Set(),
    cancelReplyCheckV2: () => {},
    setupSleepTimerV2: () => {},
    syncStickerLibrary: async () => {},
    readRoleState: () => ({ role: null }),
    stickerEnabled: () => false,
    getSelfIdentity: () => ({}),
    currentRoleHint: () => '',
    currentRoleHintV2: () => '',
    replyTimingV2: () => ({ quietMs: 10000, remainingQuietMs: 0 }),
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
  function readThroughSeqV2Deps(st) {
    const seqs = st.unread.map((m) => m.seq).filter(Number.isSafeInteger);
    return seqs.length ? Math.max(...seqs) : 0;
  }
  const call = async (pathname, headers = {}) => {
    await handleSocialV2SessionRoutes({
      req: { method: 'GET', headers },
      url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => ({}),
      deps
    });
    return sent.at(-1);
  };
  return { call, deps, states };
}

test('recent 路由：agent 视角跳过未读与已展示，控制台视角全量', async () => {
  const h = routeHarness();
  const st = h.deps.getSocialV2State('group:456');
  st.recentMessages = [
    { seq: 1, text: '更早' }, { seq: 2, text: '更早' },
    { seq: 3, text: '已展示过' }, { seq: 4, text: '还在未读' }
  ];
  st.unread = [{ seq: 4, text: '还在未读' }];
  st.modelShownSeqs = [3];

  const agent = await h.call('/api/socialV2/recent?key=group:456&limit=20', { 'x-agent-token': 'tok' });
  assert.deepEqual(agent.obj.messages.map((m) => m.seq), [1, 2], '只给没看过的更早上下文');
  assert.equal(agent.obj.excludedShownCount, 1);
  assert.equal(agent.obj.excludedUnreadCount, 1);

  const consoleView = await h.call('/api/socialV2/recent?key=group:456&limit=20', {});
  assert.equal(consoleView.obj.messages.length, 4, '控制台视角保持全量');
  assert.equal(consoleView.obj.excludedShownCount, 0);
});

test('recent 路由：本次返回的会被登记，翻页 offset 不再重复给出', async () => {
  const h = routeHarness();
  const st = h.deps.getSocialV2State('group:456');
  st.recentMessages = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, text: `m${i + 1}` }));
  const first = await h.call('/api/socialV2/recent?key=group:456&limit=3', { 'x-agent-token': 'tok' });
  assert.deepEqual(first.obj.messages.map((m) => m.seq), [4, 5, 6]);
  const second = await h.call('/api/socialV2/recent?key=group:456&limit=3', { 'x-agent-token': 'tok' });
  assert.deepEqual(second.obj.messages.map((m) => m.seq), [1, 2, 3], '第二次调用不再重复下发上一批');
  assert.equal(second.obj.excludedShownCount, 3);
});

test('unread 路由：newUnreadCount 只数调用时尚未展示的——缓冲未清也不虚报', async () => {
  const h = routeHarness();
  const st = h.deps.getSocialV2State('group:456');
  st.recentMessages = [
    { seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }
  ];
  st.unread = [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }, { seq: 3, text: 'c' }];
  // 第一次读取：3 条全部展示并登记 → 本次调用时 3 条都没见过（返回的就是它们）
  const first = await h.call('/api/socialV2/unread?key=group:456', { 'x-agent-token': 'tok' });
  assert.deepEqual(first.obj.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(first.obj.unreadCount, 3);
  assert.equal(first.obj.newUnreadCount, 3, '口径是「调用发生时没见过的」，与返回的消息一一对应');
  assert.equal(first.obj.excludedShownCount, 0);
  // 新到一条：缓冲 4 条，但模型只缺 1 条
  st.unread.push({ seq: 4, text: 'd' });
  st.recentMessages.push({ seq: 4, text: 'd' });
  const second = await h.call('/api/socialV2/unread?key=group:456', { 'x-agent-token': 'tok' });
  assert.deepEqual(second.obj.messages.map((m) => m.seq), [4], '默认读取只给没见过的');
  assert.equal(second.obj.unreadCount, 4, '缓冲总量如实上报');
  assert.equal(second.obj.newUnreadCount, 1, '这就是「显示 9 条其实就 1 条新的」的解法');
  assert.equal(second.obj.excludedShownCount, 3);
  // 显式 afterSeq 分页不受去重影响：仍能精确拿到旧窗口
  const paged = await h.call('/api/socialV2/unread?key=group:456&afterSeq=0&limit=2', { 'x-agent-token': 'tok' });
  assert.deepEqual(paged.obj.messages.map((m) => m.seq), [1, 2], '积压续读保持精确窗口');
});

// ── harness 端到端：快照回执闭环 ─────────────────────────────────────────
test('唤醒快照投递后，下一回合快照的 recent 不再重复上回合内容', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'group:456';
    for (let i = 1; i <= 10; i += 1) {
      h.appendSocialV2Message(key, `群友${i}`, `消息${i}`, `消息${i}`, false, false, 1000 + i);
    }
    const st = h.getSocialV2State(key);
    // 前 4 条已确认已读（mark_read 语义）：它们滚出未读、留在 recent，构成「更早上下文」。
    st.unread = st.unread.filter((m) => m.seq > 4);
    st.lastReadThroughSeq = 4;
    const snap1 = h.buildWakeSnapshotV2(key);
    assert.ok(snap1.messages.length >= 6, '第一回合快照带未读');
    assert.ok(snap1.recent.length > 0, '第一回合快照带 recent 上下文');
    // 模拟投递被 DSH 接受后的登记（bridge 在 prompt accepted 之后做的事）
    h.noteModelMessagesV2(st, [...snap1.messages, ...snap1.recent]);
    const snap2 = h.buildWakeSnapshotV2(key);
    const shownSeqs = new Set([...snap1.messages, ...snap1.recent].map((m) => m.seq));
    for (const m of [...snap2.messages, ...snap2.recent]) {
      assert.equal(shownSeqs.has(m.seq), false, `seq ${m.seq} 上一回合已展示，不应重复下发`);
    }
    // 会话方反馈③：两个计数口径并存——缓冲还在（没 mark_read），但内容不再重发。
    assert.equal(snap2.unreadCount, st.unread.length, 'unreadCount 是缓冲总量');
    assert.equal(snap2.newUnreadCount, 0, 'newUnreadCount 如实反映「都见过了」');
  } finally {
    await h.close();
  }
});
