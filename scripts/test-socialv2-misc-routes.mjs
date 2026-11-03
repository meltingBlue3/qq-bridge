// socialv2-misc-routes 的直接路由回归：check-send / tool-log / feedback / my-recent / record-sent。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2MiscRoutes } from '../src/http/socialv2-misc-routes.js';

const truncate = (s, max) => String(s ?? '').slice(0, max);

function harness({ tools = {}, feedbackCfg = {}, agentOk = true } = {}) {
  const sent = [];
  let body = {};
  const cleared = { toolLog: 0, feedback: 0 };
  const appended = [];
  const activity = [];
  const deps = {
    cfg: { socialV2: { tools, feedback: feedbackCfg }, ownerQQ: 10001 },
    log: () => {},
    agentTokenOk: () => agentOk,
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => tools[flag] !== false,
    readToolLog: (limit) => [{ limit }],
    clearToolLog: () => { cleared.toolLog += 1; },
    readFeedbackEntries: () => [{ id: 'f1' }],
    appendFeedbackEntry: (e) => appended.push(e),
    clearFeedback: () => { cleared.feedback += 1; },
    feedbackTimes: new Map(),
    truncateText: truncate,
    appendActivity: (line) => activity.push(line),
    getSocialV2State: () => ({ recentMessages: [{ isSelf: true, text: '我说过a' }, { isSelf: false, text: '别人b' }, { isSelf: true, text: '我说过c' }] }),
    readThroughSeqV2: () => 42
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 't' }) => {
    body = bodyValue;
    const handled = await handleSocialV2MiscRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, cleared, appended, activity };
}

test('check-send：缺参 400；tool 非法 400；token 无效 403；工具未启用 403；成功 ok', async () => {
  const h = harness();
  const missing = await h.call('POST', '/api/socialV2/check-send', { key: 'group:1', tool: 'reply', token: '' });
  assert.equal(missing.last.status, 400);
  const badTool = await h.call('POST', '/api/socialV2/check-send', { key: 'group:1', tool: 'sticker', token: 't' });
  assert.equal(badTool.last.status, 400);
  const badToken = await harness({ agentOk: false }).call('POST', '/api/socialV2/check-send', { key: 'group:1', tool: 'reply', token: 'x' });
  assert.equal(badToken.last.status, 403);
  const disabled = await harness({ tools: { reply: false } }).call('POST', '/api/socialV2/check-send', { key: 'group:1', tool: 'reply', token: 't' });
  assert.equal(disabled.last.status, 403);
  assert.match(disabled.last.obj.error, /qq_reply/);
  const ok = await h.call('POST', '/api/socialV2/check-send', { key: 'group:1', tool: 'sendGroup', token: 't' });
  assert.deepEqual(ok.last.obj, { ok: true, key: 'group:1', tool: 'sendGroup' });
});

test('tool-log：GET clamp 到 1..500；clear 仅控制台（带 agent token 403）', async () => {
  const h = harness();
  const big = await h.call('GET', '/api/socialV2/tool-log?limit=99999');
  assert.deepEqual(big.last.obj.entries, [{ limit: 500 }]);
  // 部署语义：Number(0) || 200 → 0 会先落到默认 200，下限 clamp 只挡负数不挡 0。
  const small = await h.call('GET', '/api/socialV2/tool-log?limit=0');
  assert.deepEqual(small.last.obj.entries, [{ limit: 200 }]);
  const denied = await h.call('POST', '/api/socialV2/tool-log/clear', {}, { 'x-agent-token': 't' });
  assert.equal(denied.last.status, 403);
  const ok = await h.call('POST', '/api/socialV2/tool-log/clear', {}, {});
  assert.equal(ok.last.obj.ok, true);
  assert.equal(h.cleared.toolLog, 1);
});

test('feedback：GET 返回条目；clear 仅控制台；POST 缺 message 400', async () => {
  const h = harness();
  const list = await h.call('GET', '/api/socialV2/feedback');
  assert.deepEqual(list.last.obj.entries, [{ id: 'f1' }]);
  const denied = await h.call('POST', '/api/socialV2/feedback-clear', {}, { 'x-agent-token': 't' });
  assert.equal(denied.last.status, 403);
  const ok = await h.call('POST', '/api/socialV2/feedback-clear', {}, {});
  assert.equal(ok.last.obj.ok, true);
  assert.equal(h.cleared.feedback, 1);
  const empty = await h.call('POST', '/api/socialV2/feedback', { key: 'group:1', message: ' ' });
  assert.equal(empty.last.status, 400);
});

test('feedback POST：level 归一化 + 截断 + 落库；错误级提示 owner', async () => {
  const h = harness({ feedbackCfg: { maxLength: 10, notifyOwnerOnError: true } });
  const ok = await h.call('POST', '/api/socialV2/feedback', { key: 'group:1', message: 'x'.repeat(50), level: 'error' });
  assert.equal(ok.last.obj.ok, true);
  assert.equal(ok.last.obj.level, 'error');
  assert.equal(ok.last.obj.message.length, 10);
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].key, 'group:1');
  assert.equal(h.activity.length, 1);
  const unknownLevel = await h.call('POST', '/api/socialV2/feedback', { key: 'group:1', message: 'y' });
  assert.equal(unknownLevel.last.obj.level, 'info');
});

test('feedback POST：限频（1 分钟 5 条 → 429），计数保留最近 100 条', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    const r = await h.call('POST', '/api/socialV2/feedback', { key: 'group:1', message: `m${i}` });
    assert.equal(r.last.obj.ok, true, `第 ${i + 1} 条应成功`);
  }
  const limited = await h.call('POST', '/api/socialV2/feedback', { key: 'group:1', message: 'm6' });
  assert.equal(limited.last.status, 429);
  // 不同 key 独立计数
  const other = await h.call('POST', '/api/socialV2/feedback', { key: 'group:2', message: 'n' });
  assert.equal(other.last.obj.ok, true);
  assert.equal(h.deps.feedbackTimes.get('group:1').length, 5);
});

test('my-recent：缺 key 400；只返回 isSelf；limit clamp 1..50；带 readThroughSeq', async () => {
  const h = harness();
  const noKey = await h.call('GET', '/api/socialV2/my-recent');
  assert.equal(noKey.last.status, 400);
  const ok = await h.call('GET', '/api/socialV2/my-recent?key=group:1&limit=0');
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(ok.last.obj.messages.map((m) => m.text), ['我说过a', '我说过c']);
  assert.equal(ok.last.obj.readThroughSeq, 42);
  const tokenBad = await harness({ agentOk: false }).call('GET', '/api/socialV2/my-recent?key=group:1');
  assert.equal(tokenBad.last.status, 403);
});

test('record-sent：内部接口一律 403，不落库', async () => {
  const h = harness();
  const r = await h.call('POST', '/api/socialV2/record-sent', { key: 'group:1', messages: [{ text: '伪造' }] });
  assert.equal(r.last.status, 403);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/message-detail?key=group:1&messageId=1')).handled, false);
  assert.equal((await h.call('POST', '/api/socialV2/memory-append', { key: 'group:1', category: 'activeTopic', content: 'x' })).handled, false);
});
