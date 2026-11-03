// dsh-routes 的直接路由回归：假 catalog / 临时 config.json，不启动 HTTP、不连 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleDshRoutes } from '../src/http/dsh-routes.js';

function fixture(cfgOverride = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-routes-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    dsh: { provider: 'p1', model: 'm1', reasoningEffort: 'high', ...cfgOverride }
  }), 'utf8');
  return root;
}

function harness(root) {
  const cfg = JSON.parse(JSON.stringify({ dsh: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }));
  let inFlight = null;
  let epoch = 0;
  const catalogErrorsLogged = new Set();
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    fetchModelCatalog: async () => ({ result: { ok: true, value: {
      groups: [{ id: 'p1', models: [{ id: 'm1', reasoning: { efforts: [
        { id: 'low', name: '低', description: 'd-low' },
        { id: 'max', name: '最高', description: 'd-max' },
        { id: 'bogus', name: 'bogus', description: '' }
      ], defaultEffort: 'low' } }] }]
    } } }),
    withTimeout: (p) => p,
    getCatalogInFlight: () => inFlight,
    setCatalogInFlight: (v) => { inFlight = v; },
    catalogErrorsLogged,
    bumpModelSelectionEpoch: () => { epoch += 1; },
    root,
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleDshRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, cfg, getEpoch: () => epoch, errorsLogged: catalogErrorsLogged };
}

test('GET /api/dsh/model 只返回 DSH 公布的合法档位并带目录来源', async () => {
  const root = fixture();
  const h = harness(root);
  const result = await h.call('GET', '/api/dsh/model');
  assert.equal(result.handled, true);
  assert.deepEqual(result.last.obj.options, ['low', 'max'], 'bogus 档位必须被内置白名单过滤');
  assert.equal(result.last.obj.catalogSource, 'dsh');
  assert.equal(result.last.obj.default, 'max');
  assert.equal(result.last.obj.providerDefault, 'low');
  assert.equal(result.last.obj.globalSideEffect, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('catalog 失败时退回内置档位，同一错误只记一次日志', async () => {
  const root = fixture();
  const sent = [];
  const cfg = { dsh: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } };
  const errors = new Set();
  let inFlight = null;
  let calls = 0;
  const deps = {
    cfg,
    fetchModelCatalog: async () => { calls += 1; throw new Error('dsh down'); },
    withTimeout: (p) => p,
    getCatalogInFlight: () => inFlight,
    setCatalogInFlight: (v) => { inFlight = v; },
    catalogErrorsLogged: errors,
    bumpModelSelectionEpoch: () => {},
    root,
    log: () => {}
  };
  for (let i = 0; i < 3; i++) {
    inFlight = null; // 每次刷新都重建在途请求
    await handleDshRoutes({
      req: { method: 'GET' }, url: new URL('http://127.0.0.1/api/dsh/model'),
      sendJson: (obj) => sent.push(obj), readBody: async () => ({}), deps
    });
  }
  assert.equal(sent[0].catalogSource, 'fallback');
  assert.deepEqual(sent[0].options, ['low', 'high', 'max']);
  assert.equal(errors.size, 1, '同一错误原因只记一次');
  assert.equal(calls, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/dsh/effort 写 config + 内存 + 递增代号；非法值 400', async () => {
  const root = fixture();
  const h = harness(root);
  const ok = await h.call('POST', '/api/dsh/effort', { reasoningEffort: 'low' });
  assert.equal(ok.last.obj.ok, true);
  assert.equal(h.cfg.dsh.reasoningEffort, 'low');
  assert.equal(h.getEpoch(), 1);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(file.dsh.reasoningEffort, 'low');

  const bad = await h.call('POST', '/api/dsh/effort', { reasoningEffort: 'ultra' });
  assert.equal(bad.last.status, 400);
  assert.equal(h.getEpoch(), 1, '非法值不得递增代号');
  fs.rmSync(root, { recursive: true, force: true });
});

test('非本组路由返回 false', async () => {
  const root = fixture();
  const h = harness(root);
  assert.equal((await h.call('GET', '/api/status')).handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});
