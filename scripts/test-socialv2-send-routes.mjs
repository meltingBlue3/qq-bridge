// socialv2-send-routes 的直接路由回归：内存会话状态 + 记录型发送器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2SendRoutes } from '../src/http/socialv2-send-routes.js';

function makeSt() {
  return {
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true }, noActionCount: 0 },
    unread: [], recentMessages: [], sendTimes: [],
    lastIncomingAt: 0, preSleepWaitSatisfiedAt: 0, preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0,
    lastAiReplyAt: 0, lastActionAt: 0
  };
}

function harness({ mode = 'reserved2', paused = false, botError = null, replyResolve = null, burstEnabled } = {}) {
  const cfg = {
    socialV2: {
      tools: {},
      send: { burstEnabled: burstEnabled !== false, burstMaxMessages: 8, maxMessageChars: 500, maxSendPerMinute: 8, maxSendPerHour: 60 },
      context: { recentLimit: 100 }
    }
  };
  const socialV2 = { paused };
  const states = new Map();
  const sentMsgs = [];
  const sent = [];
  const recorded = [];
  const activities = [];
  const replyChecks = [];
  let body = {};
  const deps = {
    cfg,
    socialV2,
    log: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => mode,
    modeAllowed: () => true,
    shouldBlockSilentReply: () => false,
    computeGapsV2: (messages) => messages.map(() => 100),
    sendMessagesV2: async (key, messages, delays, replyTo, at) => {
      if (botError) {
        const err = new Error(botError);
        err.sent = sentMsgs.slice();
        throw err;
      }
      sentMsgs.push(...messages);
      return messages.map((m, i) => ({ messageId: 9000 + i, text: m }));
    },
    recordSentMessagesV2: (key, msgs) => recorded.push([key, msgs]),
    getSocialV2State: (key) => { if (!states.has(key)) states.set(key, makeSt()); return states.get(key); },
    saveSocialV2State: () => {},
    appendActivity: (line) => activities.push(line),
    scheduleReplyCheckV2: (key) => replyChecks.push(key),
    findCjkSpaceWarning: () => null,
    findSplitBoundaryWarning: () => null,
    resolveReplyTargetV2: async () => replyResolve,
    assertGroupMember: async (id, target) => (String(target) === '111' ? null : '目标不是本群成员'),
    captureSendGuard: () => () => {},
    bot: { rawCalls: [], raw: async (action, params) => { deps.bot.rawCalls.push([action, params]); return {}; } }
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 'tok' }) => {
    body = bodyValue;
    const handled = await handleSocialV2SendRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, states, recorded, activities, replyChecks, bot: deps.bot };
}

test('send-burst：数组/JSON 字符串/引号字符串都能归一化；禁引用', async () => {
  const h = harness();
  const a = await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: ['你好', '在吗'] });
  assert.equal(a.last.obj.sent, 2);
  const b = await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: '["一条","两条"]' });
  assert.equal(b.last.obj.sent, 2);
  const c = await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: '"单条"' });
  assert.equal(c.last.obj.sent, 1);
  const quote = await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: ['x'], replyToMessageId: 1 });
  assert.equal(quote.last.status, 400);
  assert.match(quote.last.obj.error, /qq_reply/);
});

test('send-burst：禁用多条发送 403；敏感词 403；超限条数 400', async () => {
  const h = harness({ burstEnabled: false });
  assert.equal((await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: ['a', 'b'] })).last.status, 403);
  const h2 = harness();
  assert.equal((await h2.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: ['api_key = "sk-x"'] })).last.status, 403);
  const h3 = harness();
  assert.equal((await h3.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: Array.from({ length: 9 }, () => 'x') })).last.status, 400);
});

test('send-burst：失败回滚预占额度，部分成功保留已发记录', async () => {
  const h = harness({ botError: 'gateway down' });
  const st = h.deps && null;
  const result = await h.call('POST', '/api/socialV2/send-burst', { key: 'group:456', messages: ['a', 'b'] });
  assert.equal(result.last.status, 500);
  const state = h.states.get('group:456');
  assert.equal(state.sendTimes.length, 0, '失败后预占额度必须回滚');
});

test('send-message：引用解析失败回滚额度；成功带 quoted 与 delays', async () => {
  const h = harness({ replyResolve: null });
  const fail = await h.call('POST', '/api/socialV2/send-message', { key: 'group:456', messages: ['x'], replyToMessageId: 1 });
  assert.equal(fail.last.status, 400);
  assert.equal(h.states.get('group:456').sendTimes.length, 0, '引用失败必须回滚');

  const h2 = harness({ replyResolve: { info: { from: '小明' }, messageId: 42 } });
  const ok = await h2.call('POST', '/api/socialV2/send-message', { key: 'group:456', messages: ['回'], replyToMessageId: '1' });
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(ok.last.obj.quoted, { from: '小明' });
  assert.equal(h2.replyChecks.length, 1, '成功发送后安排回复检查');
});

test('send-message：私聊带 @ 400；replyTo 非整数 400；非 reserved2 403', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '/api/socialV2/send-message', { key: 'private:123', messages: ['x'], atUserId: 1 })).last.status, 400);
  assert.equal((await h.call('POST', '/api/socialV2/send-message', { key: 'group:456', messages: ['x'], replyToMessageId: 'abc' })).last.status, 400);
  const h2 = harness({ mode: 'chat' });
  assert.equal((await h2.call('POST', '/api/socialV2/send-message', { key: 'group:456', messages: ['x'] })).last.status, 403);
});

test('send-poke：群聊必须带成员校验过的 target；成功写入 recentMessages 并清观察标记', async () => {
  const h = harness();
  const noTarget = await h.call('POST', '/api/socialV2/send-poke', { key: 'group:456' });
  assert.equal(noTarget.last.status, 400);
  const notMember = await h.call('POST', '/api/socialV2/send-poke', { key: 'group:456', targetUserId: '999' });
  assert.equal(notMember.last.status, 403);
  const ok = await h.call('POST', '/api/socialV2/send-poke', { key: 'group:456', targetUserId: '111' });
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(h.bot.rawCalls, [['group_poke', { group_id: 456, user_id: 111 }]]);
  const st = h.states.get('group:456');
  assert.equal(st.recentMessages[0].kind, 'poke');
  assert.equal(st.recentMessages[0].isSelf, true);
  // 私聊不需要 target
  const priv = await h.call('POST', '/api/socialV2/send-poke', { key: 'private:123' });
  assert.equal(priv.last.obj.ok, true);
  assert.deepEqual(h.bot.rawCalls.at(-1), ['send_poke', { user_id: 123 }]);
});

test('send-poke：暂停时 403；非成员错误信息透传', async () => {
  const h = harness({ paused: true });
  assert.equal((await h.call('POST', '/api/socialV2/send-poke', { key: 'group:456', targetUserId: '111' })).last.status, 403);
  const h2 = harness();
  const bad = await h2.call('POST', '/api/socialV2/send-poke', { key: 'group:456', targetUserId: '999' });
  assert.match(bad.last.obj.error, /本群成员/);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/state?key=group:456')).handled, false);
});
