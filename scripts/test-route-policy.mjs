// 路由授权策略的纯函数回归：不启动 HTTP、不读真实配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ONLY_V2_PATHS,
  authorizeAgentRequest,
  isAgentTokenAllowedPath,
  isTokenlessAgentAllowedPath,
  readonlyStoreForPath
} from '../src/route-policy.js';

const TOKEN = 'live-agent-token';
const base = {
  isLiveAgentToken: (token) => token === TOKEN,
  mode: 'reserved2'
};

test('agent token 白名单只放行 status / authorize / v2 / send / images', () => {
  for (const path of ['/api/status', '/api/authorize/read', '/api/socialV2/prompt',
    '/api/send/group', '/api/images/message']) {
    assert.equal(isAgentTokenAllowedPath(path), true, path);
  }
  for (const path of ['/api/restart', '/api/roles', '/api/preset/sim-prompt', '/api/stickers']) {
    assert.equal(isAgentTokenAllowedPath(path), false, path);
  }
});

test('无令牌 agent 调用只能走 status / send / images', () => {
  for (const path of ['/api/status', '/api/send/group', '/api/images/message']) {
    assert.equal(isTokenlessAgentAllowedPath(path), true, path);
  }
  for (const path of ['/api/socialV2/prompt', '/api/socialV2/send-message', '/api/roles']) {
    assert.equal(isTokenlessAgentAllowedPath(path), false, path);
  }
});

test('只读降级映射覆盖黑话库与表情库写接口', () => {
  assert.equal(readonlyStoreForPath('/api/slang', 'POST'), '黑话库');
  assert.equal(readonlyStoreForPath('/api/slang/batch-delete', 'POST'), '黑话库');
  assert.equal(readonlyStoreForPath('/api/socialV2/slang/submit', 'POST'), '黑话库');
  assert.equal(readonlyStoreForPath('/api/stickers/note', 'POST'), '表情库');
  assert.equal(readonlyStoreForPath('/api/socialV2/collect-sticker', 'POST'), '表情库');
  assert.equal(readonlyStoreForPath('/api/slang', 'GET'), '');
  assert.equal(readonlyStoreForPath('/api/status', 'POST'), '');
});

test('管理端请求（无 agent token）一律放行到业务层', () => {
  for (const path of ['/api/restart', '/api/roles', '/api/socialV2/config', '/api/stickers/note']) {
    assert.deepEqual(authorizeAgentRequest({ ...base, method: 'POST', pathname: path }), {
      ok: true, actor: 'console'
    });
  }
});

test('有效 agent token 只能访问白名单路由', () => {
  const ok = authorizeAgentRequest({ ...base, pathname: '/api/socialV2/prompt', headers: { 'x-agent-token': TOKEN } });
  assert.deepEqual(ok, { ok: true, actor: 'agent' });
  const denied = authorizeAgentRequest({ ...base, pathname: '/api/restart', headers: { 'x-agent-token': TOKEN } });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
});

test('agent 调用带无效令牌必须拒绝', () => {
  const result = authorizeAgentRequest({
    ...base,
    pathname: '/api/send/group',
    headers: { 'x-agent-call': '1', 'x-agent-token': 'wrong' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /令牌无效/);
});

test('agent 调用不带令牌只能走窄面', () => {
  const allowed = authorizeAgentRequest({
    ...base, pathname: '/api/send/group', headers: { 'x-agent-call': '1' }
  });
  assert.deepEqual(allowed, { ok: true, actor: 'tokenless-agent' });
  for (const path of ['/api/socialV2/prompt', '/api/socialV2/feedback']) {
    const denied = authorizeAgentRequest({ ...base, pathname: path, headers: { 'x-agent-call': '1' } });
    assert.equal(denied.ok, false, path);
    assert.equal(denied.status, 403);
  }
});

test('空 agent token 永远拒绝（不能被当成管理端）', () => {
  const result = authorizeAgentRequest({ ...base, pathname: '/api/status', headers: { 'x-agent-token': '' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /不能为空/);
});

test('暂停 / 关闭 / 模式隔离对所有 v2 写面生效', () => {
  const paths = ['/api/socialV2/send-message', '/api/send/group', '/api/images/message'];
  for (const path of paths) {
    const paused = authorizeAgentRequest({
      ...base, pathname: path, headers: { 'x-agent-token': TOKEN }, socialV2Paused: true
    });
    assert.equal(paused.ok, false, `paused ${path}`);
    assert.equal(paused.status, 403);

    const disabled = authorizeAgentRequest({
      ...base, pathname: path, headers: { 'x-agent-token': TOKEN }, socialV2Enabled: false
    });
    assert.equal(disabled.ok, false, `disabled ${path}`);
    assert.equal(disabled.status, 403);
  }
  const wrongMode = authorizeAgentRequest({
    ...base, pathname: '/api/socialV2/prompt', headers: { 'x-agent-token': TOKEN }, mode: 'chat'
  });
  assert.equal(wrongMode.ok, false);
  assert.match(wrongMode.error, /reserved2/);
});

test('管理端专用 v2 接口与表情库管理接口拒绝 agent token', () => {
  for (const path of ADMIN_ONLY_V2_PATHS) {
    const result = authorizeAgentRequest({ ...base, pathname: path, headers: { 'x-agent-token': TOKEN } });
    assert.equal(result.ok, false, path);
    assert.equal(result.status, 403);
  }
  for (const path of ['/api/socialV2/feedback', '/api/socialV2/tool-log']) {
    const result = authorizeAgentRequest({ ...base, method: 'GET', pathname: path, headers: { 'x-agent-token': TOKEN } });
    assert.equal(result.ok, false, `GET ${path}`);
  }
  for (const path of ['/api/stickers', '/api/stickers/note']) {
    const result = authorizeAgentRequest({ ...base, method: 'POST', pathname: path, headers: { 'x-agent-token': TOKEN } });
    assert.equal(result.ok, false, path);
  }
});

test('存储只读降级只阻断控制台写接口，且读接口不受影响', () => {
  const write = authorizeAgentRequest({
    ...base, method: 'POST', pathname: '/api/slang', slangStoreWritable: false
  });
  assert.equal(write.ok, false);
  assert.equal(write.status, 503);
  assert.match(write.error, /黑话库/);

  const read = authorizeAgentRequest({
    ...base, method: 'GET', pathname: '/api/slang', slangStoreWritable: false
  });
  assert.equal(read.ok, true);

  // agent token 本来就不允许访问黑话库管理接口：必须先命中 403，而不是泄露存储状态。
  const agent = authorizeAgentRequest({
    ...base, method: 'POST', pathname: '/api/slang', headers: { 'x-agent-token': TOKEN }, slangStoreWritable: false
  });
  assert.equal(agent.ok, false);
  assert.equal(agent.status, 403);
  const sticker = authorizeAgentRequest({
    ...base, method: 'POST', pathname: '/api/stickers/note', stickerStoreWritable: false
  });
  assert.equal(sticker.ok, false);
  assert.equal(sticker.status, 503);
  assert.match(sticker.error, /表情库/);
});
