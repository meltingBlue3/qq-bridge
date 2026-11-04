// socialv2-read-routes 的直接路由回归：message-detail / forward-message / forward-media /
// active-members / group-members。I/O（botRaw/botRequest/onebotHttpAction/fetchMediaData/
// resolveReplyInfo）全部注入 stub。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2ReadRoutes } from '../src/http/socialv2-read-routes.js';
import { createForwardMediaRegistry } from '../src/social-v2/forward-media-registry.js';

const truncate = (s, max) => String(s ?? '').slice(0, max);

function harness({ mode = 'reserved2', agentOk = true, tools = {}, allowedFn = () => true, modeAllowedFn = () => true } = {}) {
  const sent = [];
  let body = {};
  const calls = { botRaw: [], botRequest: [], http: [], fetchMedia: [], resolveReply: [] };
  const registry = createForwardMediaRegistry();
  const seenForwardIds = new Map([['group:456', new Set(['fw-seen'])]]);
  const deps = {
    cfg: { socialV2: { tools } },
    log: () => {},
    agentTokenOk: () => agentOk,
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => tools[flag] !== false,
    getCurrentMode: () => mode,
    modeAllowed: modeAllowedFn,
    allowed: allowedFn,
    getSocialV2State: (key) => {
      if (key === 'group:456') {
        return {
          recentMessages: [
            { seq: 10, messageId: 'M-10', sender: '小明', text: '早'.repeat(200), userId: '111', forwardIds: ['fw-1'], hasForward: true },
            { seq: 11, sender: '小红', text: '在吗', userId: '222', isOwner: false, time: 5 },
            { seq: 12, sender: '小明', text: '好的', userId: '111', isOwner: true, time: 9 },
            { isSelf: true, text: '我说', userId: 'me', time: 10 }
          ],
          unread: []
        };
      }
      return { recentMessages: [], unread: [] };
    },
    resolveReplyInfo: async (...args) => { calls.resolveReply.push(args); return { sender: '网关', text: '远端消息', userId: '999' }; },
    seenForwardIds,
    botRaw: async (action, params) => { calls.botRaw.push(params); return { echo: params }; },
    botRequest: async (action, params) => { calls.botRequest.push(params); return { data: [{ user_id: 1, nickname: '甲', card: 'A', role: 'admin' }, { user_id: 2, nickname: '乙', card: '' }] }; },
    onebotHttpAction: async (action, params) => { calls.http.push(params); return { data: [{ user_id: 7, nickname: '兜底' }] }; },
    fetchMediaData: async (media) => { calls.fetchMedia.push(media); return media.map((m) => ({ ...m, fetched: true })); },
    formatForwardResponse: (data, opts) => ({ opts, messages: [{ nestedForwardIds: ['fw-nest-1'] }, { nestedForwardIds: [] }] }),
    truncateText: truncate,
    rememberForwardMediaV2: (key, media) => registry.remember(key, media),
    filterForwardMediaV2: (key, media) => {
      const st = deps.getSocialV2State(key);
      return registry.filter(key, media, [st?.recentMessages, st?.unread]);
    }
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 't' }) => {
    body = bodyValue;
    const handled = await handleSocialV2ReadRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, seenForwardIds, calls };
}

test('message-detail：缺参/格式 400；本地 seq 命中优先展示真实 messageId + 转发字段 + 截断标记', async () => {
  const h = harness();
  const missing = await h.call('GET', '/api/socialV2/message-detail?key=group:456');
  assert.equal(missing.last.status, 400);
  const badKey = await h.call('GET', '/api/socialV2/message-detail?key=oops&messageId=1');
  assert.equal(badKey.last.status, 400);
  const ok = await h.call('GET', '/api/socialV2/message-detail?key=group:456&messageId=10');
  assert.equal(ok.last.obj.ok, true);
  assert.equal(ok.last.obj.info.messageId, 'M-10', '本地 seq 命中且存有真实 id → 优先按 seq 展示真实 id');
  assert.equal(ok.last.obj.info.seq, 10);
  assert.deepEqual(ok.last.obj.info.forwardIds, ['fw-1']);
  assert.equal(ok.last.obj.info.hasForward, true);
  assert.equal(ok.last.obj.info.textTruncated, true, '200 字预览 → textTruncated=true');
});

test('message-detail：本地未命中走 resolveReplyInfo；resolve 抛错 500', async () => {
  const h = harness();
  const remote = await h.call('GET', '/api/socialV2/message-detail?key=group:456&messageId=999');
  assert.equal(remote.last.obj.info.sender, '网关');
  assert.deepEqual(h.calls.resolveReply[0], ['group', 456, '999']);
  const boom = harness({ });
  boom.deps.resolveReplyInfo = async () => { throw new Error('gw down'); };
  const r = await boom.call('GET', '/api/socialV2/message-detail?key=group:456&messageId=999');
  assert.equal(r.last.status, 500);
});

test('forward-message：模式/令牌/白名单/工具闸门 + 只允许本会话见过的 id（404）', async () => {
  const wrongMode = await harness({ mode: 'active' }).call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen');
  assert.equal(wrongMode.last.status, 403);
  assert.match(wrongMode.last.obj.error, /reserved2/);
  const noToken = await harness().call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen', {}, {});
  assert.equal(noToken.last.status, 403);
  const badToken = await harness({ agentOk: false }).call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen');
  assert.equal(badToken.last.status, 403);
  const denied = await harness({ modeAllowedFn: () => false }).call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen');
  assert.equal(denied.last.status, 403);
  const disabled = await harness({ tools: { getForwardMsg: false } }).call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen');
  assert.equal(disabled.last.status, 403);
  const unknown = await harness().call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-other');
  assert.equal(unknown.last.status, 404);
});

test('forward-message：命中后读取 + 嵌套预览 + nested id 登记为已见过（含 1000 上限淘汰）', async () => {
  const h = harness();
  const ok = await h.call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-seen');
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(ok.last.obj.nestedPreviews[0].id, 'fw-nest-1');
  assert.equal(h.calls.botRaw.length, 2, '主转发 + 1 个嵌套预览');
  const set = h.seenForwardIds.get('group:456');
  assert.ok(set.has('fw-nest-1'), '嵌套 id 已登记');
  // 1000 上限淘汰
  for (let i = 0; i < 1005; i++) set.add(`pad-${i}`);
  await h.call('GET', '/api/socialV2/forward-message?key=group:456&id=fw-nest-1');
  assert.ok(set.size <= 1001, `上限淘汰生效（当前 ${set.size}）`);
});

test('forward-media：缺 key 400；非 reserved2 403；空 media 直接返回空；成功走 fetchMediaData', async () => {
  const h = harness();
  const noKey = await h.call('POST', '/api/socialV2/forward-media', { media: [] });
  assert.equal(noKey.last.status, 400);
  const wrongMode = await harness({ mode: 'active' }).call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [{ url: 'x' }] });
  assert.equal(wrongMode.last.status, 403);
  const empty = await h.call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [] });
  assert.deepEqual(empty.last.obj.images, []);
  // 旧断言时代 media 照单全收；现在未登记的 url 必须被拒——u1 先登记才放行
  const ok = await h.call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [{ url: 'u1' }] });
  assert.equal(ok.last.status, 403, '未登记的媒体不得抓取（防凭空编 URL）');
  h.deps.rememberForwardMediaV2('group:456', [{ url: 'u1' }]);
  const ok2 = await h.call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [{ url: 'u1' }] });
  assert.equal(ok2.last.status, 200);
  assert.equal(ok2.last.obj.images[0].fetched, true);
  assert.ok(h.calls.fetchMedia.length === 1);
});

test('forward-media：登记后只抓已见过的；混合请求带 deniedCount 备注；全未见过 403', async () => {
  const h = harness();
  h.deps.rememberForwardMediaV2('group:456', [{ url: 'seen-1' }]);
  const mixed = await h.call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [{ url: 'seen-1' }, { url: 'fabricated.example/x' }] });
  assert.equal(mixed.last.status, 200);
  assert.deepEqual(h.calls.fetchMedia.at(-1), [{ url: 'seen-1' }], '只抓登记过的那条');
  assert.equal(mixed.last.obj.deniedCount, 1);
  assert.match(mixed.last.obj.note, /1 条媒体不在本会话已见范围内/);
  const allDenied = await h.call('POST', '/api/socialV2/forward-media', { key: 'group:456', media: [{ url: 'nope-1' }] });
  assert.equal(allDenied.last.status, 403);
  assert.match(allDenied.last.obj.error, /不在本会话已见范围内/);
});

test('active-members：聚合 count/lastTime/isOwner，排除自己，按 count 排序 + limit', async () => {
  const h = harness();
  const ok = await h.call('GET', '/api/socialV2/active-members?key=group:456&limit=1');
  const m = ok.last.obj.members;
  assert.equal(m.length, 1);
  assert.equal(m[0].userId, '111', '小明 2 条 → 排第一');
  assert.equal(m[0].count, 2);
  assert.equal(m[0].lastTime, 9);
  assert.equal(m[0].isOwner, true);
  const noKey = await harness().call('GET', '/api/socialV2/active-members');
  assert.equal(noKey.last.status, 400);
});

test('group-members：仅 group: key；closed-agent 走 allowed 白名单；reserved2 走 v2SessionAllowed；WS 失败走 HTTP 兜底', async () => {
  const h = harness({ mode: 'closed-agent', allowedFn: () => false });
  const denied = await h.call('GET', '/api/socialV2/group-members?key=group:456');
  assert.equal(denied.last.status, 403);
  const badKind = await harness({ mode: 'closed-agent', allowedFn: () => true }).call('GET', '/api/socialV2/group-members?key=private:123');
  assert.equal(badKind.last.status, 400);
  const h2 = harness({ mode: 'closed-agent', allowedFn: () => true });
  h2.deps.botRequest = async () => { throw new Error('ws down'); };
  const fallback = await h2.call('GET', '/api/socialV2/group-members?key=group:456');
  assert.equal(fallback.last.obj.ok, true);
  assert.equal(h2.calls.http.length, 1, 'WS 挂了走 onebotHttpAction 兜底');
  assert.deepEqual(fallback.last.obj.members, [{ userId: '7', nickname: '兜底', card: '' }]);
  const h3 = harness();
  const ok = await h3.call('GET', '/api/socialV2/group-members?key=group:456');
  assert.equal(ok.last.obj.count, 2);
  assert.equal(ok.last.obj.returned, 2);
  assert.equal(ok.last.obj.members[0].role, 'admin');
  const badPayload = harness();
  badPayload.deps.botRequest = async () => ({ data: 'not-a-list' });
  const bad = await badPayload.call('GET', '/api/socialV2/group-members?key=group:456');
  assert.equal(bad.last.status, 502);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/memory?key=group:456')).handled, false);
  assert.equal((await h.call('GET', '/api/socialV2/tool-log')).handled, false);
});
