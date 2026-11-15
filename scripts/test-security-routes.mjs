// security-routes 的直接路由回归：临时 config.json/state 目录，不启动 HTTP server。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSecurityRoutes } from '../src/http/security-routes.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-security-routes-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ security: { interceptNotify: true } }), 'utf8');
  return { root, stateDir };
}

function harness(root, stateDir) {
  const cfg = { security: { interceptNotify: true } };
  let hardened = true;
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    stateDir,
    getStateDirHardened: () => hardened,
    setStateDirHardened: (v) => { hardened = v; },
    hardenStateDirAcl: () => { hardened = true; },
    root,
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleSecurityRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, cfg, isHardened: () => hardened };
}

test('GET /api/security 返回安全设置与 stateDir ACL 状态', async () => {
  const { root, stateDir } = fixture();
  const h = harness(root, stateDir);
  const result = await h.call('GET', '/api/security');
  assert.equal(result.handled, true);
  assert.equal(result.last.obj.security.interceptNotify, true);
  assert.equal(result.last.obj.stateDir.hardened, true);
  assert.ok(result.last.obj.stateDir.manualCommand);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/security 更新设置并写回 config.json', async () => {
  const { root, stateDir } = fixture();
  const h = harness(root, stateDir);
  const result = await h.call('POST', '/api/security', { interceptNotify: false });
  assert.equal(result.last.obj.ok, true);
  assert.equal(h.cfg.security.interceptNotify, false);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(file.security.interceptNotify, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/security rehardenStateDir 会重跑 ACL 收紧', async () => {
  const { root, stateDir } = fixture();
  const h = harness(root, stateDir);
  const result = await h.call('POST', '/api/security', { rehardenStateDir: true });
  // harness 里 hardenStateDirAcl 把 hardened 置回 true
  assert.equal(result.last.obj.hardened, true);
  assert.equal(h.isHardened(), true);
  fs.rmSync(root, { recursive: true, force: true });
});


test('非本组路由返回 false', async () => {
  const { root, stateDir } = fixture();
  const h = harness(root, stateDir);
  assert.equal((await h.call('GET', '/api/status')).handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});
