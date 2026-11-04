// notify-routes 的直接路由回归：内存 social/state + 记录型 deliverPrompt。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNotifyRoutes } from '../src/http/notify-routes.js';

function harness({ dshReady = true, promptResult = { ok: true }, mode = 'chat' } = {}) {
  const cfg = { ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } };
  const state = { sessions: { 'group:456': 'fixture-session' } };
  const social = { silentTurns: new Map() };
  const prompts = [];
  const activities = [];
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    state,
    modeAllowed: (key, kind, id) => String(id) !== '999',
    getCurrentMode: () => mode,
    allowed: (kind, id) => ['123', '456'].includes(String(id)),
    isDshReady: () => dshReady,
    readRoleState: () => ({ role: '测试卡', mode: 'active' }),
    getSocialV2State: () => ({ agentToken: 'v2-token-abc' }),
    ensureSession: async (key) => `session-for-${key}`,
    social,
    deliverPrompt: async (key, promptText, opts) => { prompts.push({ key, promptText, opts }); return promptResult; },
    appendActivity: (line) => activities.push(line),
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleNotifyRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, prompts, activities, social, state };
}

test('notify-ai 成功投递：静默 turn 登记/清理、prompt 带禁复述约束', async () => {
  const h = harness();
  const result = await h.call('POST', '/api/console/notify-ai', { key: 'group:456', message: '请主动聊聊昨晚话题' });
  assert.equal(result.handled, true);
  assert.equal(result.last.obj.ok, true);
  assert.equal(result.last.obj.sessionId, 'session-for-group:456');
  assert.equal(h.prompts.length, 1);
  const { promptText, opts } = h.prompts[0];
  assert.equal(opts.silent, true);
  // N2：角色/身份/令牌随 persona 载荷进 system（deliverPrompt 内同步），提醒正文不再重复。
  assert.doesNotMatch(promptText, /【当前角色】/, '角色提醒已迁 system，用户消息只放数据');
  assert.match(promptText, /【后台控制端提醒】/);
  assert.match(promptText, /绝对不要复述/);
  assert.match(promptText, /如果不需要在群里发言，请不要输出会发到 QQ 的内容/);
  assert.equal(h.social.silentTurns.size, 1, '成功投递后静默登记保留，回合结束由 collector 清理');
  assert.equal(h.activities.length, 1);
});

test('二代模式令牌随 system 注入，提醒不带一代禁发措辞', async () => {
  const h = harness({ mode: 'reserved2' });
  const result = await h.call('POST', '/api/console/notify-ai', { key: 'group:456', message: '提醒' });
  assert.equal(result.last.obj.ok, true);
  const { promptText } = h.prompts[0];
  assert.doesNotMatch(promptText, /【会话令牌】/, '令牌随 persona 载荷进 system，不再随用户消息重发');
  assert.match(promptText, /qq_send_message \/ qq_reply/);
  assert.ok(!promptText.includes('请不要输出会发到 QQ 的内容'));
});

test('校验链：缺字段 400 / 坏 key 400 / 模式拒绝 403 / 白名单拒绝 403 / DSH 不可用 503', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '/api/console/notify-ai', { key: '', message: 'x' })).last.status, 400);
  assert.equal((await h.call('POST', '/api/console/notify-ai', { key: 'evil', message: 'x' })).last.status, 400);
  assert.equal((await h.call('POST', '/api/console/notify-ai', { key: 'group:999', message: 'x' })).last.status, 403);

  const h2 = harness();
  h2.state.sessions = {}; // 未创建且不在白名单
  assert.equal((await h2.call('POST', '/api/console/notify-ai', { key: 'private:777', message: 'x' })).last.status, 403);

  const h3 = harness({ dshReady: false });
  assert.equal((await h3.call('POST', '/api/console/notify-ai', { key: 'group:456', message: 'x' })).last.status, 503);
});

test('投递失败回滚静默登记并回 500', async () => {
  const h = harness({ promptResult: { ok: false, error: 'boom' } });
  const result = await h.call('POST', '/api/console/notify-ai', { key: 'group:456', message: 'x' });
  assert.equal(result.last.status, 500);
  assert.match(result.last.obj.error, /boom/);
  assert.equal(h.social.silentTurns.size, 0, '失败路径不得残留静默登记');
  assert.equal(h.activities.length, 0);
});

test('ensureSession 抛错时回 500 且清理静默登记', async () => {
  const sent = [];
  const social = { silentTurns: new Map() };
  const handled = await handleNotifyRoutes({
    req: { method: 'POST' }, url: new URL('http://127.0.0.1/api/console/notify-ai'),
    sendJson: (obj, status = 200) => sent.push({ obj, status }),
    readBody: async () => ({ key: 'group:456', message: 'x' }),
    deps: {
      cfg: {}, state: { sessions: { 'group:456': 's' } },
      modeAllowed: () => true, getCurrentMode: () => 'chat', allowed: () => true,
      isDshReady: () => true, readRoleState: () => ({ role: null }),
      getSocialV2State: () => ({ agentToken: 't' }),
      ensureSession: async () => { throw new Error('dsh exploded'); },
      social, deliverPrompt: async () => ({ ok: true }), appendActivity: () => {}, log: () => {}
    }
  });
  assert.equal(handled, true);
  assert.equal(sent[0].status, 500);
  assert.equal(social.silentTurns.size, 0);
});

test('非本组路由返回 false', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '/api/status')).handled, false);
});
