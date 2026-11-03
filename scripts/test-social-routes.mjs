// social-routes（一代仿真控制台）的直接路由回归：临时 config.json + 内存 social 状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSocialRoutes } from '../src/http/social-routes.js';

function fixture(cfgSocial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-social-routes-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ social: cfgSocial }), 'utf8');
  return root;
}

function harness(root) {
  const cfg = { social: { enabled: true, maxReplyChars: 500 } };
  const social = {
    pendingSummaries: new Map([['group:456', { items: [1, 2] }]]),
    states: new Map([['group:456', { phase: 'active' }]]),
    recentMessages: new Map([['group:789', []]])
  };
  const flushed = [];
  const phases = [];
  const sent = [];
  let body = {};
  const deps = {
    cfg,
    root,
    social,
    enterActive: (key) => phases.push(['active', key]),
    leaveActive: (key) => phases.push(['idle', key]),
    flushSummaries: async (key) => { flushed.push(key); },
    log: () => {}
  };
  const call = async (method, pathname, bodyValue = {}) => {
    body = bodyValue;
    const handled = await handleSocialRoutes({
      req: { method }, url: new URL(`http://127.0.0.1${pathname}`),
      sendJson: (obj, status = 200) => sent.push({ obj, status }),
      readBody: async () => body,
      deps
    });
    return { handled, last: sent.at(-1) };
  };
  return { call, cfg, social, flushed, phases };
}

test('POST /api/social/state 只接受 active/idle', async () => {
  const root = fixture();
  const h = harness(root);
  const active = await h.call('POST', '/api/social/state', { key: 'group:456', phase: 'active' });
  assert.equal(active.last.obj.phase, 'active');
  assert.deepEqual(h.phases[0], ['active', 'group:456']);
  const bad = await h.call('POST', '/api/social/state', { key: 'group:456', phase: 'zzz' });
  assert.equal(bad.last.status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test('GET /api/social 返回 config、pendingSummaries 与全部 phase', async () => {
  const root = fixture();
  const h = harness(root);
  const result = await h.call('GET', '/api/social');
  assert.equal(result.handled, true);
  assert.equal(result.last.obj.pendingSummaries['group:456'], 2);
  assert.equal(result.last.obj.states['group:456'].phase, 'active');
  assert.equal(result.last.obj.states['group:789'].phase, 'idle', '只有 recentMessages 的会话按 idle 展示');
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/social 清理废弃字段并钳制数值/概率/范围', async () => {
  const root = fixture();
  const h = harness(root);
  const result = await h.call('POST', '/api/social', {
    burstProbability: 0.5,           // 废弃字段：应被删除
    triggerProbability: 5,           // 概率钳到 1
    contextWindow: 999,              // 钳到 100
    burstIntervalMinMs: 5000,
    burstIntervalMaxMs: 1000,        // min>max 自动交换
    activeDurationEnabled: 1         // 布尔化
  });
  assert.equal(result.last.obj.ok, true);
  const cfg = h.cfg.social;
  assert.equal('burstProbability' in cfg, false);
  assert.equal(cfg.triggerProbability, 1);
  assert.equal(cfg.contextWindow, 100);
  assert.deepEqual([cfg.burstIntervalMinMs, cfg.burstIntervalMaxMs], [1000, 5000]);
  assert.equal(cfg.activeDurationEnabled, true);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(file.social.contextWindow, 100);
  fs.rmSync(root, { recursive: true, force: true });
});

test('POST /api/social/flush 透传 key（空 = 全部）', async () => {
  const root = fixture();
  const h = harness(root);
  await h.call('POST', '/api/social/flush', { key: 'group:456' });
  await h.call('POST', '/api/social/flush', {});
  assert.deepEqual(h.flushed, ['group:456', null]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('非本组路由返回 false', async () => {
  const root = fixture();
  const h = harness(root);
  assert.equal((await h.call('GET', '/api/status')).handled, false);
  fs.rmSync(root, { recursive: true, force: true });
});
