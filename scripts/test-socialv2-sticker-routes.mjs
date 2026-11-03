// socialv2-sticker-routes 的直接路由回归：内存表情库 + stub 媒体管线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2StickerRoutes } from '../src/http/socialv2-sticker-routes.js';

function harness({ stickerOn = true, collectEnabled = true, sendVoiceCfg } = {}) {
  let forcedSync = 0;
  const cfg = {
    socialV2: {
      tools: {},
      send: { maxSendPerMinute: 8, maxSendPerHour: 60 },
      context: { recentLimit: 100 },
      sticker: { enabled: stickerOn, collect: { enabled: collectEnabled, maxPerMinute: 2, maxPerHour: 10 }, maxListCount: 100 }
    }
  };
  const entries = [{ id: 'st-1', desc: '测试表情', localNote: '', tags: [], url: 'https://x.invalid/1', md5: 'MD5' }];
  const states = new Map();
  const sent = [];
  let body = {};
  const stickerSyncCalls = [];
  const deps = {
    cfg,
    root: '/repo',
    log: () => {},    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getCurrentMode: () => 'reserved2',
    modeAllowed: () => true,
    shouldBlockSilentReply: () => false,
    stickerEnabled: () => stickerOn,
    stickerEntries: entries,
    stickerSyncedAt: 123,
    syncStickerLibrary: async (force) => { stickerSyncCalls.push(force); return { entries, syncedAt: 999, fromCache: !force }; },
    safeFetchBuffer: async () => ({ buffer: Buffer.from('png'), finalUrl: 'https://x.invalid/1' }),
    getStickerImageData: async (id) => (id === 'st-1' ? entries[0] : null),
    applyStickerNoteV2: (id, note, tags, usage) => (id === 'st-1' ? { ...entries[0], localNote: note ?? '' } : null),
    setStickerRemarkV2: async (id, remark) => ({ ...entries[0], desc: remark }),
    sendStickerV2: async (key, id) => ({ messageId: 777, entry: entries[0] }),
    collectStickerV2: async (key, ref, remark) => ({ emojiId: 'new-1', remark: remark || '', entry: { ...entries[0], id: 'new-1' } }),
    resolveReplyTargetV2: async () => null,
    getSocialV2State: (key) => {
      if (!states.has(key)) states.set(key, { wakeConfig: { noActionCount: 1 }, unread: [], recentMessages: [], sendTimes: [], stickerCollectTimes: [], preSleepWaitSatisfiedAt: 1, preSleepWaitObservedAt: 1, preSleepWaitAccumMs: 1, lastAiReplyAt: 0, lastActionAt: 0 });
      return states.get(key);
    },
    saveSocialV2State: () => {},
    appendActivity: () => {},
    scheduleReplyCheckV2: () => {},
    mimeFromBuffer: () => 'image/png',
    mimeFromUrl: () => 'image/png',
    getImageDimensions: () => ({ width: 10, height: 10 }),
    toModelMedia: async () => ({ ok: true, mimeType: 'image/png', buffer: Buffer.from('png') }),
    maxMediaBytes: 8 * 1024 * 1024,
    maxMediaPixels: 64_000_000,
    lastForcedAgentStickerSyncGet: () => forcedSync,
    lastForcedAgentStickerSyncSet: (v) => { forcedSync = v; }
  };
  const call = async (method, pathname, bodyValue = {}, headers = { 'x-agent-token': 'tok' }) => {
    body = bodyValue;
    const handled = await handleSocialV2StickerRoutes({
      req: { method, headers }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, deps, states, stickerSyncCalls };
}

test('sticker-image：返回 base64 与元数据；体系关闭 403', async () => {
  const h = harness();
  const ok = await h.call('GET', '/api/socialV2/sticker-image?key=group:456&stickerId=st-1');
  assert.equal(ok.last.obj.ok, true);
  assert.equal(ok.last.obj.sticker.id, 'st-1');
  assert.equal(ok.last.obj.image.mimeType, 'image/png');
  const off = harness({ stickerOn: false });
  assert.equal((await off.call('GET', '/api/socialV2/sticker-image?key=group:456&stickerId=st-1')).last.status, 403);
});

test('sticker-note：更新本地认知；找不到 404', async () => {
  const h = harness();
  const ok = await h.call('POST', '/api/socialV2/sticker-note', { key: 'group:456', stickerId: 'st-1', note: '好图', tags: ['a'] });
  assert.equal(ok.last.obj.sticker.localNote, '好图');
  const missing = await h.call('POST', '/api/socialV2/sticker-note', { key: 'group:456', stickerId: 'nope', note: 'x' });
  assert.equal(missing.last.status, 404);
});

test('send-sticker：caption 禁止；成功落 recentMessages 并清观察标记', async () => {
  const h = harness();
  const caption = await h.call('POST', '/api/socialV2/send-sticker', { key: 'group:456', stickerId: 'st-1', message: '看这个' });
  assert.equal(caption.last.status, 400);
  const ok = await h.call('POST', '/api/socialV2/send-sticker', { key: 'group:456', stickerId: 'st-1' });
  assert.equal(ok.last.obj.sent, 1);
  const st = h.states.get('group:456');
  assert.equal(st.recentMessages[0].sticker.id, 'st-1');
  assert.equal(st.recentMessages[0].isSelf, true);
  assert.equal(st.preSleepWaitSatisfiedAt, 0, '发送后观察标记作废');
  assert.equal(st.wakeConfig.noActionCount, 0);
});

test('collect-sticker：限频预占/回滚；关闭开关 403', async () => {
  const h = harness();
  const ok = await h.call('POST', '/api/socialV2/collect-sticker', { key: 'group:456', messageId: '1', remark: '偷了' });
  assert.equal(ok.last.obj.emojiId, 'new-1');
  assert.equal(h.states.get('group:456').stickerCollectTimes.length, 1, '成功保留预占');
  const off = harness({ collectEnabled: false });
  assert.equal((await off.call('POST', '/api/socialV2/collect-sticker', { key: 'group:456', messageId: '1' })).last.status, 403);
});

test('sticker-list：GET 无 refresh，POST refresh 受 10 秒最小间隔限制', async () => {
  const h = harness();
  const get = await h.call('GET', '/api/socialV2/sticker-list?key=group:456');
  assert.deepEqual(h.stickerSyncCalls, [false], 'GET 不触发强制同步');
  assert.equal(get.last.obj.syncedAt, 999);
  const post1 = await h.call('POST', '/api/socialV2/sticker-list', { key: 'group:456', refresh: true });
  assert.deepEqual(h.stickerSyncCalls, [false, true]);
  const post2 = await h.call('POST', '/api/socialV2/sticker-list', { key: 'group:456', refresh: true });
  assert.deepEqual(h.stickerSyncCalls, [false, true, false], '10 秒内第二次强制刷新被降级为普通同步');
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/socialV2/unread?key=group:456')).handled, false);
});
