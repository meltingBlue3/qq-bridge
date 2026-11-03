// access-routes 的直接路由回归：临时 config.json + 记录型 bot，不启动 HTTP、不发真消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAccessRoutes } from '../src/http/access-routes.js';

function fixture(cfgOverride = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-access-routes-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    allow: { private: ['123'], groups: ['456'] },
    deny: { private: [], groups: [] },
    ownerQQ: 123,
    ...cfgOverride
  }), 'utf8');
  return root;
}

function harness(root, { mode = 'chat', botError = null } = {}) {
  const cfg = JSON.parse(JSON.stringify({
    allow: { private: ['123'], groups: ['456'] },
    deny: { private: [], groups: [] },
    ownerQQ: 123
  }));
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    root,
    reconcileSessionPolicies: () => {},
    allowed: (kind, id, c) => String(c?.allow?.[kind === 'private' ? 'private' : 'groups'] ?? '').split(',').includes(String(id)),
    modeAllowed: () => mode !== 'silent-blocked',
    getCurrentMode: () => mode,
    redactKnownTokensOnly: (t) => t,
    escapeCqText: (t) => t,
    bot: {
      sendPrivateMessage: async () => { if (botError) throw new Error(botError); return { message_id: 9001 }; },
      sendGroupMessage: async () => { if (botError) throw new Error(botError); return { message_id: 9002 }; }
    },
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleAccessRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, cfg };
}

test('GET /api/whitelist 返回 allow/deny/ownerQQ', async () => {
  const root = fixture();
  const h = harness(root);
  const result = await h.call('GET', '/api/whitelist');
  assert.equal(result.handled, true);
  assert.deepEqual(result.last.obj.allow, { private: ['123'], groups: ['456'] });
  assert.equal(result.last.obj.ownerQQ, 123);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/whitelist 写 config + 热更新内存；非法 ownerQQ 拒绝且不写', async () => {
  const root = fixture();
  const h = harness(root);
  const ok = await h.call('POST', '/api/whitelist', { allow: { private: ['999'], groups: ['777'] } });
  assert.equal(ok.last.obj.ok, true);
  assert.deepEqual(h.cfg.allow, { private: [999], groups: [777] });
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(file.allow.groups, [777]);

  const bad = await h.call('POST', '/api/whitelist', { ownerQQ: 'not-a-number' });
  assert.equal(bad.last.status, 400);
  assert.equal(h.cfg.ownerQQ, 123, '非法 ownerQQ 不得改内存');
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/test-send 走白名单与模式闸门', async () => {
  const root = fixture();
  const h = harness(root);
  const ok = await h.call('POST', '/api/test-send', { kind: 'group', id: '456', message: 'hello' });
  assert.equal(ok.last.obj.ok, true);
  assert.equal(ok.last.obj.message_id, 9002);

  const outOfList = await h.call('POST', '/api/test-send', { kind: 'group', id: '999', message: 'hello' });
  assert.equal(outOfList.last.status, 403);

  const sensitive = await h.call('POST', '/api/test-send', { kind: 'group', id: '456', message: 'api_key = "sk-abc"' });
  assert.equal(sensitive.last.status, 403);
  fs.rmSync(root, { recursive: true, force: true });
});

test('发送失败回 500 且错误可读', async () => {
  const root = fixture();
  const h = harness(root, { botError: 'gateway down' });
  const result = await h.call('POST', '/api/test-send', { kind: 'private', id: '123', message: 'hi' });
  assert.equal(result.last.status, 500);
  assert.match(result.last.obj.error, /gateway down/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('非本组路由返回 false', async () => {
  const root = fixture();
  const h = harness(root);
  assert.equal((await h.call('GET', '/api/status')).handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});
