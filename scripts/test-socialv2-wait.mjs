// wait 路由的直接回归：小 timeoutMs + minQuietAfterNewMs=0，内存会话状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWaitRoute } from '../src/http/socialv2-wait-route.js';

function makeSt() {
  return {
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true }, noActionCount: 0 },
    unread: [], recentMessages: [],
    lastUnreadSeq: 0, lastIncomingAt: 0,
    preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0,
    lastAiReplyAt: 0, lastActionAt: 0, pendingWakeTimer: null
  };
}

function harness({ paused = false } = {}) {
  const states = new Map();
  const socialV2 = { paused, conversations: new Map() };
  const activeWaits = new Map();
  const sent = [];
  let body = {};
  const deps = {
    cfg: { socialV2: { tools: {}, wait: { defaultMs: 200, minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 }, wake: { preSleepWaitMs: 300000 }, context: { unreadLimit: 30 } } },
    socialV2,
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => 'reserved2',
    getSocialV2State: (key) => {
      if (!states.has(key)) {
        states.set(key, makeSt());
        socialV2.conversations.set(key, states.get(key));
      }
      return states.get(key);
    },
    saveSocialV2State: () => {},
    readThroughSeqV2: (st) => st.lastReadThroughSeq ?? 0,
    noteModelMessagesV2: (st, messages) => {
      const maxSeq = Math.max(0, ...messages.map((m) => m.seq || 0), st.lastReadThroughSeq ?? 0);
      st.lastReadThroughSeq = maxSeq;
      return maxSeq;
    },
    canonicalV2Key: (key) => key,
    activeWaits,
    activeWaitLeaseMs: 15000,
    suggestQuietMsV2: () => 0,
    cancelReplyCheckV2: () => {},
    preSleepWaitBlockedV2: (st) => !(st.preSleepWaitSatisfiedAt || st.preSleepWaitObservedAt || st.lastIncomingAt)
  };
  const call = async (pathname, bodyValue = {}, headers = { 'x-agent-token': 'tok' }) => {
    body = bodyValue;
    const fakeReq = { method: 'POST', headers, on() {} };
    const fakeRes = { on() {} };
    const handled = await handleWaitRoute({
      req: fakeReq, res: fakeRes, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, states, activeWaits, deps };
}

test('暂停时立即返回不等待', async () => {
  const h = harness({ paused: true });
  const st = h.deps.getSocialV2State('group:456');
  st.unread = [{ seq: 1, text: 'a' }];
  const result = await h.call('/api/socialV2/wait', { key: 'group:456', timeoutMs: 200 });
  assert.equal(result.last.obj.paused, true);
  assert.equal(result.last.obj.arrived, false);
  assert.deepEqual(result.last.obj.newMessages, []);
});

test('messages 等待：新消息到达后立即返回并补齐水位后的消息', async () => {
  const h = harness();
  const st = h.deps.getSocialV2State('group:456');
  st.recentMessages = [{ seq: 1, text: '老的', isSelf: false }];
  st.lastUnreadSeq = 1;
  st.lastReadThroughSeq = 1; // seq 1 已读过：水位补齐只应给 seq 2
  setTimeout(() => { st.lastUnreadSeq = 2; st.recentMessages.push({ seq: 2, text: '新', isSelf: false }); }, 50);
  const result = await h.call('/api/socialV2/wait', { key: 'group:456', timeoutMs: 500, quietMs: 0 });
  assert.equal(result.last.obj.arrived, true);
  assert.deepEqual(result.last.obj.newMessages.map((m) => m.seq), [2], '按水位补齐，不含已在 readThroughSeq 里的');
  assert.equal(result.last.obj.readThroughSeq, 2);
});

test('reply 等待：quietMs=0 立即安静 → arrived=false、timeout=false（可直接回）', async () => {
  const h = harness();
  const result = await h.call('/api/socialV2/wait', { key: 'group:456', purpose: 'reply', timeoutMs: 150, quietMs: 0 });
  assert.equal(result.last.obj.purpose, 'reply');
  assert.equal(result.last.obj.arrived, false);
  assert.equal(result.last.obj.timeout, false, '已安静够久不算超时');
  assert.equal(result.last.obj.speakerLikelyDone, true);
  assert.equal(result.last.obj.preSleepWaitMs, undefined, 'reply 不带沉睡前观察字段');
});

test('messages 等满观察窗口：preSleepWaitSatisfied=true 且 countsAsObservation=true', async () => {
  const h = harness();
  // 观察 5 分钟窗口用 cfg.preSleepWaitMs 缩不了（默认 300000）……
  // 这里直接把 cfg 的窗口改小来验证「timeoutMs >= 窗口 ⇒ 算观察」的判定。
  h.deps.cfg.socialV2.wake.preSleepWaitMs = 200;
  const result = await h.call('/api/socialV2/wait', { key: 'group:456', timeoutMs: 250, quietMs: 0 });
  assert.equal(result.last.obj.preSleepWaitSatisfied, true);
  assert.equal(result.last.obj.countsAsObservation, true);
  // canSleepNow 在本次等待内仍为 false：闸门在等待开始时取的快照；
  // 满足标记写入后，下一次 mark-read 才会被放行（部署语义）。
  assert.equal(result.last.obj.canSleepNow, false);
});

test('短等待不算观察：canSleepNow=false 且 hint 说明不达标', async () => {
  const h = harness();
  const result = await h.call('/api/socialV2/wait', { key: 'group:456', timeoutMs: 150, quietMs: 0 });
  assert.equal(result.last.obj.canSleepNow, false);
  assert.equal(result.last.obj.countsAsObservation, false);
  assert.match(result.last.obj.hint, /不达标/);
});

test('同一会话并发等待 429；purpose 非法 400', async () => {
  const h = harness();
  h.deps.activeWaits.set('group:456', Date.now());
  assert.equal((await h.call('/api/socialV2/wait', { key: 'group:456', timeoutMs: 100 })).last.status, 429);
  assert.equal((await h.call('/api/socialV2/wait', { key: 'group:456', purpose: 'zzz' })).last.status, 400);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('/api/socialV2/unread?key=group:456')).handled, false);
});
