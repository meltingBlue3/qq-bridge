// role-routes 的直接路由回归：临时 roles/ 与 config.json，不启动 HTTP server。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRoleRoutes } from '../src/http/role-routes.js';
import { createRoleStore } from '../src/roles.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-routes-'));
  const rolesDir = path.join(root, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ role: { maxInjectChars: 2000 } }), 'utf8');
  return { root, rolesDir };
}

function harness(root, rolesDir, { maxInjectChars = 2000 } = {}) {
  const store = createRoleStore({ rolesDir, getInjectLimit: () => maxInjectChars });
  let roleState = { role: null, mode: 'active' };
  const sent = [];
  let body = {};
  const deps = {
    roleSummaries: store.roleSummaries,
    roleFilePath: store.roleFilePath,
    validateRoleName: store.validateRoleName,
    validateRoleContent: store.validateRoleContent,
    readRoleContent: store.readRoleContent,
    writeRoleContent: store.writeRoleContent,
    roleWarnings: store.roleWarnings,
    readRoleState: () => roleState,
    writeRoleState: (role, mode) => { roleState = { role, mode }; },
    getRoleInjectMaxChars: () => maxInjectChars,
    setRoleInjectMaxChars: (value) => { maxInjectChars = value; },
    root,
    cfg: { role: { maxInjectChars } },
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const req = { method };
    const url = new URL(`http://127.0.0.1${pathname}`);
    const handled = await handleRoleRoutes({ req, url, sendJson: (obj, status = 200) => sent.push({ obj, status }), readBody: async () => body, deps });
    return { handled, last: sent.at(-1) };
  };
  return { call, sent, getRoleState: () => roleState, getMax: () => maxInjectChars, store };
}

test('非人格路由返回 false，不消费请求', async () => {
  const { root, rolesDir } = fixture();
  const h = harness(root, rolesDir);
  const result = await h.call('GET', '/api/status');
  assert.equal(result.handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('GET /api/roles 返回 roles/summaries/current/limits', async () => {
  const { root, rolesDir } = fixture();
  fs.writeFileSync(path.join(rolesDir, '测试.md'), '# 测试\n正文', 'utf8');
  const h = harness(root, rolesDir);
  const result = await h.call('GET', '/api/roles');
  assert.equal(result.handled, true);
  assert.deepEqual(result.last.obj.roles, ['测试']);
  assert.equal(result.last.obj.summaries[0].name, '测试');
  assert.equal(result.last.obj.limits.nameMax, 40);
  fs.rmSync(root, { recursive: true, force: true });
});

test('create / update / rename / delete 全链路', async () => {
  const { root, rolesDir } = fixture();
  const h = harness(root, rolesDir);
  let result = await h.call('POST', '/api/roles/create', { name: '傲娇', content: '# 傲娇\n哼' });
  assert.equal(result.last.obj.ok, true);
  assert.equal(fs.existsSync(path.join(rolesDir, '傲娇.md')), true);

  result = await h.call('POST', '/api/roles/update', { name: '傲娇', content: '# 傲娇\n哼！' });
  assert.equal(result.last.obj.chars, 7);
  assert.match(fs.readFileSync(path.join(rolesDir, '傲娇.md'), 'utf8'), /哼！/);

  result = await h.call('POST', '/api/roles/rename', { from: '傲娇', to: '新傲娇' });
  assert.equal(result.last.obj.renamed, true);
  assert.equal(fs.existsSync(path.join(rolesDir, '新傲娇.md')), true);

  result = await h.call('POST', '/api/roles/delete', { name: '新傲娇' });
  assert.equal(result.last.obj.deleted, '新傲娇');
  assert.equal(fs.existsSync(path.join(rolesDir, '新傲娇.md')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('GET /api/roles/content 返回 stats 与两种模式的小节报告', async () => {
  const { root, rolesDir } = fixture();
  fs.writeFileSync(path.join(rolesDir, '卡.md'), '# 卡\n普通\n## 只给一代 〔一代〕\n[SILENT]', 'utf8');
  const h = harness(root, rolesDir);
  const result = await h.call('GET', '/api/roles/content?name=卡');
  assert.equal(result.last.obj.ok, true);
  assert.ok(result.last.obj.stats);
  assert.ok(result.last.obj.sections.v1 && result.last.obj.sections.v2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/roles/limit 写 config.json 并更新注入上限', async () => {
  const { root, rolesDir } = fixture();
  const h = harness(root, rolesDir);
  const result = await h.call('POST', '/api/roles/limit', { maxInjectChars: 99999 });
  assert.equal(result.last.obj.ok, true);
  assert.equal(result.last.obj.maxInjectChars, 20000);
  assert.equal(h.getMax(), 20000);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.role.maxInjectChars, 20000);
  fs.rmSync(root, { recursive: true, force: true });
});
