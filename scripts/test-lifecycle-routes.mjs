// lifecycle-routes 的直接路由回归：全部状态用内存 Map/Set，api/退出都是记录型 stub。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLifecycleRoutes } from '../src/http/lifecycle-routes.js';

function harness({ apiOverride = {} } = {}) {
  const map = () => new Map();
  const deps = {
    state: { sessions: { 'group:456': 'old-session', 'group:789': 'other' }, sessionPolicies: { 'group:456': 'pol' } },
    api: {
      stopSessionWork: async () => {},
      workspace: { archiveSession: async () => {} },
      sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
      ...apiOverride
    },
    withTimeout: (p) => p,
    controlTimeoutMs: 1000,
    log: () => {},
    bumpSessionEpochCalls: 0,
    bumpSessionEpoch: () => { deps.bumpSessionEpochCalls += 1; },
    modelAppliedSessions: map(),
    reverse: map(),
    collectors: map(),
    sendToolSucceededSessions: map(),
    pendingSendToolCalls: map(),
    v2TurnStartAt: map(),
    turnLeaseNoted: map(),
    toolCallNames: map(),
    pending: map(),
    cancelPendingEntry: async () => {},
    queued: map(),
    queuedHintAt: map(),
    sessionPromises: map(),
    drainPromptQueueCalls: [],
    drainPromptQueue: (key, msg) => deps.drainPromptQueueCalls.push([key, msg]),
    social: {
      recentMessages: map(), pendingSummaries: map(), states: map(),
      silentContext: map(), silentTurns: map(), exitingSessions: map()
    },
    messageMediaStore: map(),
    slangWindows: map(),
    slangExtractionCooldowns: map(),
    slangSubmitTimes: map(),
    cancelSocialTimers: () => {},
    clearSocialV2Timers: () => {},
    cancelAllSocialTimers: () => {},
    clearAllSocialV2Timers: () => {},
    drainAllPromptQueuesCalls: [],
    drainAllPromptQueues: (msg) => deps.drainAllPromptQueuesCalls.push(msg),
    pendingWakeKeys: map(),
    wakeConfigUpdatedKeys: map(),
    markReadCalledKeys: map(),
    wakeConfigMissCount: map(),
    forgetAgentTokenCalls: [],
    forgetAgentToken: (key) => deps.forgetAgentTokenCalls.push(key),
    socialV2: { conversations: map() },
    seenForwardIds: map(),
    saves: { socialV2: 0, state: 0 },
    saveSocialV2State: () => { deps.saves.socialV2 += 1; },
    saveState: () => { deps.saves.state += 1; },
    conversationTokens: map(),
    knownAgentTokens: new Set(),
    stateDir: '/repo/state',
    activityLog: '/repo/state/qq-activity.log',
    releaseLock: () => {},
    exitCalls: [],
    exitProcess: (code) => deps.exitCalls.push(code)
  };
  const sent = [];
  let body = {};
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleLifecycleRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, sent };
}

test('session/reset：清映射/权限/collector/社交/唤醒/令牌并归档旧会话', async () => {
  const h = harness();
  const result = await h.call('POST', '/api/session/reset', { key: 'group:456' });
  assert.equal(result.last.obj.ok, true);
  assert.equal(result.last.obj.archived, 'old-session');
  const d = h.deps;
  assert.equal(d.state.sessions['group:456'], undefined);
  assert.equal(d.state.sessionPolicies['group:456'], undefined);
  for (const m of [d.modelAppliedSessions, d.reverse, d.collectors, d.sendToolSucceededSessions,
    d.pendingSendToolCalls, d.v2TurnStartAt, d.turnLeaseNoted, d.toolCallNames]) {
    assert.equal(m.has('old-session'), false);
  }
  assert.deepEqual(d.drainPromptQueueCalls, [['group:456', '会话已重置']]);
  assert.deepEqual(d.forgetAgentTokenCalls, ['group:456']);
  assert.equal(d.socialV2.conversations.has('group:456'), false);
  assert.equal(d.saves.socialV2 >= 1, true);
  assert.equal(d.saves.state >= 1, true);
});

test('session/reset：不存在的会话 404，不动任何表', async () => {
  const h = harness();
  const result = await h.call('POST', '/api/session/reset', { key: 'group:000' });
  assert.equal(result.last.status, 404);
  assert.equal(h.deps.saveStateCalls ?? 0, 0);
  assert.equal(h.deps.saves.state, 0);
});

test('workspace/reset：只归档 state/ 下的根会话，全表清空', async () => {
  const h = harness({ apiOverride: {
    sessions: { list: async () => ({ result: { ok: true, value: { items: [
      { sessionId: 'in-state', cwd: 'C:\\repo\\state\\agents\\group:456' },
      { sessionId: 'sub', origin: 'subagent', cwd: 'C:\\repo\\state\\agents\\x' },
      { sessionId: 'outside', cwd: 'C:\\other\\workspace' }
    ] } } }) }
  } });
  const result = await h.call('POST', '/api/workspace/reset', {});
  assert.equal(result.last.obj.ok, true);
  assert.equal(result.last.obj.archivedCount, 1);
  assert.deepEqual(h.deps.state.sessions, {});
  assert.equal(h.deps.socialV2.conversations.size, 0);
  assert.equal(h.deps.conversationTokens.size, 0);
  assert.equal(h.deps.knownAgentTokens.size, 0);
  assert.deepEqual(h.deps.drainAllPromptQueuesCalls, ['工作区已清空']);
});

test('workspace/reset：sessions.list 失败时仍然清空本地并返回计数 0', async () => {
  const h = harness({ apiOverride: { sessions: { list: async () => { throw new Error('dsh down'); } } } });
  const result = await h.call('POST', '/api/workspace/reset', {});
  assert.equal(result.last.obj.ok, true);
  assert.deepEqual(result.last.obj, { ok: true, archivedCount: 0, stoppedCount: 0 });
  assert.deepEqual(h.deps.state.sessions, {});
});

test('restart：先落盘再退出（500ms 定时器内），code=0', async () => {
  const h = harness();
  const result = await h.call('POST', '/api/restart', {});
  assert.equal(result.last.obj.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(h.deps.exitCalls, [0]);
  assert.ok(h.deps.saves.state >= 1 && h.deps.saves.socialV2 >= 1);
}, { timeout: 3000 });

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/status')).handled, false);
});
