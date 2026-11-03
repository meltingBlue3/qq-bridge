// send-routes 的直接路由回归：authorize/read / images/message / send/{group,private,reply}。
// 重点钉住部署语义：空 token 拒绝、静默/暂停闸门、频率预占与失败回滚、reply 解析失败 400。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendRoutes } from '../src/http/send-routes.js';

function harness({
  mode = 'reserved2', agentOk = true, tools = {}, paused = false,
  silent = false, modeAllowedFn = () => true, sendError = null,
  stateFactory // 默认按 key 记忆化，模拟真实「同一会话状态对象」
} = {}) {
  const sent = [];
  let body = {};
  const calls = { send: [], record: [], replyCheck: [], fetchMedia: [], findMedia: [], activity: [], saved: 0 };
  const stateCache = new Map();
  const memoState = stateFactory || ((key) => {
    if (!stateCache.has(key)) stateCache.set(key, { sendTimes: [], wakeConfig: {}, recentMessages: [] });
    return stateCache.get(key);
  });
  const deps = {
    cfg: { socialV2: { tools, send: {} } },
    log: () => {},
    agentTokenOk: () => agentOk,
    v2ToolEnabled: (flag) => tools[flag] !== false,
    getCurrentMode: () => mode,
    modeAllowed: modeAllowedFn,
    socialV2: { paused },
    getSocialV2State: memoState,
    saveSocialV2State: () => { calls.saved += 1; },
    findMessageMedia: (key, messageId) => { calls.findMedia.push([key, messageId]); return []; },
    fetchMediaData: async (media) => { calls.fetchMedia.push(media); return media.map((m) => ({ ...m, ok: true })); },
    shouldBlockSilentReply: () => silent,
    resolveReplyTargetV2: async (st, kind, id, ref) => ref === '777' ? null : { info: { text: '被引用' }, messageId: 'M-' + ref },
    sendMessagesV2: async (key, messages, delays, replyTo, at) => {
      calls.send.push({ key, messages, replyTo, at });
      if (sendError) throw sendError;
      return [{ text: messages[0], seq: 1 }];
    },
    recordSentMessagesV2: (key, msgs) => { calls.record.push([key, msgs]); },
    scheduleReplyCheckV2: (key) => { calls.replyCheck.push(key); },
    appendActivity: (line) => { calls.activity.push(line); }
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 't' }) => {
    body = bodyValue;
    const handled = await handleSendRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, calls };
}

test('authorize/read：空 token 一律拒绝（防免鉴权端点）；无效 token 403；成功 ok', async () => {
  const h = harness();
  const badKey = await h.call('POST', '/api/authorize/read', { key: 'oops', token: 't' });
  assert.equal(badKey.last.status, 400);
  const noToken = await h.call('POST', '/api/authorize/read', { key: 'group:1' }, {});
  assert.equal(noToken.last.status, 403);
  assert.match(noToken.last.obj.error, /缺少会话令牌/);
  const badToken = await harness({ agentOk: false }).call('POST', '/api/authorize/read', { key: 'group:1', token: 'x' });
  assert.equal(badToken.last.status, 403);
  const ok = await h.call('POST', '/api/authorize/read', { key: 'group:1', token: 't' });
  assert.deepEqual(ok.last.obj, { ok: true, key: 'group:1' });
  const deniedMode = await harness({ modeAllowedFn: () => false }).call('POST', '/api/authorize/read', { key: 'group:1', token: 't' });
  assert.equal(deniedMode.last.status, 403);
});

test('images/message：格式/缺参 400；一代模式 403；reserved2 无 token 403；无媒体 note；有媒体走 fetchMediaData', async () => {
  const h = harness();
  const badKey = await h.call('GET', '/api/images/message?key=oops&messageId=1');
  assert.equal(badKey.last.status, 400);
  const noId = await h.call('GET', '/api/images/message?key=group:1');
  assert.equal(noId.last.status, 400);
  const noToken = await h.call('GET', '/api/images/message?key=group:1&messageId=1', {}, {});
  assert.equal(noToken.last.status, 403);
  const gen1 = await harness({ mode: 'chat' }).call('GET', '/api/images/message?key=group:1&messageId=1');
  assert.match(gen1.last.obj.error, /自动内联/);
  const empty = await h.call('GET', '/api/images/message?key=group:1&messageId=1');
  assert.equal(empty.last.obj.media.length, 0);
  assert.match(empty.last.obj.note, /没有可读取/);
  const withMedia = harness();
  withMedia.deps.findMessageMedia = () => [{ url: 'u1' }];
  const ok = await withMedia.call('GET', '/api/images/message?key=group:1&messageId=1');
  assert.equal(ok.last.obj.images[0].ok, true);
});

test('send/group：chat/reserved 403；暂停+token 403；缺目标 400；reserved2 无 token 403；静默 403', async () => {
  const gen1 = await harness({ mode: 'chat' }).call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.match(gen1.last.obj.error, /closed-agent \/ reserved2/);
  const paused = await harness({ paused: true }).call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.match(paused.last.obj.error, /已暂停/);
  const missing = await harness().call('POST', '/api/send/group', { message: 'hi', token: 't' });
  assert.equal(missing.last.status, 400);
  const noToken = await harness().call('POST', '/api/send/group', { groupId: '1', message: 'hi' }, {});
  assert.match(noToken.last.obj.error, /必须携带 agent token/);
  const silent = await harness({ silent: true }).call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.match(silent.last.obj.error, /静默模式/);
});

test('send/reply：缺 replyToMessageId 400；非法 id 400；解析失败 400；成功带 quoted + 排回复检查', async () => {
  const h = harness();
  const noRef = await h.call('POST', '/api/send/reply', { groupId: '1', message: 'hi', token: 't' });
  assert.equal(noRef.last.status, 400);
  const badRef = await h.call('POST', '/api/send/reply', { groupId: '1', message: 'hi', replyToMessageId: 'abc', token: 't' });
  assert.equal(badRef.last.status, 400);
  const unresolvable = await h.call('POST', '/api/send/reply', { groupId: '1', message: 'hi', replyToMessageId: '777', token: 't' });
  assert.equal(unresolvable.last.status, 400);
  assert.match(unresolvable.last.obj.error, /无法解析被引用消息/);
  const ok = await h.call('POST', '/api/send/reply', { groupId: '1', message: 'hi', replyToMessageId: '-5', token: 't' });
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(ok.last.obj.quoted, { text: '被引用' });
  assert.equal(ok.last.obj.sent, 1);
  assert.equal(ok.last.obj.failed, 0);
  assert.equal(h.calls.replyCheck.length, 1, '发送成功 → scheduleReplyCheckV2');
  assert.equal(h.calls.send[0].replyTo, 'M--5', '负数引用 id 被解析为真实 messageId');
  assert.equal(h.calls.saved, 1);
  assert.ok(h.calls.activity.length === 1);
});

test('send/private：私聊 @ 拒绝；JSON 字符串消息被 unquote；超长/敏感词拦截', async () => {
  const h = harness();
  const at = await h.call('POST', '/api/send/private', { userId: '123', message: 'hi', atUserId: 456, token: 't' });
  assert.equal(at.last.status, 400);
  const unquoted = await h.call('POST', '/api/send/private', { userId: '123', message: '"你好"', token: 't' });
  assert.equal(unquoted.last.obj.ok, true);
  assert.deepEqual(h.calls.send[0].messages, ['你好']);
  const tooLong = harness();
  tooLong.deps.cfg.socialV2.send = { maxMessageChars: 5 };
  const long = await tooLong.call('POST', '/api/send/private', { userId: '123', message: 'x'.repeat(6), token: 't' });
  assert.equal(long.last.status, 400);
  const sensitive = await h.call('POST', '/api/send/private', { userId: '123', message: '我的密码是 abc123', token: 't' });
  assert.equal(sensitive.last.status, 403);
  assert.match(sensitive.last.obj.error, /敏感信息/);
});

test('send：频率预占 + 失败回滚额度（错误带 sent 时记录部分成功且不回滚）', async () => {
  const failAll = harness({ sendError: new Error('网关挂了') });
  const st = failAll.deps.getSocialV2State('group:1');
  const r1 = await failAll.call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.equal(r1.last.status, 500);
  assert.equal(st.sendTimes.length, 0, '失败 → 预占额度回滚');
  assert.equal(failAll.calls.record.length, 0);

  const partial = harness({ sendError: Object.assign(new Error('部分失败'), { sent: [{ text: 'hi' }] }) });
  const st2 = partial.deps.getSocialV2State('group:1');
  const r2 = await partial.call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.equal(r2.last.status, 500);
  assert.equal(st2.sendTimes.length, 1, 'sent=1 → 已发的那条占 1 个额度，失败的 0 条回滚');
  assert.equal(partial.calls.record.length, 1, '部分成功的已发消息被记录');

  const rateLimited = harness();
  rateLimited.deps.cfg.socialV2.send = { maxSendPerMinute: 1 };
  const st3 = rateLimited.deps.getSocialV2State('group:1');
  st3.sendTimes.push(Date.now());
  const r3 = await rateLimited.call('POST', '/api/send/group', { groupId: '1', message: 'hi', token: 't' });
  assert.equal(r3.last.status, 429);
  assert.equal(st3.sendTimes.length, 1, '429 路径不重复预占');
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/tool-log')).handled, false);
  assert.equal((await h.call('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: 'x' })).handled, false);
});
